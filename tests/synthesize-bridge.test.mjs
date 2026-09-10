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

function planFile(dir, depth, { probes, name = 'plan.json' } = {}) {
  const p = path.join(dir, name);
  const plan = {
    lanes: [
      { persona: 'auditor', run: true, agents: 1 },
      { persona: 'steward', run: true, agents: 1 },
    ],
  };
  if (depth !== undefined) plan.depth = depth;
  if (probes !== undefined) plan.probes = probes;
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

// The declaration this whole path exists for, end to end. SKILL.md skips Phase
// 2.5 outright when probes are off, so there is no probes.json and no
// `--probes` — the plan is the only thing on disk that can say probes were not
// offered, and before this the report said nothing at all.
test('--plan alone declares that probes were never offered', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'adverse-synth-probesoff-'));
  try {
    const md = path.join(dir, 'r.md');
    const json = path.join(dir, 'r.json');
    const plan = planFile(dir, 'cheap', {
      probes: { allowed: false, perLane: 0, reason: 'a cheap pass; a reproduction costs wall-clock' },
    });
    const r = runSynth(['--round1', round1File(dir), '--plan', plan,
      '--out', md, '--json-out', json]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(readFileSync(md, 'utf-8'), /\*\*Probes were not offered\.\*\*/);
    assert.match(readFileSync(md, 'utf-8'), /a cheap pass; a reproduction costs wall-clock\./);

    const report = JSON.parse(readFileSync(json, 'utf-8'));
    assert.equal(report.probes.offered, false);
    // Not zero. Nothing counted them, and a count is a claim that something did.
    assert.equal(report.probes.enabled, null);
    assert.equal(report.probes.attached, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a plan that offered probes, with no probes.json, says the record is missing', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'adverse-synth-probesnone-'));
  try {
    const md = path.join(dir, 'r.md');
    const plan = planFile(dir, undefined, { probes: { allowed: true, perLane: 2, reason: 'offered' } });
    assert.equal(runSynth(['--round1', round1File(dir), '--plan', plan, '--out', md]).status, 0);
    const body = readFileSync(md, 'utf-8');
    assert.match(body, /No probe was recorded/);
    assert.doesNotMatch(body, /were not offered/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--probes and --plan together declare what execution actually did', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'adverse-synth-probesran-'));
  try {
    const md = path.join(dir, 'r.md');
    const json = path.join(dir, 'r.json');
    const plan = planFile(dir, undefined, { probes: { allowed: true, perLane: 2, reason: 'offered' } });
    // The probed payload is the auditor's alone, so the steward the plan ran
    // has to be accounted for — the roster check (#70) is the same class of
    // declaration this test is about, one lane down.
    const r = runSynth(['--round1', probedRound1(dir), '--briefing', briefingFile(dir, HEAD),
      '--plan', plan, '--probes', probesFile(dir, HEAD),
      '--skipped', 'steward=nothing in the diff it owns',
      '--out', md, '--json-out', json]);
    // 1, not 0: the probed finding is a live critical, and the bridge's exit
    // code is a claim about the review rather than about this declaration.
    assert.equal(r.status, 1, `${r.stderr}${r.stdout}`);
    assert.match(readFileSync(md, 'utf-8'), /\*\*Probes ran\.\*\* 1 attached, 1 re-run, 1 reproduced/);

    const report = JSON.parse(readFileSync(json, 'utf-8'));
    assert.deepEqual({
      offered: report.probes.offered, enabled: report.probes.enabled,
      attached: report.probes.attached, confirmed: report.probes.confirmed,
    }, { offered: true, enabled: true, attached: 1, confirmed: 1 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A run with neither input recorded nothing about probes, and the report says
// nothing rather than guessing — `depth: null`'s rule, for the same reason.
test('no plan and no probes.json declares nothing and carries null', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'adverse-synth-probesnull-'));
  try {
    const md = path.join(dir, 'r.md');
    const json = path.join(dir, 'r.json');
    assert.equal(runSynth(['--round1', round1File(dir), '--out', md, '--json-out', json]).status, 0);
    assert.doesNotMatch(readFileSync(md, 'utf-8'), /probe/i);
    assert.equal(JSON.parse(readFileSync(json, 'utf-8')).probes, null);
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

// --- --probes, and the head it is bound to ------------------------------------
//
// `confirmed` is the strongest claim this report makes, and Phase 9 loops back
// through the same run directory — so a probes.json an earlier iteration left
// there describes a tree that has since moved. The binding is made against the
// head the BRIEFING recorded, because this process never opens the repository.

const PROBED_TITLE = 'mean returns NaN on an empty list';
const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

function probedRound1(dir) {
  const p = path.join(dir, 'round1.json');
  writeFileSync(p, JSON.stringify({
    auditor: {
      persona: 'auditor',
      verdict: 'reject',
      summary: 's',
      findings: [{
        severity: 'critical', kind: 'behavioral', file: 'lib.mjs', line: 2,
        counterpart: null, title: PROBED_TITLE, detail: 'd', fix: null,
      }],
    },
  }));
  return p;
}

function probesFile(dir, head) {
  const p = path.join(dir, 'probes.json');
  writeFileSync(p, JSON.stringify({
    enabled: true,
    head,
    isolation: { sandbox: null },
    probes: [{
      persona: 'auditor', agent: 'auditor', title: PROBED_TITLE,
      claim: { script: 'p.sh', expect: 'e', observed: 'o', outcome: 'reproduced' },
      source: 'measured', status: 'reproduced',
      ran: { exitCode: 0, durationMs: 1, output: 'saw it', failure: null },
      confirmed: true, why: '',
    }],
  }));
  return p;
}

// A group citation's reporter reaches every artifact the run leaves behind:
// both renderers print it verbatim and the PR comment counts it. It arrives
// out of a file nothing had checked past `Array.isArray(groups)`, so a value
// that is not a lane name rendered as `[object Object]` in report.md and the
// dashboard, and suppressed the PR comment outright. Refused here, where the
// file that carries it can be named, before any of the three is written.
for (const [label, citation] of [
  ['a reporter that is not a lane name', { id: 'F1', title: 't', reporter: 42 }],
  // The value the lane-list vocabulary exists for: `"auditor"` is iterable,
  // so a reader that spread it published seven reviewers.
  ['a reporters that is a string', { id: 'F1', title: 't', reporters: 'auditor' }],
  ['a reporters holding something that is not a lane name',
    { id: 'F1', title: 't', reporters: ['auditor', 7] }],
]) test(`a briefing citation with ${label} is refused, naming the file`, () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'adverse-cite-'));
  const briefing = path.join(dir, 'briefing.json');
  writeFileSync(briefing, JSON.stringify({ base: 'main', head: HEAD, findings: [],
    groups: [{ id: 'G1', title: 'one thing', anchor: 'F1', citations: [citation] }] }));

  const r = runSynth(['--round1', round1File(dir), '--briefing', briefing,
    '--out', path.join(dir, 'report.md')]);

  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /`groups\[0\]\.citations\[0\]` claims a reporter that is not a lane name/);
  assert.match(r.stderr, new RegExp(briefing.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  rmSync(dir, { recursive: true, force: true });
});

// And the shape that is not a claim at all. A citation with no reporter is
// what triage writes for a finding synthesis did not build, and refusing it
// would refuse the tool's own output.
test('a briefing citation claiming no reporter is not refused', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'adverse-cite-'));
  const briefing = path.join(dir, 'briefing.json');
  writeFileSync(briefing, JSON.stringify({ base: 'main', head: HEAD, findings: [],
    groups: [{ id: 'G1', title: 'one thing', anchor: 'F1',
               citations: [{ id: 'F1', title: 't' }] }] }));

  const r = runSynth(['--round1', round1File(dir), '--briefing', briefing,
    '--out', path.join(dir, 'report.md')]);

  assert.equal(r.status, 0, r.stderr);
  rmSync(dir, { recursive: true, force: true });
});

function briefingFile(dir, head) {
  const p = path.join(dir, 'briefing.json');
  writeFileSync(p, JSON.stringify({ base: 'main', head, groups: [], findings: [] }));
  return p;
}

// The briefing is the only thing that knows which tree was reviewed, and the
// report is the artifact that outlives the run directory and the branch
// position. Nothing asserted the wiring between them until a mutation that
// dropped `head` on the floor survived the whole suite — so a report that had
// stopped naming the commit it reviewed would have been silent.
test('--briefing carries the reviewed head and base into all three renderings', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'adverse-head-'));
  const jsonOut = path.join(dir, 'report.json');
  const mdOut = path.join(dir, 'report.md');
  const htmlOut = path.join(dir, 'report.html');
  const r = runSynth(['--round1', round1File(dir), '--briefing', briefingFile(dir, HEAD),
    '--out', mdOut, '--json-out', jsonOut, '--html-out', htmlOut]);
  assert.equal(r.status, 0, r.stderr);

  const report = JSON.parse(readFileSync(jsonOut, 'utf-8'));
  assert.equal(report.head, HEAD);
  assert.equal(report.base, 'main');
  assert.match(readFileSync(mdOut, 'utf-8'), new RegExp(`Reviewed:.*${HEAD.slice(0, 12)}`));
  assert.match(readFileSync(htmlOut, 'utf-8'), new RegExp(`Reviewed:.*${HEAD.slice(0, 12)}`));
  rmSync(dir, { recursive: true, force: true });
});

// Without a briefing there is nothing that knows the tree, and inventing one
// from this process's own HEAD would date the review to a commit it never
// read. The field is absent rather than guessed.
test('with no briefing the report names no commit rather than guessing one', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'adverse-nohead-'));
  const jsonOut = path.join(dir, 'report.json');
  const mdOut = path.join(dir, 'report.md');
  const r = runSynth(['--round1', round1File(dir), '--out', mdOut, '--json-out', jsonOut]);
  assert.equal(r.status, 0, r.stderr);

  const report = JSON.parse(readFileSync(jsonOut, 'utf-8'));
  assert.equal(report.head, null);
  assert.equal(report.base, null);
  assert.doesNotMatch(readFileSync(mdOut, 'utf-8'), /Reviewed:/);
  rmSync(dir, { recursive: true, force: true });
});

const confidenceOf = (jsonOut) =>
  JSON.parse(readFileSync(jsonOut, 'utf-8')).findings[0].confidence;

test('a probe bound to the reviewed head makes its finding demonstrated', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'adverse-probes-'));
  const jsonOut = path.join(dir, 'report.json');
  const r = runSynth(['--round1', probedRound1(dir),
    '--briefing', briefingFile(dir, HEAD), '--probes', probesFile(dir, HEAD),
    '--out', path.join(dir, 'report.md'), '--json-out', jsonOut]);

  assert.equal(r.status, 1, r.stderr);   // a live critical: the reject exit
  assert.equal(confidenceOf(jsonOut), 'demonstrated');
  rmSync(dir, { recursive: true, force: true });
});

test('a probe from a run against a different tree confirms nothing', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'adverse-probes-stale-'));
  const jsonOut = path.join(dir, 'report.json');
  runSynth(['--round1', probedRound1(dir),
    '--briefing', briefingFile(dir, OTHER), '--probes', probesFile(dir, HEAD),
    '--out', path.join(dir, 'report.md'), '--json-out', jsonOut]);

  assert.equal(confidenceOf(jsonOut), 'solo');
  const probe = JSON.parse(readFileSync(jsonOut, 'utf-8')).findings[0].probe;
  assert.equal(probe.confirmed, false);
  assert.match(probe.why, /not the tree under review/);
  rmSync(dir, { recursive: true, force: true });
});

// Without a briefing there is no head to bind to, and this is the standalone
// path, where nothing loops. Taking the file as given is the honest answer;
// inventing a binding would refuse a run that is not at risk.
test('with no briefing the probes file is taken as given', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'adverse-probes-nobrief-'));
  const jsonOut = path.join(dir, 'report.json');
  runSynth(['--round1', probedRound1(dir), '--probes', probesFile(dir, HEAD),
    '--out', path.join(dir, 'report.md'), '--json-out', jsonOut]);

  assert.equal(confidenceOf(jsonOut), 'demonstrated');
  rmSync(dir, { recursive: true, force: true });
});

test('a run with no --probes leaves every finding where it was', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'adverse-probes-none-'));
  const jsonOut = path.join(dir, 'report.json');
  runSynth(['--round1', probedRound1(dir), '--out', path.join(dir, 'report.md'),
    '--json-out', jsonOut]);

  assert.equal(confidenceOf(jsonOut), 'solo');
  assert.equal(JSON.parse(readFileSync(jsonOut, 'utf-8')).findings[0].probe, null);
  rmSync(dir, { recursive: true, force: true });
});

test('an unreadable --probes file is exit 2 — this run never read an input', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'adverse-probes-gone-'));
  const r = runSynth(['--round1', probedRound1(dir), '--probes', path.join(dir, 'gone.json'),
    '--out', path.join(dir, 'report.md')]);
  assert.equal(r.status, 2);
  rmSync(dir, { recursive: true, force: true });
});
