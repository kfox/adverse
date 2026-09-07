// Tests for src/telemetry.mjs — the one line per run that lets the scaling
// policy be argued from many runs instead of from one remembered incident.
//
// Two properties carry the weight. The record must never carry prose, because
// the file is meant to be pasteable into an issue about a threshold; and a
// telemetry failure must never fail a run, because this is an observation OF a
// review rather than a claim about one.
//
// Every spawn below sets ADVERSE_TELEMETRY_FILE at a throwaway path and clears
// ADVERSE_NO_TELEMETRY, which `npm test` sets for the whole suite so that a
// test which forgets cannot append to the developer's real file.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'adverse.mjs');
const srcUrl = (name) => pathToFileURL(path.join(ROOT, 'src', name)).href;

const { synthesize } = await import(srcUrl('synthesis.mjs'));
const {
  LANE_STATUS, TELEMETRY_SCHEMA, appendRunRecord, buildRunRecord, repoFromRemote,
  telemetryDisabled, telemetryPath,
} = await import(srcUrl('telemetry.mjs'));

const freshTmp = () => mkdtempSync(path.join(tmpdir(), 'adverse-telemetry-'));

function finding(over = {}) {
  return {
    severity: 'critical', kind: 'defect', file: 'src/x.mjs', line: 3,
    title: 'a finding', detail: 'because of a thing', fix: 'do the other thing', ...over,
  };
}

const review = (persona, findings, over = {}) =>
  ({ persona, verdict: 'conditional', summary: 'a summary', findings, ...over });

// ---------------------------------------------------------------- the record

test('the record counts findings along every axis the policy asks about', () => {
  const round1 = {
    auditor: review('auditor', [finding(), finding({ severity: 'warning', title: 'second' })]),
    steward: review('steward', [finding({ kind: 'contract', title: 'third', counterpart: 'a.md' })]),
  };
  const record = buildRunRecord({ syn: synthesize(round1), round1 });

  assert.equal(record.schema, TELEMETRY_SCHEMA);
  assert.equal(record.findings.total, 3);
  // Spread, because the tallies have a null prototype on purpose — see
  // `countBy`, and SEVERITY_RANK in src/taxonomy.mjs for the incident.
  assert.deepEqual({ ...record.findings.bySeverity }, { critical: 2, warning: 1 });
  assert.deepEqual({ ...record.findings.byKind }, { defect: 2, contract: 1 });
  assert.equal(record.findings.byKind.design ?? 0, 0);
  assert.deepEqual(record.roster.reported, ['auditor', 'steward']);
  assert.equal(record.lanes.auditor.reported, 2);
  assert.equal(record.lanes.steward.status, LANE_STATUS.reported);
});

test('a lane that did not look records null, not zero', () => {
  // The distinction this whole codebase is built around, in the one file that
  // will be read months later by someone counting. A skipped lane with
  // `reported: 0` is indistinguishable from a lane that reviewed and was happy.
  const round1 = { auditor: review('auditor', []), steward: review('steward', []) };
  const record = buildRunRecord({
    syn: synthesize(round1, {}, {
      failedPersonas: ['adversary'],
      skippedPersonas: [{ persona: 'pragmatist', reason: 'small diff' }],
    }),
    round1,
    plan: {
      lanes: [{ persona: 'auditor', run: true, agents: 1 },
        { persona: 'adversary', run: true, agents: 1 },
        { persona: 'steward', run: true, agents: 1 },
        { persona: 'pragmatist', run: false, agents: 0 }],
    },
  });

  assert.equal(record.lanes.auditor.reported, 0, 'it looked and found nothing');
  assert.equal(record.lanes.adversary.reported, null, 'it did not look');
  assert.equal(record.lanes.adversary.status, LANE_STATUS.degraded);
  assert.equal(record.lanes.pragmatist.status, LANE_STATUS.skipped);
  assert.deepEqual(record.plan.agents,
    { auditor: 1, adversary: 1, steward: 1, pragmatist: 0 });
});

test('a planned lane that sent nothing and declared nothing is recorded as silent', () => {
  // The failure the roster accounting exists to catch. If telemetry cannot
  // distinguish it, the file cannot answer how often it happens.
  const round1 = { auditor: review('auditor', []), steward: review('steward', []) };
  const record = buildRunRecord({
    syn: synthesize(round1),
    round1,
    plan: { lanes: [{ persona: 'auditor', run: true, agents: 1 },
      { persona: 'adversary', run: true, agents: 1 },
      { persona: 'steward', run: true, agents: 1 }] },
  });
  assert.equal(record.lanes.adversary.status, LANE_STATUS.silent);
  assert.equal(record.lanes.adversary.reported, null);
});

test('per-lane claim checks are null without a briefing and counted with one', () => {
  // "Nobody checked" is not "nothing was wrong" — the DISPROVED rate is the
  // hallucination gauge, and a zero invented for a run that never ran triage
  // would drag every average toward clean.
  const round1 = { auditor: review('auditor', [finding()]), steward: review('steward', []) };
  const syn = synthesize(round1);

  assert.equal(buildRunRecord({ syn, round1 }).lanes.auditor.disproved, null);
  assert.equal(buildRunRecord({ syn, round1 }).triage, null);

  const briefing = {
    base: 'abc123',
    findings: [
      { reporter: 'auditor', claimCheck: { status: 'DISPROVED' }, kindCheck: { status: 'ok' } },
      { reporter: 'auditor', claimCheck: { status: 'ok' }, kindCheck: { status: 'under-anchored' } },
      { reporter: 'steward', claimCheck: { status: 'ok' }, kindCheck: { status: 'ok' } },
    ],
    clusters: [{}], crossReferences: [], groups: [{}, {}], settled: [], regressed: [],
  };
  const withBriefing = buildRunRecord({ syn, round1, briefing, base: briefing.base });
  assert.equal(withBriefing.lanes.auditor.disproved, 1);
  assert.equal(withBriefing.lanes.auditor.underAnchored, 1);
  assert.equal(withBriefing.lanes.steward.disproved, 0, 'it was checked and was clean');
  assert.equal(withBriefing.triage.groupsProposed, 2);
  assert.equal(withBriefing.base, 'abc123');
});

test("round 2's yield is counted, including the additions round 1 missed", () => {
  const round1 = { auditor: review('auditor', [finding()]), steward: review('steward', []) };
  const round2 = {
    steward: {
      persona: 'steward',
      validate: [{ title: 'a finding', reason: 'confirmed' }],
      challenge: [],
      added: [finding({ title: 'round 2 caught this', severity: 'warning' })],
    },
  };
  const record = buildRunRecord({ syn: synthesize(round1, round2), round1, round2 });
  assert.deepEqual(record.round2, { personas: 1, validated: 1, challenged: 0, added: 1 });
  assert.deepEqual(record.roster.crossReviewed, ['steward']);
  assert.equal(buildRunRecord({ syn: synthesize(round1), round1 }).round2, null);
});

test('no prose reaches the record', () => {
  // The file must stay safe to paste into an issue about a threshold. Every
  // string a model or an operator wrote is a sentinel here; none may survive.
  const S = {
    title: 'SENTINEL-TITLE-8a1', detail: 'SENTINEL-DETAIL-8a2', fix: 'SENTINEL-FIX-8a3',
    summary: 'SENTINEL-SUMMARY-8a4', skip: 'SENTINEL-SKIP-8a5', reason: 'SENTINEL-REASON-8a6',
    file: 'SENTINEL-PATH-8a7.mjs', planReason: 'SENTINEL-PLAN-8a8', pin: 'SENTINEL-PIN-8a9',
  };
  const round1 = {
    auditor: review('auditor',
      [finding({ title: S.title, detail: S.detail, fix: S.fix, file: S.file })],
      { summary: S.summary }),
    steward: review('steward', [], { summary: S.summary }),
  };
  const round2 = {
    steward: {
      persona: 'steward',
      validate: [], challenge: [{ title: S.title, reason: S.reason }], added: [],
    },
  };
  const record = buildRunRecord({
    syn: synthesize(round1, round2, {
      skippedPersonas: [{ persona: 'pragmatist', reason: S.skip }],
      rootCauseGroups: [{ id: 'G1', title: S.title, status: 'proposed', citations: [] }],
    }),
    round1,
    round2,
    briefing: { findings: [{ reporter: 'auditor', title: S.title, file: S.file }], groups: [] },
    plan: {
      size: { bucket: 'small', fileCount: 2, changedLines: 9 },
      pinned: [S.pin],
      lanes: [{ persona: 'auditor', run: true, agents: 1, reason: S.planReason }],
    },
  });

  const serialized = JSON.stringify(record);
  for (const [field, sentinel] of Object.entries(S)) {
    assert.doesNotMatch(serialized, new RegExp(sentinel), `${field} leaked into the record`);
  }
  assert.equal(record.plan.pinned, 1, 'a pinned path is counted, never quoted');
});

// -------------------------------------------------------------- the identity

test('a remote yields owner/name and nothing else', () => {
  assert.equal(repoFromRemote('git@github.com:kfox/adverse.git'), 'kfox/adverse');
  assert.equal(repoFromRemote('https://github.com/kfox/adverse'), 'kfox/adverse');
  // A checkout whose origin carries a credential — some CI runners write one —
  // must not put it in a file the maintainer is invited to share.
  assert.equal(repoFromRemote('https://user:ghp_secret@github.com/kfox/adverse.git'),
    'kfox/adverse');
  // A local-path remote's parent segment is somebody's directory layout.
  assert.equal(repoFromRemote('/Users/someone/src/adverse'), 'adverse');
});

test('the destination is one file per machine, overridable', () => {
  assert.equal(telemetryPath({ XDG_CACHE_HOME: '/c' }), path.join('/c', 'adverse', 'runs.jsonl'));
  assert.equal(telemetryPath({ ADVERSE_TELEMETRY_FILE: '/tmp/x.jsonl' }), '/tmp/x.jsonl');
  assert.equal(telemetryDisabled({ ADVERSE_NO_TELEMETRY: '1' }), true);
  assert.equal(telemetryDisabled({ ADVERSE_NO_TELEMETRY: '' }), false);
  assert.equal(telemetryDisabled({}), false);
});

// --------------------------------------------------------------- the append

test('records append as whole lines and the directory is created', () => {
  const file = path.join(freshTmp(), 'nested', 'runs.jsonl');
  assert.deepEqual(appendRunRecord({ a: 1 }, file).ok, true);
  assert.deepEqual(appendRunRecord({ a: 2 }, file).ok, true);

  const lines = readFileSync(file, 'utf-8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.deepEqual(lines.map((l) => JSON.parse(l).a), [1, 2]);
});

test('a write that cannot happen is returned, not thrown', () => {
  // The caller is finishing a review. Nothing here may interrupt that, so the
  // failure comes back as a value — and a symlinked destination is refused
  // outright rather than followed, the same rule the bridges' write queue uses.
  const dir = freshTmp();
  const target = path.join(dir, 'not-ours.json');
  const dest = path.join(dir, 'runs.jsonl');
  writeFileSync(target, 'keep me');
  symlinkSync(target, dest);

  const result = appendRunRecord({ a: 1 }, dest);
  assert.equal(result.ok, false);
  assert.match(result.error, /ELOOP/);
  assert.equal(readFileSync(target, 'utf-8'), 'keep me');
});

// ------------------------------------------------------------ through the CLI

function runSynthesize(args, env = {}) {
  return spawnSync(process.execPath, [BIN, 'synthesize', ...args], {
    cwd: ROOT,
    encoding: 'utf-8',
    timeout: 30_000,
    env: { ...process.env, ADVERSE_NO_TELEMETRY: '', ...env },
  });
}

function round1File(dir) {
  const p = path.join(dir, 'round1.json');
  writeFileSync(p, JSON.stringify({
    auditor: review('auditor', [finding()]),
    steward: review('steward', []),
  }));
  return p;
}

test('a synthesize run leaves exactly one line behind', () => {
  const dir = freshTmp();
  const file = path.join(dir, 'runs.jsonl');
  const r = runSynthesize(
    ['--round1', round1File(dir), '--out', path.join(dir, 'r.md'), '--iteration', '2'],
    { ADVERSE_TELEMETRY_FILE: file });

  assert.equal(r.status, 0, r.stderr);
  const record = JSON.parse(readFileSync(file, 'utf-8').trim());
  assert.equal(record.findings.total, 1);
  assert.equal(record.iteration, 2);
  assert.equal(record.repo, 'kfox/adverse', 'the run identifies its repository');
  assert.match(record.head, /^[0-9a-f]{40}$/);
  assert.equal(record.verdict.label, r.stderr.match(/verdict: (.*) ·/)[1]);
});

test('both opt-outs write nothing at all', () => {
  for (const [args, env] of [
    [['--no-telemetry'], {}],
    [[], { ADVERSE_NO_TELEMETRY: '1' }],
  ]) {
    const dir = freshTmp();
    const file = path.join(dir, 'runs.jsonl');
    const r = runSynthesize(
      ['--round1', round1File(dir), '--out', path.join(dir, 'r.md'), ...args],
      { ADVERSE_TELEMETRY_FILE: file, ...env });

    assert.equal(r.status, 0, r.stderr);
    assert.equal(existsSync(file), false, `${JSON.stringify(args)} ${JSON.stringify(env)}`);
  }
});

test('a telemetry file that cannot be written does not change the run', () => {
  // The whole point of the fail-open direction: the report is published, the
  // exit code is the verdict's, and the operator is told once why the line is
  // missing.
  const dir = freshTmp();
  const r = runSynthesize(
    ['--round1', round1File(dir), '--out', path.join(dir, 'r.md')],
    { ADVERSE_TELEMETRY_FILE: dir });   // a directory: the append cannot succeed

  assert.equal(r.status, 0, 'the review still ships');
  assert.match(r.stderr, /telemetry not written/);
  assert.match(r.stderr, /verdict:/, 'the report was still rendered');
});

test('a non-numeric --iteration is refused rather than recorded as NaN', () => {
  const dir = freshTmp();
  const r = runSynthesize(
    ['--round1', round1File(dir), '--iteration', '$I'],
    { ADVERSE_TELEMETRY_FILE: path.join(dir, 'runs.jsonl') });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--iteration must be an integer/);
});
