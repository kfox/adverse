// Tests for skills/adverse-review/scripts/synthesize.mjs — specifically the
// declaration flags whose failure mode is silence: a skipped round 2 that is
// not declared reads exactly like a panel that cross-examined and found
// nothing, and an EMPTY declaration is that same failure with better manners.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const SYNTH = path.join(ROOT, 'skills', 'adverse-review', 'scripts', 'synthesize.mjs');
const BIN = path.join(ROOT, 'bin', 'adverse.mjs');

// See the note in tests/cli.test.mjs: the env goes on the spawn, because a
// developer running this one file directly does not go through `npm test`.
const QUIET = { ...process.env, ADVERSE_NO_TELEMETRY: '1' };

function runSynth(args, cwd = ROOT) {
  return spawnSync('node', [SYNTH, ...args],
    { cwd, encoding: 'utf-8', timeout: 30_000, env: QUIET });
}

function runCli(args) {
  return spawnSync('node', [BIN, ...args],
    { cwd: ROOT, encoding: 'utf-8', timeout: 30_000, env: QUIET });
}

function round1File(dir) {
  const p = path.join(dir, 'round1.json');
  writeFileSync(p, JSON.stringify({
    auditor: { persona: 'auditor', verdict: 'approve', summary: 's', findings: [] },
    steward: { persona: 'steward', verdict: 'approve', summary: 's', findings: [] },
  }));
  return p;
}

test('an unreadable --round1 file is exit 2, not exit 1 — this run could not read a review, it did not judge one', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'adverse-synth-bad-'));
  try {
    const bad = path.join(dir, 'round1-bad.json');
    writeFileSync(bad, '{ not valid json');
    const r = runSynth(['--round1', bad, '--out', path.join(dir, 'r.md')]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /synthesize:.*round1-bad\.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an empty --round2-skipped is a usage error, not a silent undeclared skip', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'adverse-synth-'));
  try {
    const r = runSynth(['--round1', round1File(dir), '--round2-skipped', '',
      '--out', path.join(dir, 'r.md')]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /non-empty reason/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a declared round-2 skip renders in the markdown and the JSON report', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'adverse-synth2-'));
  try {
    const md = path.join(dir, 'r.md');
    const json = path.join(dir, 'r.json');
    const r = runSynth(['--round1', round1File(dir),
      '--round2-skipped', 'no blocking finding in round 1',
      '--out', md, '--json-out', json]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(readFileSync(md, "utf-8"), /Round 2 skipped:\*\* no blocking finding in round 1/);
    assert.equal(JSON.parse(readFileSync(json, 'utf-8')).round2_skipped, 'no blocking finding in round 1');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the bridge and `adverse synthesize` produce byte-identical reports — they are one implementation, not two synced copies', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'adverse-synth-parity-'));
  try {
    const r1 = round1File(dir);
    const args = ['--round1', r1, '--skipped', 'adversary=no trust boundary in the diff',
      '--degraded', 'pragmatist', '--round2-skipped', 'no blocking finding in round 1'];

    const viaBridge = runSynth([...args, '--out', path.join(dir, 'bridge.md'), '--json-out', path.join(dir, 'bridge.json')]);
    const viaCli = runCli(['synthesize', ...args, '--out', path.join(dir, 'cli.md'), '--json-out', path.join(dir, 'cli.json')]);

    assert.equal(viaBridge.status, viaCli.status);
    assert.equal(
      readFileSync(path.join(dir, 'bridge.md'), 'utf-8'),
      readFileSync(path.join(dir, 'cli.md'), 'utf-8'),
    );
    assert.equal(
      readFileSync(path.join(dir, 'bridge.json'), 'utf-8'),
      readFileSync(path.join(dir, 'cli.json'), 'utf-8'),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


// --- the plan-to-report link: depth travels as data, not as memory -------------

function planFile(dir, depth) {
  const p = path.join(dir, 'plan.json');
  const plan = {
    lanes: [
      { persona: 'auditor', run: true, agents: 1 },
      { persona: 'steward', run: true, agents: 1 },
    ],
  };
  if (depth !== undefined) plan.depth = depth;
  writeFileSync(p, JSON.stringify(plan));
  return p;
}

test('--plan carries the run depth into the report header', () => {
  // One channel, not two: the orchestrator already passes --plan for the
  // roster check, and a second --depth flag would be a second claim about one
  // run — the ambiguity triage.mjs refuses for the gate.
  const dir = mkdtempSync(path.join(tmpdir(), 'adverse-synth-depth-'));
  try {
    const out = path.join(dir, 'r.md');
    const r = runSynth(['--round1', round1File(dir), '--plan', planFile(dir, 'cheap'), '--out', out]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(readFileSync(out, 'utf-8'), /Planned depth: `cheap`/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a plan.json with no depth renders no depth claim, and neither does no plan at all', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'adverse-synth-nodepth-'));
  try {
    const withPlan = path.join(dir, 'a.md');
    assert.equal(runSynth(['--round1', round1File(dir), '--plan', planFile(dir), '--out', withPlan]).status, 0);
    assert.doesNotMatch(readFileSync(withPlan, 'utf-8'), /Planned depth/);

    const noPlan = path.join(dir, 'b.md');
    assert.equal(runSynth(['--round1', round1File(dir), '--out', noPlan]).status, 0);
    assert.doesNotMatch(readFileSync(noPlan, 'utf-8'), /Planned depth/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a plan.json naming a depth that is not one refuses the synthesis', () => {
  // Exit rather than default. The report's claim about how much looking
  // happened is only worth making if a depth nobody chose cannot produce one.
  const dir = mkdtempSync(path.join(tmpdir(), 'adverse-synth-baddepth-'));
  try {
    const r = runSynth(['--round1', round1File(dir), '--plan', planFile(dir, 'quick'),
      '--out', path.join(dir, 'r.md')]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /unknown depth "quick"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the roster check still fires when a plan also carries a depth', () => {
  // Reading the plan once for two answers must not lose either of them: the
  // unaccounted-lane refusal is the older and the more load-bearing.
  const dir = mkdtempSync(path.join(tmpdir(), 'adverse-synth-both-'));
  try {
    const p = path.join(dir, 'plan.json');
    writeFileSync(p, JSON.stringify({
      depth: 'thorough',
      lanes: [
        { persona: 'auditor', run: true, agents: 1 },
        { persona: 'steward', run: true, agents: 1 },
        { persona: 'adversary', run: true, agents: 1 },
      ],
    }));
    const r = runSynth(['--round1', round1File(dir), '--plan', p, '--out', path.join(dir, 'r.md')]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /the plan ran adversary/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
