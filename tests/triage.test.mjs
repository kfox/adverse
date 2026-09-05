// Tests for the Skill's round-1 triage bridge.
//
// triage.mjs is the deterministic layer the panel trusts most: it decides
// which claims are already dead, which are under-anchored, and which pairs of
// findings are candidates for one root cause. None of that involves a model,
// so all of it is testable — and worth testing, because a wrong answer here is
// invisible downstream. It runs as a subprocess against a real throwaway git
// repo, since half its answers come from `git diff`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const TRIAGE = path.join(here, '..', 'skills', 'adverse-review', 'scripts', 'triage.mjs');

// Fixture repos must not inherit the developer's global git config: signing,
// commit templates, and hooks all leak in and fail in ways that have nothing to
// do with the code under test.
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };

function git(cwd, ...args) {
  execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: 'pipe', env: GIT_ENV });
}

// A repo with one commit on `base` and one changed file on HEAD, so the
// in-diff / outside-diff distinction has something real to answer against.
function makeRepo() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'adverse-triage-'));
  git(dir, 'init', '-q', '-b', 'base');
  git(dir, 'config', 'user.email', 'test@example.invalid');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'config', 'tag.gpgSign', 'false');
  mkdirSync(path.join(dir, 'docs'), { recursive: true });
  writeFileSync(path.join(dir, 'app.py'), Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n') + '\n');
  writeFileSync(path.join(dir, 'docs', 'app.md'), 'app returns a list\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'base');

  git(dir, 'checkout', '-q', '-b', 'work');
  const lines = readFileSync(path.join(dir, 'app.py'), 'utf-8').split('\n');
  lines[19] = 'line 20 CHANGED';
  writeFileSync(path.join(dir, 'app.py'), lines.join('\n'));
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'work');
  return dir;
}

function runTriage(dir, reviews) {
  const files = reviews.map((r, i) => {
    const p = path.join(dir, `round1-${i}.json`);
    writeFileSync(p, JSON.stringify(r), 'utf-8');
    return p;
  });
  const out = path.join(dir, 'briefing.json');
  const args = [TRIAGE];
  for (const f of files) args.push('--round1', f);
  args.push('--repo', dir, '--base', 'base', '--out', out);
  const stdout = execFileSync(process.execPath, args, { encoding: 'utf-8' });
  return { briefing: JSON.parse(readFileSync(out, 'utf-8')), stdout };
}

const review = (persona, findings) => ({ persona, verdict: 'conditional', summary: '', findings });
const finding = (over = {}) => ({
  severity: 'warning', kind: 'defect', file: 'app.py', line: 20,
  counterpart: null, title: 't', detail: 'd', fix: null, ...over,
});

let repo;
test.before(() => { repo = makeRepo(); });
test.after(() => rmSync(repo, { recursive: true, force: true }));

test('a line inside the diff is marked inside, and its text is captured', () => {
  const { briefing } = runTriage(repo, [review('auditor', [finding()])]);
  const f = briefing.findings[0];
  assert.equal(f.claimCheck.status, 'ok');
  assert.equal(f.claimCheck.inDiff, 'inside');
  assert.equal(f.claimCheck.citedLine, 'line 20 CHANGED');
});

test('a line outside the diff is annotated, never disproved', () => {
  const { briefing } = runTriage(repo, [review('auditor', [finding({ line: 3 })])]);
  const f = briefing.findings[0];
  assert.equal(f.claimCheck.status, 'ok');
  assert.equal(f.claimCheck.inDiff, 'outside');
  assert.match(f.claimCheck.note, /legitimate/);
});

test('a missing file and a line past EOF are both disproved', () => {
  const { briefing } = runTriage(repo, [review('auditor', [
    finding({ file: 'nope.py' }),
    finding({ line: 9999 }),
  ])]);
  assert.equal(briefing.findings[0].claimCheck.status, 'DISPROVED');
  assert.equal(briefing.findings[1].claimCheck.status, 'DISPROVED');
});

test('kindCheck: a defect with no line is under-anchored', () => {
  const { briefing } = runTriage(repo, [review('auditor', [finding({ line: null })])]);
  const kc = briefing.findings[0].kindCheck;
  assert.equal(kc.status, 'UNDER-ANCHORED');
  assert.deepEqual(kc.missing, ['line']);
});

test('kindCheck: a contract finding with no counterpart is under-anchored', () => {
  const { briefing } = runTriage(repo, [review('auditor', [finding({ kind: 'contract' })])]);
  assert.deepEqual(briefing.findings[0].kindCheck.missing, ['counterpart']);
});

test('kindCheck: a contract finding naming both paths passes', () => {
  const { briefing } = runTriage(repo, [review('auditor', [
    finding({ kind: 'contract', counterpart: 'docs/app.md' }),
  ])]);
  assert.equal(briefing.findings[0].kindCheck.status, 'ok');
  assert.equal(briefing.findings[0].counterpartCheck.status, 'ok');
});

test('a counterpart that does not exist disproves the contradiction', () => {
  const { briefing, stdout } = runTriage(repo, [review('auditor', [
    finding({ kind: 'contract', counterpart: 'docs/ghost.md' }),
  ])]);
  assert.equal(briefing.findings[0].counterpartCheck.status, 'DISPROVED');
  assert.match(stdout, /claim-check disproved: 1/);
});

test('kindCheck: design needs no anchor and is flagged advisory', () => {
  const { briefing, stdout } = runTriage(repo, [review('pragmatist', [
    finding({ kind: 'design', file: null, line: null }),
  ])]);
  assert.equal(briefing.findings[0].kindCheck.status, 'ok');
  assert.equal(briefing.findings[0].kindCheck.advisory, true);
  assert.match(stdout, /advisory \(design — cannot block\): 1/);
});

test('kindCheck: a missing kind is reported, not silently accepted', () => {
  const f = finding();
  delete f.kind;
  const { briefing } = runTriage(repo, [review('auditor', [f])]);
  assert.equal(briefing.findings[0].kindCheck.status, 'MISSING');
});

test('kindCheck: an unrecognized kind is reported as unknown', () => {
  const { briefing } = runTriage(repo, [review('auditor', [finding({ kind: 'vibes' })])]);
  assert.equal(briefing.findings[0].kindCheck.status, 'UNKNOWN');
});

test('ids are assigned across reviewers in order', () => {
  const { briefing } = runTriage(repo, [
    review('auditor', [finding({ title: 'a' })]),
    review('adversary', [finding({ title: 'b' })]),
  ]);
  assert.deepEqual(briefing.findings.map((f) => f.id), ['F1', 'F2']);
});

test('two reporters near the same line cluster; one reporter does not', () => {
  const two = runTriage(repo, [
    review('auditor', [finding({ title: 'a', line: 20 })]),
    review('adversary', [finding({ title: 'b', line: 25 })]),
  ]).briefing;
  assert.equal(two.clusters.length, 1);
  assert.deepEqual(two.clusters[0].ids, ['F1', 'F2']);

  const one = runTriage(repo, [
    review('auditor', [finding({ title: 'a', line: 20 }), finding({ title: 'b', line: 25 })]),
  ]).briefing;
  assert.equal(one.clusters.length, 0, 'one reporter twice is not consensus');
});

test('findings far apart in the same file do not cluster', () => {
  const { briefing } = runTriage(repo, [
    review('auditor', [finding({ title: 'a', line: 2 })]),
    review('adversary', [finding({ title: 'b', line: 38 })]),
  ]);
  assert.equal(briefing.clusters.length, 0);
});

test('one finding citing another reporter\'s file is a cross-reference', () => {
  const { briefing } = runTriage(repo, [
    review('auditor', [finding({ title: 'a', file: 'app.py', line: 20 })]),
    review('steward', [finding({ title: 'b', file: 'docs/app.md', line: 1,
      detail: 'app.py line 20 disagrees with this' })]),
  ]);
  const xref = briefing.crossReferences.find((x) => x.from === 'F2' && x.to === 'F1');
  assert.ok(xref, 'expected F2 -> F1 co-citation');
  assert.equal(xref.lineEchoed, true);
});

test('a reviewer citing its own file is not a cross-reference', () => {
  const { briefing } = runTriage(repo, [
    review('auditor', [
      finding({ title: 'a', file: 'app.py' }),
      finding({ title: 'b', file: 'app.py', detail: 'see app.py' }),
    ]),
  ]);
  assert.equal(briefing.crossReferences.length, 0);
});

test('the gate summary is carried into the briefing verbatim', () => {
  const p = path.join(repo, 'r.json');
  writeFileSync(p, JSON.stringify(review('auditor', [])), 'utf-8');
  const out = path.join(repo, 'b.json');
  execFileSync(process.execPath, [TRIAGE, '--round1', p, '--repo', repo,
    '--base', 'base', '--gate', 'make test: green', '--out', out], { encoding: 'utf-8' });
  assert.equal(JSON.parse(readFileSync(out, 'utf-8')).gate, 'make test: green');
});

// --- the ledger ---------------------------------------------------------------

function runTriageWithLedger(dir, reviews, ledger) {
  const lp = path.join(dir, 'ledger.json');
  writeFileSync(lp, JSON.stringify(ledger), 'utf-8');
  const files = reviews.map((r, i) => {
    const p = path.join(dir, `lr1-${i}.json`);
    writeFileSync(p, JSON.stringify(r), 'utf-8');
    return p;
  });
  const out = path.join(dir, 'lbriefing.json');
  const args = [TRIAGE];
  for (const f of files) args.push('--round1', f);
  args.push('--repo', dir, '--base', 'base', '--ledger', lp, '--out', out);
  const stdout = execFileSync(process.execPath, args, { encoding: 'utf-8' });
  return { briefing: JSON.parse(readFileSync(out, 'utf-8')), stdout };
}

const ledgerEntry = (over = {}) => ({
  id: 'F1', title: 't', kind: 'defect', severity: 'warning',
  file: 'app.py', line: 20, counterpart: null, citedLine: 'line 20 CHANGED',
  disposition: 'declined', reason: 'intentional', iteration: 1, atCommit: 'HEAD', ...over,
});

test('a settled finding is marked in the briefing and counted as settled', () => {
  const { briefing, stdout } = runTriageWithLedger(repo, [review('auditor', [finding()])], {
    version: 1, base: null, iterations: [{ n: 1 }], entries: [ledgerEntry()],
  });
  const f = briefing.findings[0];
  assert.equal(f.adjudicated.settled, true);
  assert.equal(f.adjudicated.reason, 'intentional');
  assert.deepEqual(briefing.settled, ['F1']);
  assert.deepEqual(briefing.regressed, []);
  assert.match(stdout, /already settled in an earlier iteration: 1/);
});

test('a finding recorded fixed that comes back is flagged regressed, not settled', () => {
  const { briefing, stdout } = runTriageWithLedger(repo, [review('auditor', [finding()])], {
    version: 1, base: null, iterations: [{ n: 1 }], entries: [ledgerEntry({ disposition: 'fixed' })],
  });
  assert.equal(briefing.findings[0].adjudicated.settled, false);
  assert.deepEqual(briefing.regressed, ['F1']);
  assert.deepEqual(briefing.settled, []);
  assert.match(stdout, /REGRESSED \(recorded fixed, reported again\): 1/);
});

test('with no ledger, nothing is adjudicated', () => {
  const { briefing } = runTriage(repo, [review('auditor', [finding()])]);
  assert.equal(briefing.findings[0].adjudicated, undefined);
  assert.deepEqual(briefing.settled, []);
});

test('a ledger from a future version fails the run rather than being ignored', () => {
  assert.throws(() => runTriageWithLedger(repo, [review('auditor', [finding()])],
    { version: 99, entries: [] }), /status 1|Command failed/);
});

// --- the invocation the documentation actually tells you to type -------------
// F12 happened because SKILL.md documented `--round1 run/round1-*.json` while
// every test built args with a repeated `--round1` flag. The documented form
// and the tested form were different, so the break was invisible: the shell
// expands the glob, the extra paths arrive as positionals, and strict parseArgs
// aborts. Reverting `allowPositionals` must fail a test, not pass 263 of them.

test('round-1 paths given as positionals are read, like the documented glob', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'adverse-glob-'));
  const files = [
    review('auditor', [finding({ title: 'a' })]),
    review('adversary', [finding({ title: 'b' })]),
    review('steward', [finding({ title: 'c', kind: 'contract', counterpart: 'docs/app.md' })]),
  ].map((r, i) => {
    const p = path.join(dir, `round1-${i}.json`);
    writeFileSync(p, JSON.stringify(r), 'utf-8');
    return p;
  });
  const out = path.join(dir, 'briefing.json');

  // Exactly what `--round1 "$RUN"/round1-*.json` becomes after the shell:
  // one flag, then bare paths.
  const args = [TRIAGE, '--round1', files[0], files[1], files[2],
                '--repo', repo, '--base', 'base', '--out', out];
  execFileSync(process.execPath, args, { encoding: 'utf-8' });

  const briefing = JSON.parse(readFileSync(out, 'utf-8'));
  assert.equal(briefing.findings.length, 3, 'every globbed file must be read, not just the first');
  assert.deepEqual(briefing.findings.map((f) => f.reporter), ['auditor', 'adversary', 'steward']);
});

test('a path escaping the checkout is disproved, not read', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'adverse-escape-'));
  const secret = path.join(dir, 'secret.txt');
  writeFileSync(secret, 'SENTINEL-DO-NOT-EXFILTRATE\n', 'utf-8');

  const rel = path.relative(repo, secret);
  const { briefing } = runTriage(repo, [review('auditor', [finding({ file: rel, line: 1 })])]);
  assert.equal(briefing.findings[0].claimCheck.status, 'DISPROVED');
  assert.match(briefing.findings[0].claimCheck.why, /escapes the checkout/);
  assert.ok(!JSON.stringify(briefing).includes('SENTINEL'), 'no out-of-tree content may reach the briefing');
});

test('an in-tree symlink pointing out of the tree is disproved, not followed', () => {
  // path.resolve normalizes `..` but knows nothing about symlinks, while
  // statSync and readFileSync both follow them — so a symlink committed inside
  // the checkout (git stores mode 120000) kept the path under the repo prefix
  // while the read landed wherever it pointed.
  const outside = mkdtempSync(path.join(os.tmpdir(), 'adverse-outside-'));
  const secret = path.join(outside, 'id_rsa');
  writeFileSync(secret, 'line one\nSSH-SENTINEL-DO-NOT-EXFILTRATE\n', 'utf-8');

  const link = path.join(repo, 'docs_link');
  try {
    symlinkSync(secret, link);
  } catch {
    return; // no symlink support; nothing to assert
  }

  const { briefing } = runTriage(repo, [review('auditor', [
    finding({ file: 'docs_link', line: 2, kind: 'contract', counterpart: 'docs/app.md' }),
  ])]);
  unlinkSync(link);

  assert.equal(briefing.findings[0].claimCheck.status, 'DISPROVED');
  assert.ok(!JSON.stringify(briefing).includes('SSH-SENTINEL'),
    'the symlink target must never reach the briefing, which becomes the round-2 prompt');
});

test('a counterpart that is an in-tree symlink pointing out of the tree is disproved', () => {
  // checkCounterpart answers the same "is this really a file in the checkout"
  // question as claimCheck, for the second path a `contract` finding names —
  // it must reject an escaping symlink exactly the same way.
  const outside = mkdtempSync(path.join(os.tmpdir(), 'adverse-outside-'));
  const secret = path.join(outside, 'id_rsa');
  writeFileSync(secret, 'SSH-SENTINEL-DO-NOT-EXFILTRATE\n', 'utf-8');

  const link = path.join(repo, 'counterpart_link');
  try {
    symlinkSync(secret, link);
  } catch {
    return; // no symlink support; nothing to assert
  }

  const { briefing } = runTriage(repo, [review('auditor', [
    finding({ kind: 'contract', counterpart: 'counterpart_link' }),
  ])]);
  unlinkSync(link);

  assert.equal(briefing.findings[0].counterpartCheck.status, 'DISPROVED');
  assert.ok(!JSON.stringify(briefing).includes('SSH-SENTINEL'),
    'the symlink target must never reach the briefing, which becomes the round-2 prompt');
});

test('a ledger that does not belong to this repository is refused', () => {
  // triage.mjs writes briefing.json, which IS the round-2 prompt, so a foreign
  // ledger accepted here marks findings settled with "Do not re-open it" in
  // front of every reviewer. converge.mjs's copy of this guard is tested;
  // this one was added by the same fix and was not.
  const dir = mkdtempSync(path.join(os.tmpdir(), 'adverse-foreign-'));
  const ledger = path.join(dir, 'l.json');
  writeFileSync(ledger, JSON.stringify({
    version: 1, base: 'some-other-repo-entirely', iterations: [],
    entries: [{ id: 'X', title: 't', kind: 'defect', file: 'app.py', line: 20,
                disposition: 'declined', reason: 'trust me',
                atCommit: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' }],
  }));

  const round1 = path.join(dir, 'round1-0.json');
  writeFileSync(round1, JSON.stringify(review('auditor', [finding()])));
  const r = spawnSync(process.execPath, [TRIAGE, '--round1', round1, '--repo', repo,
                                         '--base', 'base', '--ledger', ledger,
                                         '--out', path.join(dir, 'b.json')],
                      { encoding: 'utf-8' });
  assert.equal(r.status, 1, 'a foreign ledger must be refused, not adjudicated from');
  assert.match(r.stderr, /does not belong to this repository/);
});

test('a ledger entry with no atCommit is refused', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'adverse-unanchored-'));
  const ledger = path.join(dir, 'l.json');
  writeFileSync(ledger, JSON.stringify({
    version: 1, iterations: [],
    entries: [{ id: 'X', title: 't', kind: 'defect', file: 'app.py', line: 20,
                disposition: 'declined', reason: 'trust me' }],
  }));
  const round1 = path.join(dir, 'round1-0.json');
  writeFileSync(round1, JSON.stringify(review('auditor', [finding()])));
  const r = spawnSync(process.execPath, [TRIAGE, '--round1', round1, '--repo', repo,
                                         '--base', 'base', '--ledger', ledger,
                                         '--out', path.join(dir, 'b.json')],
                      { encoding: 'utf-8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /carries no atCommit/);
});

test('a split lane\'s two payloads merge in briefing.verdicts — worse verdict, both summaries', () => {
  const { briefing } = runTriage(repo, [
    { persona: 'auditor', verdict: 'approve', summary: 'half A', findings: [] },
    { persona: 'auditor', verdict: 'reject', summary: 'half B', findings: [] },
  ]);
  assert.equal(briefing.verdicts.auditor.verdict, 'reject');
  assert.match(briefing.verdicts.auditor.summary, /half A/);
  assert.match(briefing.verdicts.auditor.summary, /half B/);
});

test('the merged verdict does not depend on which half the shell globbed first', () => {
  const { briefing } = runTriage(repo, [
    { persona: 'auditor', verdict: 'reject', summary: 'half B', findings: [] },
    { persona: 'auditor', verdict: 'approve', summary: 'half A', findings: [] },
  ]);
  assert.equal(briefing.verdicts.auditor.verdict, 'reject');
});

test('an unsplit lane\'s off-contract verdict is normalized in the briefing too', () => {
  const { briefing } = runTriage(repo, [
    { persona: 'auditor', verdict: 'REJECT', summary: 's', findings: [] },
  ]);
  assert.equal(briefing.verdicts.auditor.verdict, 'reject');
});

test('a persona outside the registry is refused before it can key the briefing', () => {
  const p = path.join(repo, 'round1-phantom.json');
  writeFileSync(p, JSON.stringify({ persona: 'Auditor', verdict: 'approve', summary: 's', findings: [] }));
  const out = path.join(repo, 'briefing-phantom.json');
  const r = spawnSync(process.execPath,
    [TRIAGE, '--round1', p, '--repo', repo, '--base', 'base', '--out', out],
    { encoding: 'utf-8', timeout: 30_000 });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unknown persona/);
});

test('a --base that looks like a git option is refused', () => {
  const p = path.join(repo, 'round1-ok.json');
  writeFileSync(p, JSON.stringify({ persona: 'auditor', verdict: 'approve', summary: 's', findings: [] }));
  const out = path.join(repo, 'briefing-x.json');
  const r = spawnSync(process.execPath,
    [TRIAGE, '--round1', p, '--repo', repo, '--base=--output=/tmp/x', '--out', out],
    { encoding: 'utf-8', timeout: 30_000 });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /looks like an option/);
});
