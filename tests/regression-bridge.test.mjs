// Tests for skills/adverse-review/scripts/regression.mjs — the Phase 9
// regression-pass bridge, driven as a subprocess like the other bridge tests.
//
// The bridge's contract, not the lane-selection logic (that is
// tests/regression.test.mjs) and not the payload schema (tests/prompts.test.mjs):
// the reshape into the round-1 shape triage.mjs reads, the provenance stamp the
// report depends on, the derived verdict, and the exit-code contract every
// bridge here shares.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const BRIDGE = path.join(ROOT, 'skills', 'adverse-review', 'scripts', 'regression.mjs');

const run = (args) =>
  spawnSync(process.execPath, [BRIDGE, ...args], { encoding: 'utf-8', timeout: 30_000 });

const freshTmp = () => mkdtempSync(path.join(tmpdir(), 'adverse-regression-'));

const checked = () => [
  { question: 'stricter', against: 'the callers of the tightened validator' },
  { question: 'permissive', against: 'the relaxed signal list' },
  { question: 'hot-path', against: 'the drain loop the warning now sits in' },
  { question: 'shared-state', against: 'the module-scope writes' },
];

const pass = (over = {}) => ({
  persona: 'adversary',
  commit: 'abc1234',
  checked: checked(),
  added: [{
    severity: 'critical', kind: 'behavioral', file: 'src/asid.py', line: 243,
    counterpart: null, title: 'the bounded drain lost its bound',
    detail: 'the new warning path is per-message work inside the bound',
    fix: 'throttle it', classification: 'unintended',
  }],
  ...over,
});

function fold(dir, files) {
  for (const [name, payload] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), JSON.stringify(payload));
  }
  return run(['--payload', ...Object.keys(files).map((n) => path.join(dir, n)),
              '--outdir', dir]);
}

test('a pass reshapes into the round-1 shape triage.mjs reads, stamped', () => {
  const dir = freshTmp();
  try {
    const r = fold(dir, { 'regression-adversary.json': pass() });
    assert.equal(r.status, 0, r.stderr);

    const out = JSON.parse(
      readFileSync(path.join(dir, 'round1-adversary.regression.json'), 'utf-8'));
    assert.equal(out.persona, 'adversary');
    assert.equal(out.verdict, 'conditional', 'a pass that found something is not an approval');
    assert.equal(out.findings.length, 1);
    // The stamp is on the ENTRY, which is what survives mergeSplitReviews.
    assert.equal(out.findings[0].provenance, 'regression');
    assert.equal(out.provenance, 'regression');
    assert.deepEqual(out.passes, [{ commit: 'abc1234', checked: checked() }],
      'what the pass says it checked has to survive the reshape');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a pass that found nothing is an approval, not a rejection', () => {
  const dir = freshTmp();
  try {
    const r = fold(dir, { 'regression-adversary.json': pass({ added: [] }) });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(
      readFileSync(path.join(dir, 'round1-adversary.regression.json'), 'utf-8'));
    assert.equal(out.verdict, 'approve');
    assert.deepEqual(out.findings, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('one lane reading two fix commits produces one lane, not two payloads', () => {
  // The pass is per fix commit, so a lane routinely runs more than one in an
  // iteration. A file per pass would reach triage as a lane claiming three
  // payloads, and checkRoster refuses that — a split lane is exactly two.
  const dir = freshTmp();
  try {
    const r = fold(dir, {
      'regression-adversary-1.json': pass(),
      'regression-adversary-2.json': pass({
        commit: 'def5678',
        added: [{ ...pass().added[0], title: 'the changelog no longer matches the default',
                  kind: 'contract', counterpart: 'CHANGELOG.md', severity: 'warning',
                  classification: 'intended-undocumented' }],
      }),
    });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(
      readFileSync(path.join(dir, 'round1-adversary.regression.json'), 'utf-8'));
    assert.equal(out.findings.length, 2);
    assert.ok(out.findings.every((f) => f.provenance === 'regression'));
    assert.deepEqual(out.passes.map((p) => p.commit), ['abc1234', 'def5678']);
    assert.match(out.summary, /abc1234, def5678/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('two lanes get one file each', () => {
  const dir = freshTmp();
  try {
    const r = fold(dir, {
      'regression-adversary.json': pass(),
      'regression-auditor.json': pass({ persona: 'auditor', added: [] }),
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(readFileSync(
      path.join(dir, 'round1-auditor.regression.json'), 'utf-8')).verdict, 'approve');
    assert.equal(JSON.parse(readFileSync(
      path.join(dir, 'round1-adversary.regression.json'), 'utf-8')).verdict, 'conditional');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a payload that fails the schema is exit 1, and nothing is written', () => {
  const dir = freshTmp();
  try {
    // Three of the four questions answered: the pass is claiming a silence it
    // did not earn, which is the one rule this schema exists to enforce.
    const r = fold(dir, {
      'regression-adversary.json': pass({ checked: checked().slice(0, 3) }),
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /never answers \["shared-state"\]/);
    assert.throws(() => readFileSync(path.join(dir, 'round1-adversary.regression.json')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unknown persona is exit 1 — the payload read fine and failed the domain check', () => {
  const dir = freshTmp();
  try {
    const r = fold(dir, { 'regression-referee.json': pass({ persona: 'referee' }) });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /unknown persona "referee"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unreadable payload is exit 2 — this run never read its input', () => {
  const dir = freshTmp();
  try {
    const r = run(['--payload', path.join(dir, 'nope.json'), '--outdir', dir]);
    assert.equal(r.status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('choosing a lane reads the commit itself and reports its reasoning', () => {
  const r = run(['--repo', ROOT, '--commit', 'HEAD', '--closed-by', 'auditor', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const choice = JSON.parse(r.stdout);
  assert.notEqual(choice.persona, 'auditor', 'the lane that reported it does not review it');
  assert.notEqual(choice.persona, 'pragmatist');
  assert.equal(choice.commit, 'HEAD');
  assert.equal(choice.conflicted, false);
  assert.ok(choice.reason.includes(choice.persona));
});

test('a commit nobody can read still names a lane, loudly', () => {
  // Silence is the failure mode this whole pass exists to remove, so an
  // unreadable commit reports itself and falls toward the Adversary rather than
  // choosing as if the diff were empty.
  const r = run(['--repo', ROOT, '--commit', 'no-such-rev-here', '--json']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /cannot read no-such-rev-here/);
  assert.equal(JSON.parse(r.stdout).persona, 'adversary');
});

test('a revision in git\'s option position is refused before git sees it', () => {
  // The `=` form is the one that reaches the guard: `--commit --output=…` as
  // two arguments is refused by parseArgs itself, the same way it is in
  // triage.mjs and plan.mjs.
  const r = run(['--repo', ROOT, '--commit=--output=/tmp/pwned']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /looks like an option/);
});

test('neither mode selected is a usage error', () => {
  const r = run(['--repo', ROOT]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Usage: regression\.mjs/);
});
