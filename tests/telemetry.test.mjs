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
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'adverse.mjs');
const srcUrl = (name) => pathToFileURL(path.join(ROOT, 'src', name)).href;

const FAKE_AGENT = path.join(ROOT, 'tests', 'fixtures', 'fake-agent.mjs');
const BASE_SHA = '4d1f0c2b9a7e5d3c8b6a4f2e1d0c9b8a7f6e5d4c';

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

test('a lane that did not look records null claim checks even when a briefing exists', () => {
  // The first version of this tested `mine ? … : null` where `mine` was a
  // filtered ARRAY, and an empty array is truthy — so every lane that did not
  // look reported `disproved: 0`, which reads as "checked, and clean". The
  // briefing here deliberately carries findings, because a run with no
  // briefing at all cannot tell the two implementations apart.
  const round1 = { auditor: review('auditor', [finding()]), steward: review('steward', []) };
  const briefing = {
    findings: [{ reporter: 'auditor', claimCheck: { status: 'ok' }, kindCheck: { status: 'ok' } }],
    groups: [],
  };
  const record = buildRunRecord({
    syn: synthesize(round1, {}, {
      failedPersonas: ['adversary'],
      skippedPersonas: [{ persona: 'pragmatist', reason: 'small diff' }],
    }),
    round1,
    briefing,
    plan: { lanes: [{ persona: 'auditor', run: true, agents: 1 },
      { persona: 'adversary', run: true, agents: 1 },
      { persona: 'steward', run: true, agents: 1 },
      { persona: 'pragmatist', run: false, agents: 0 }] },
  });

  for (const lane of ['adversary', 'pragmatist']) {
    assert.equal(record.lanes[lane].disproved, null, `${lane} did not look`);
    assert.equal(record.lanes[lane].underAnchored, null, `${lane} did not look`);
    assert.equal(record.lanes[lane].reported, null, `${lane} did not look`);
  }
  assert.equal(record.lanes.auditor.disproved, 0, 'it was checked and was clean');
});

test('a declared lane whose payload is still on disk counts as declared', () => {
  // A standalone `synthesize --degraded auditor` whose round-1 file is still
  // in the run directory: the declaration wins, because a lane the operator
  // says failed did not review, whatever is lying beside it.
  const round1 = { auditor: review('auditor', [finding()]), steward: review('steward', []) };
  const record = buildRunRecord({
    syn: synthesize(round1, {}, { failedPersonas: ['auditor'] }),
    round1,
  });
  assert.equal(record.lanes.auditor.status, LANE_STATUS.degraded);
  assert.equal(record.lanes.auditor.reported, null);
});

test('a split lane is one row, not two reviewers', () => {
  // Raw per-agent payloads, the spelling `combine.mjs` would have merged.
  const round1 = {
    'auditor-a': review('auditor', [finding()]),
    'auditor-b': review('auditor', [finding({ title: 'other half' })]),
    steward: review('steward', []),
  };
  const record = buildRunRecord({ syn: synthesize(round1), round1 });
  assert.deepEqual(record.roster.reported, ['auditor', 'steward']);
  assert.equal(record.lanes.auditor.reported, 2, 'both halves of one lane');
  assert.equal(record.roster.unknown, 0);
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
    base: BASE_SHA,
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
  assert.equal(withBriefing.base, BASE_SHA);
});

test('a base is recorded only as a sha, never as a name somebody chose', () => {
  // `triage.mjs --base` takes any ref, so `base` arrives as free text — the one
  // field that was copied through rather than counted. A branch name is where
  // a customer or an embargoed feature ends up in a file documented as safe to
  // paste into an issue.
  const round1 = { auditor: review('auditor', []), steward: review('steward', []) };
  const syn = synthesize(round1);
  const baseOf = (base) => buildRunRecord({ syn, round1, base }).base;

  assert.equal(baseOf(BASE_SHA), BASE_SHA);
  assert.equal(baseOf(BASE_SHA.slice(0, 12)), BASE_SHA.slice(0, 12), 'an abbreviated sha');
  assert.equal(baseOf('release/acme-corp-migration'), null);
  assert.equal(baseOf('main'), null);
  assert.equal(baseOf(null), null);
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
  // `severity` is deliberately left valid: a finding with an unknown severity is
  // dropped whole by `buildFinding`, which would take the other sentinels with
  // it and pass this test for the wrong reason.
  const S = {
    title: 'SENTINEL-TITLE-8a1', detail: 'SENTINEL-DETAIL-8a2', fix: 'SENTINEL-FIX-8a3',
    summary: 'SENTINEL-SUMMARY-8a4', skip: 'SENTINEL-SKIP-8a5', reason: 'SENTINEL-REASON-8a6',
    file: 'SENTINEL-PATH-8a7.mjs', planReason: 'SENTINEL-PLAN-8a8', pin: 'SENTINEL-PIN-8a9',
    // `coerceKind` accepts any non-empty string, so this one arrived as an
    // object KEY in the tallies — 4 KB of it, when the panel measured it.
    kind: 'SENTINEL-KIND-8b1', status: 'SENTINEL-STATUS-8b2', persona: 'SENTINEL-LANE-8b3',
    base: 'SENTINEL-BASE-8b4',
  };
  const round1 = {
    auditor: review('auditor',
      [finding({ title: S.title, detail: S.detail, fix: S.fix, file: S.file, kind: S.kind })],
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
      rootCauseGroups: [{ id: 'G1', title: S.title, status: S.status, citations: [] }],
    }),
    round1,
    round2,
    base: S.base,
    briefing: {
      findings: [{ reporter: S.persona, title: S.title, file: S.file }],
      groups: [],
    },
    plan: {
      size: { bucket: 'small', fileCount: 2, changedLines: 9 },
      pinned: [S.pin],
      lanes: [{ persona: 'auditor', run: true, agents: 1, reason: S.planReason },
        { persona: S.persona, run: true, agents: 2, reason: S.planReason }],
    },
  });

  const serialized = JSON.stringify(record);
  for (const [field, sentinel] of Object.entries(S)) {
    assert.doesNotMatch(serialized, new RegExp(sentinel), `${field} leaked into the record`);
  }
  assert.equal(record.plan.pinned, 1, 'a pinned path is counted, never quoted');
  // Counted, not dropped: an off-vocabulary kind is a fact about the run.
  assert.equal(record.findings.byKind.other, 1);
  // A group's status is recomputed by synthesis from the rulings, so the
  // briefing's own value never reaches the record — the clamp on it is a
  // second lock on a door that is currently shut. The sentinel stays in the
  // set above so a change that opens it fails this test rather than shipping.
  assert.equal(record.rootCauses.byStatus.proposed, 1);
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
  // The same path wearing a scheme. Without the scheme stripped it took the
  // owner/name branch and published `src` as an owner.
  assert.equal(repoFromRemote('file:///Users/someone/src/adverse'), 'adverse');
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

test('every --iteration that is not a pass number is refused', () => {
  // `--iteration $I` with an unset shell variable is the case this exists for,
  // and an empty string is not NaN: `Number('') === 0` passed an
  // `isInteger` check and recorded the missing value as pass zero.
  // `=` form for the negative, which parseArgs would otherwise read as a flag.
  for (const bad of [['--iteration', '$I'], ['--iteration', ''], ['--iteration', ' '],
    ['--iteration', '0'], ['--iteration=-1'], ['--iteration', '2.5']]) {
    const dir = freshTmp();
    const file = path.join(dir, 'runs.jsonl');
    const r = runSynthesize(['--round1', round1File(dir), ...bad],
      { ADVERSE_TELEMETRY_FILE: file });
    assert.equal(r.status, 2, `${JSON.stringify(bad)}: exit ${r.status}`);
    assert.match(r.stderr, /--iteration must be a pass number/, JSON.stringify(bad));
    assert.equal(existsSync(file), false, `${JSON.stringify(bad)} still wrote a line`);
  }
});

test('a hostile round-1 key never reaches the file', () => {
  // Measured end-to-end by the panel: `adverse synthesize --round1` validated
  // no persona name, so a key was a free string that landed verbatim in
  // `roster.reported` and as a key under `lanes`.
  //
  // Asserted against the WRITER rather than through the CLI, because the CLI
  // now refuses a key that names no lane before any of this runs and no
  // fixture can reach this code through it. `buildRunRecord` is also fed
  // in-process by `adverse review`, so the property is still the writer's to
  // hold: a name it cannot place is counted, never quoted. The case below
  // pins the refusal that made this one unreachable.
  const round1 = {
    auditor: review('auditor', [finding()]),
    steward: review('steward', []),
    'SENTINEL-LEAK-9f2a1': review('auditor', [finding()]),
  };
  const record = buildRunRecord({ syn: synthesize(round1), round1 });

  const line = JSON.stringify(record);
  assert.doesNotMatch(line, /SENTINEL-LEAK-9f2a1/);
  assert.deepEqual(record.roster.reported, ['auditor', 'steward']);
  assert.equal(record.roster.unknown, 1, 'counted, not quoted');
});

test('a round-1 key that names no lane writes no telemetry line at all', () => {
  // One layer earlier than the test above, and the reason that one moved off
  // the CLI: a key that names no lane is refused at the flag, so the run that
  // would have recorded it never happens. `referee` is the case a shape check
  // cannot reach — a well-formed lane name for no lane.
  for (const key of ['SENTINEL-LEAK-9f2a1', 'referee']) {
    const dir = freshTmp();
    const file = path.join(dir, 'runs.jsonl');
    const payload = path.join(dir, 'round1.json');
    writeFileSync(payload, JSON.stringify({
      auditor: review('auditor', [finding()]),
      [key]: review('auditor', [finding()]),
    }));

    const r = runSynthesize(['--round1', payload, '--out', path.join(dir, 'r.md')],
      { ADVERSE_TELEMETRY_FILE: file });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /names no review lane/, key);
    assert.equal(existsSync(file), false, `${key} recorded a line`);
  }
});

test('the destination directory is not followed when it is a symlink', () => {
  // O_NOFOLLOW protects the destination FILE; mkdirSync reaches it through a
  // directory and follows a symlink there. The panel planted
  // `~/.cache/adverse -> attacker/dir` and the whole write landed inside it.
  const dir = freshTmp();
  const elsewhere = path.join(dir, 'elsewhere');
  const planted = path.join(dir, 'cache');
  mkdirSync(elsewhere);
  symlinkSync(elsewhere, planted);

  const result = appendRunRecord({ a: 1 }, path.join(planted, 'runs.jsonl'));
  assert.equal(result.ok, false);
  assert.match(result.error, /symlink/);
  assert.deepEqual(readdirSync(elsewhere), [], 'nothing was written through the link');
});

test('`adverse review` records its run too, and honors the opt-out', () => {
  // The other call site. It has more to say than synthesize does — it knows
  // which lanes it spawned — and nothing pinned that it says anything at all.
  const target = freshTmp();
  writeFileSync(path.join(target, 'auth.py'),
    'def check(name, conn):\n'
    + '    return conn.execute("SELECT * FROM users WHERE name = \'" + name + "\'")\n');

  const runReview = (args, env) => spawnSync(process.execPath,
    [BIN, 'review', target, '--agent', `${process.execPath} ${FAKE_AGENT}`, ...args],
    { cwd: ROOT, encoding: 'utf-8', timeout: 60_000,
      env: { ...process.env, ADVERSE_NO_TELEMETRY: '', ...env } });

  const file = path.join(target, 'runs.jsonl');
  const r = runReview(['--out', path.join(target, 'r.md')], { ADVERSE_TELEMETRY_FILE: file });
  assert.ok(r.status === 0 || r.status === 1, `unexpected status ${r.status}: ${r.stderr}`);
  const record = JSON.parse(readFileSync(file, 'utf-8').trim().split('\n')[0]);
  assert.ok(record.roster.reported.length >= 2, 'the lanes it spawned');
  assert.equal(record.plan, null, 'review runs without a plan file');

  const quiet = path.join(target, 'quiet.jsonl');
  runReview(['--out', path.join(target, 'r2.md'), '--no-telemetry'],
    { ADVERSE_TELEMETRY_FILE: quiet });
  assert.equal(existsSync(quiet), false);
});


// --- depth: the confounder for the row beside it --------------------------------

const planRowFor = (plan) => buildRunRecord({
  syn: synthesize({ auditor: review('auditor', []) }),
  round1: { auditor: review('auditor', []) },
  round2: {},
  plan,
}).plan;

test('the plan row records the depth the run was planned at', () => {
  // The `agents` row answers whether the Pragmatist skip and the split lane
  // earn their keep, and depth is what makes two of its rows comparable: a
  // lane skipped because the user asked for a cheap pass is not evidence about
  // the size policy at all, and without this field the two aggregate as one.
  const row = planRowFor({
    size: { bucket: 'medium' },
    depth: 'cheap',
    lanes: [{ persona: 'auditor', run: true, agents: 1 }],
  });
  assert.equal(row.depth, 'cheap');
});

test('a plan with no depth records null rather than inventing one', () => {
  const row = planRowFor({
    size: { bucket: 'medium' },
    lanes: [{ persona: 'auditor', run: true, agents: 1 }],
  });
  assert.equal(row.depth, null);
});

test('a --plan reaches the telemetry line end to end, depth and all', () => {
  // Through the real binary, not buildRunRecord. The `plan` row is assembled
  // in telemetry.mjs but WIRED in cli.mjs, and a unit test on the assembler
  // passes just as happily when the caller stops handing it a plan — measured:
  // replacing `plan` with `null` at that call site broke no test in this file.
  const dir = freshTmp();
  const file = path.join(dir, 'runs.jsonl');
  const planPath = path.join(dir, 'plan.json');
  writeFileSync(planPath, JSON.stringify({
    depth: 'thorough',
    size: { bucket: 'small', fileCount: 1, changedLines: 4, measured: true },
    pinned: [],
    rounds: 2,
    maxIterations: 3,
    lanes: [{ persona: 'auditor', run: true, agents: 1 },
      { persona: 'steward', run: true, agents: 1 }],
  }));

  const r = runSynthesize(
    ['--round1', round1File(dir), '--plan', planPath, '--out', path.join(dir, 'r.md')],
    { ADVERSE_TELEMETRY_FILE: file });

  assert.equal(r.status, 0, r.stderr);
  const record = JSON.parse(readFileSync(file, 'utf-8').trim());
  assert.notEqual(record.plan, null, 'the plan never reached the record');
  assert.equal(record.plan.depth, 'thorough');
  assert.equal(record.plan.bucket, 'small');
  assert.deepEqual(record.plan.agents, { auditor: 1, steward: 1 });
});

// ---------------------------------------------------------------- probes

const probeRow = (probes) => buildRunRecord({
  syn: synthesize({ auditor: review('auditor', [finding()]) }),
  round1: { auditor: review('auditor', [finding()]) },
  probes,
}).probes;

test('a run with no probes records null, not a row of zeroes', () => {
  assert.equal(probeRow(null), null);
});

// `enabled` is the denominator every other number here needs: zero probes on a
// run that never enabled them is not the same data point as zero on a run that
// did, and a row that could not tell them apart cannot answer the question it
// exists for.
test('the probe row separates "nothing ran" from "nothing was enabled"', () => {
  assert.deepEqual(probeRow({ enabled: false, isolation: null, probes: [] }),
    { enabled: false, attached: 0, ran: 0, confirmed: 0, contradicted: 0, sandboxed: false });
  assert.deepEqual(probeRow({ enabled: true, isolation: null, probes: [] }),
    { enabled: true, attached: 0, ran: 0, confirmed: 0, contradicted: 0, sandboxed: false });
});

test('the probe row counts what ran, what confirmed, and what contradicted', () => {
  const p = (over) => ({ source: 'measured', confirmed: false, ...over });
  const row = probeRow({
    enabled: true,
    isolation: { sandbox: 'bwrap --unshare-net --' },
    probes: [p({ confirmed: true }), p({}), { source: 'declined', confirmed: false }],
  });
  assert.deepEqual(row,
    { enabled: true, attached: 3, ran: 2, confirmed: 1, contradicted: 1, sandboxed: true });
});

// This file records counts and nothing else, so a reader can paste a line into
// an issue while arguing about a threshold. A probe's script path and captured
// output are the two strings most likely to carry something private.
test('no probe path, output or reason survives into the line', () => {
  const row = probeRow({
    enabled: true,
    isolation: { sandbox: null, worktree: 'detached, one per probe' },
    probes: [{
      persona: 'auditor',
      title: 'SENTINEL-TITLE',
      claim: { script: 'probes/SENTINEL-PATH.sh', expect: 'SENTINEL-EXPECT' },
      source: 'measured',
      status: 'not-reproduced',
      ran: { exitCode: 1, output: 'SENTINEL-OUTPUT' },
      confirmed: false,
      why: 'SENTINEL-WHY',
    }],
  });
  assert.doesNotMatch(JSON.stringify(row), /SENTINEL/);
});

test('a --probes file reaches the telemetry line end to end', () => {
  // Through the real binary, for the reason the --plan test above gives: the
  // row is assembled in telemetry.mjs but WIRED in cli.mjs, and a unit test on
  // the assembler passes just as happily when the caller stops handing it one.
  const dir = freshTmp();
  const file = path.join(dir, 'runs.jsonl');
  const probesPath = path.join(dir, 'probes.json');
  writeFileSync(probesPath, JSON.stringify({
    enabled: true,
    head: null,
    isolation: { sandbox: null },
    probes: [{
      persona: 'auditor',
      agent: 'auditor',
      title: finding().title,
      claim: { script: 'p.sh', expect: 'e', observed: 'o', outcome: 'reproduced' },
      source: 'measured',
      status: 'reproduced',
      ran: { exitCode: 0, durationMs: 1, output: '', failure: null },
      confirmed: true,
      why: '',
    }],
  }));

  const r = runSynthesize(
    ['--round1', round1File(dir), '--probes', probesPath, '--out', path.join(dir, 'r.md')],
    { ADVERSE_TELEMETRY_FILE: file });

  assert.equal(r.status, 0, r.stderr);
  const record = JSON.parse(readFileSync(file, 'utf-8').trim());
  assert.notEqual(record.probes, null, 'the probes file never reached the record');
  assert.equal(record.probes.confirmed, 1);
  // And the other half of the same wiring: the probe reached SYNTHESIS too, so
  // the finding it belongs to carries the label it bought.
  assert.equal(record.findings.byConfidence.demonstrated, 1);
});
