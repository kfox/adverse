// Tests for src/scaling.mjs — the review's budget policy.
//
// The properties that matter: size comes from numstat and every measurement
// failure lands OUTSIDE the cheap bucket, only the advisory lane is skippable
// on size, pins override every size-based economy case-insensitively, round 2
// is dropped only when nothing blocks under the synthesizer's own predicate,
// escalate fails closed on missing or off-shape input, and the iteration cap
// moves in one direction only. Most of these pin a rule whose failure would be
// silent — a lane quietly not running looks exactly like a lane that found
// nothing.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_PERSONAS } from '../src/personas.mjs';
import {
  DEFAULT_MAX_ITERATIONS, DELETED_LINES_ADVERSARY_FLOOR, ESCALATED_MAX_ITERATIONS,
  LARGE_MIN_CHANGED_LINES, LARGE_MIN_FILES, SMALL_MAX_CHANGED_LINES, SMALL_MAX_FILES,
  MAX_SPLIT_AGENTS, SPLIT_AGENTS, agentNames, diffSize, escalate, parseNumstat, parsePlan, planReview,
  runLanes, sizeSkippable, skippedLanes, splitLanes,
} from '../src/scaling.mjs';

const filesOf = (n) => Array.from({ length: n }, (_, i) => `src/render/mod${i}.mjs`);

// numstat text for n files of `added`/`deleted` lines each.
const numstatOf = (entries) =>
  entries.map(([add, del, path]) => `${add}\t${del}\t${path}`).join('\n') + '\n';

const evenNumstat = (files, added, deleted = 0) => {
  const per = Math.floor(added / files.length);
  const perDel = Math.floor(deleted / files.length);
  return numstatOf(files.map((f, i) => [
    i === 0 ? added - per * (files.length - 1) : per,
    i === 0 ? deleted - perDel * (files.length - 1) : perDel,
    f,
  ]));
};

const lane = (plan, persona) => plan.lanes.find((l) => l.persona === persona);

// --- parseNumstat / diffSize -----------------------------------------------------

test('changed lines count additions AND deletions — a deletion-only diff is not small', () => {
  const files = ['src/gate.mjs'];
  const size = diffSize({ files, numstat: numstatOf([[0, 200, 'src/gate.mjs']]) });
  assert.equal(size.changedLines, 200);
  assert.equal(size.bucket, 'medium');
});

test('a deletion-heavy diff can be large', () => {
  const size = diffSize({
    files: ['a.mjs'],
    numstat: numstatOf([[0, LARGE_MIN_CHANGED_LINES, 'a.mjs']]),
  });
  assert.equal(size.bucket, 'large');
});

test('an unmeasurable numstat row sizes the diff LARGE — hidden content must never shrink the bucket', () => {
  // Out of `small` was not enough: a hidden 2,000-line file still shrank
  // large to medium and halved the split lanes' budget.
  const files = ['a.mjs', 'payload.mjs'];
  const size = diffSize({
    files,
    numstat: numstatOf([[1, 0, 'a.mjs']]) + '-\t-\tpayload.mjs\n',
  });
  assert.deepEqual(size.unscannable, ['payload.mjs']);
  assert.equal(size.bucket, 'large');
});

test('an unread diff (null) forces the adversary with a truthful reason', () => {
  const plan = planReview({
    files: ['src/render/palette.mjs'],
    numstat: numstatOf([[5, 0, 'src/render/palette.mjs']]),
    diff: null,
  });
  const adv = plan.lanes.find((l) => l.persona === 'adversary');
  assert.equal(adv.run, true);
  assert.match(adv.reason, /could not be read/);
});

test('no numstat means unmeasured, and unmeasured never qualifies as small', () => {
  const size = diffSize({ files: ['a.mjs'] });
  assert.equal(size.measured, false);
  assert.equal(size.bucket, 'medium');
});

test('the small bucket needs BOTH few files and few changed lines', () => {
  const files3 = filesOf(SMALL_MAX_FILES);
  assert.equal(diffSize({ files: files3, numstat: evenNumstat(files3, SMALL_MAX_CHANGED_LINES) }).bucket, 'small');
  const files4 = filesOf(SMALL_MAX_FILES + 1);
  assert.equal(diffSize({ files: files4, numstat: evenNumstat(files4, SMALL_MAX_CHANGED_LINES) }).bucket, 'medium');
  assert.equal(diffSize({ files: files3, numstat: evenNumstat(files3, SMALL_MAX_CHANGED_LINES + 1) }).bucket, 'medium');
});

test('the large bucket needs EITHER many files or many changed lines', () => {
  const many = filesOf(LARGE_MIN_FILES);
  assert.equal(diffSize({ files: many, numstat: evenNumstat(many, 30) }).bucket, 'large');
  assert.equal(diffSize({ files: ['a.mjs'], numstat: numstatOf([[LARGE_MIN_CHANGED_LINES, 0, 'a.mjs']]) }).bucket, 'large');
  const some = filesOf(LARGE_MIN_FILES - 1);
  assert.equal(diffSize({ files: some, numstat: evenNumstat(some, LARGE_MIN_CHANGED_LINES - 1) }).bucket, 'medium');
});

test('a 2-file diff with a large body is large, not small — large is checked first', () => {
  assert.equal(diffSize({
    files: filesOf(2),
    numstat: evenNumstat(filesOf(2), LARGE_MIN_CHANGED_LINES),
  }).bucket, 'large');
});

// --- planReview: lanes -----------------------------------------------------------

const smallPlan = (over = {}) => planReview({
  files: ['src/render/palette.mjs'],
  numstat: numstatOf([[5, 0, 'src/render/palette.mjs']]),
  diff: '',
  ...over,
});
const largeFiles = [...filesOf(20), 'src/auth/session.mjs'];
const largePlan = () => planReview({
  files: largeFiles,
  numstat: evenNumstat(largeFiles, 100),
  diff: '',
});

test('the plan covers exactly the persona registry', () => {
  assert.deepEqual(smallPlan().lanes.map((l) => l.persona), [...DEFAULT_PERSONAS]);
});

test('the auditor and the steward run in every bucket', () => {
  for (const plan of [smallPlan(), largePlan()]) {
    assert.equal(lane(plan, 'auditor').run, true);
    assert.equal(lane(plan, 'steward').run, true);
  }
});

test('the pragmatist is skipped on a small diff and only there', () => {
  const small = smallPlan();
  assert.equal(lane(small, 'pragmatist').run, false);
  assert.equal(lane(small, 'pragmatist').agents, 0);

  const medium = planReview({ files: filesOf(8), numstat: evenNumstat(filesOf(8), 200), diff: '' });
  assert.equal(lane(medium, 'pragmatist').run, true);
});

test('at least two personas survive every plan — synthesis needs two voices', () => {
  assert.ok(smallPlan().lanes.filter((l) => l.run).length >= 2);
});

test('the adversary follows assessScope on a scannable diff', () => {
  assert.equal(lane(smallPlan(), 'adversary').run, false);
  const boundary = planReview({
    files: ['src/auth/session.mjs'],
    numstat: numstatOf([[5, 0, 'src/auth/session.mjs']]),
    diff: '',
  });
  assert.equal(lane(boundary, 'adversary').run, true);
});

test('unmeasurable content forces the adversary — hidden content cannot prove absence', () => {
  const plan = planReview({
    files: ['src/render/palette.mjs', 'payload.mjs'],
    numstat: numstatOf([[1, 0, 'src/render/palette.mjs']]) + '-\t-\tpayload.mjs\n',
    diff: '',
  });
  assert.equal(lane(plan, 'adversary').run, true);
  assert.match(lane(plan, 'adversary').reason, /unmeasurable/i);
});

test('heavy deletions force the adversary — a deletion can remove a guard', () => {
  const plan = planReview({
    files: ['src/render/gate.mjs'],
    numstat: numstatOf([[0, DELETED_LINES_ADVERSARY_FLOOR, 'src/render/gate.mjs']]),
    diff: '',
  });
  assert.equal(lane(plan, 'adversary').run, true);
  assert.match(lane(plan, 'adversary').reason, /deleted/i);
});

test('only the per-file lanes split on a large diff, and only there', () => {
  const large = largePlan();
  assert.equal(lane(large, 'auditor').agents, SPLIT_AGENTS);
  assert.equal(lane(large, 'adversary').agents, SPLIT_AGENTS);
  assert.equal(lane(large, 'steward').agents, 1);
  assert.equal(lane(large, 'pragmatist').agents, 1);

  const medium = planReview({ files: filesOf(8), numstat: evenNumstat(filesOf(8), 200), diff: '' });
  assert.equal(lane(medium, 'auditor').agents, 1);
});

test('a one-file large diff is not split — a lane never gets more agents than files', () => {
  // combine.mjs requires exactly 2 payloads for a merged lane, so a split with
  // one file either reviews nothing twice or stalls the run at combine.
  const plan = planReview({
    files: ['assets/logo.png'],
    numstat: '-\t-\tassets/logo.png\n',
    diff: '',
  });
  assert.equal(plan.size.bucket, 'large');
  assert.equal(lane(plan, 'auditor').agents, 1);
  assert.equal(lane(plan, 'adversary').agents, 1);
  // The prose must agree with the agents field: a reason claiming a two-agent
  // split beside agents: 1 invites the impossible one-file partition.
  assert.doesNotMatch(lane(plan, 'auditor').reason, /two agents/);
});

test('a mismatched numstat cannot size the list small, but its forces stay live', () => {
  // numstatMatchesFiles: false is the --files case: the measurement covers a
  // different range, so it may only ADD review, never qualify the cheap bucket.
  const quiet = planReview({
    files: ['a.mjs', 'b.mjs'],
    numstat: numstatOf([[2, 1, 'a.mjs']]),
    numstatMatchesFiles: false,
    diff: '',
  });
  assert.equal(quiet.size.measured, false);
  assert.notEqual(quiet.size.bucket, 'small');

  const deletions = planReview({
    files: ['a.mjs', 'b.mjs'],
    numstat: numstatOf([[0, DELETED_LINES_ADVERSARY_FLOOR, 'a.mjs']]),
    numstatMatchesFiles: false,
    diff: '',
  });
  assert.equal(lane(deletions, 'adversary').run, true);
  assert.match(lane(deletions, 'adversary').reason, /deleted/i);

  const hidden = planReview({
    files: ['a.mjs', 'b.mjs'],
    numstat: '-\t-\tpayload.xyz\n',
    numstatMatchesFiles: false,
    diff: '',
  });
  assert.equal(hidden.size.bucket, 'large');
  assert.equal(lane(hidden, 'adversary').run, true);
});

// --- planReview: pins ------------------------------------------------------------

test('a matched pin forces every lane on, whatever the size', () => {
  const plan = smallPlan({ pins: ['render/palette'] });
  for (const l of plan.lanes) assert.equal(l.run, true, l.persona);
  assert.equal(plan.pinned.length, 1);
});

test('pin matching is case-insensitive in both directions', () => {
  const plan = planReview({
    files: ['src/Auth/Credentials.mjs'],
    numstat: numstatOf([[1, 0, 'src/Auth/Credentials.mjs']]),
    diff: '',
    pins: ['src/auth', 'CREDENTIAL'],
  });
  assert.equal(plan.pinned.length, 2);
  for (const l of plan.lanes) assert.equal(l.run, true, l.persona);
});

test('an unmatched pin changes nothing', () => {
  const plan = smallPlan({ pins: ['hw/dma'] });
  assert.deepEqual(plan.pinned, []);
  assert.equal(lane(plan, 'pragmatist').run, false);
});

// --- planReview: defaults --------------------------------------------------------

test('an empty file list gets the full shape — handed nothing is not "found nothing"', () => {
  const plan = planReview({ files: [], diff: '' });
  for (const l of plan.lanes) assert.equal(l.run, true, l.persona);
});

test('rounds and the cap are the full defaults pre-flight, in every bucket', () => {
  for (const plan of [smallPlan(), largePlan()]) {
    assert.equal(plan.rounds, 2);
    assert.equal(plan.maxIterations, DEFAULT_MAX_ITERATIONS);
  }
});

// --- escalate --------------------------------------------------------------------

const payload = (persona, findings) => ({ persona, verdict: 'conditional', findings });
const finding = (over = {}) => ({
  severity: 'warning', kind: 'defect', file: 'x.mjs', line: 3,
  title: 'a finding', detail: 'detail', fix: null, counterpart: null, ...over,
});

test('no findings at all: round 2 is skippable, and the reason demands a declaration', () => {
  const r = escalate([payload('auditor', []), payload('steward', [])]);
  assert.equal(r.rounds, 1);
  assert.equal(r.maxIterations, DEFAULT_MAX_ITERATIONS);
  assert.match(r.roundsReason, /--round2-skipped/);
});

test('an info-severity clean-pass finding does not hold round 2 — the predicate is isBlocking', () => {
  const r = escalate([payload('auditor', [finding({ severity: 'info', title: 'verified: clean' })])]);
  assert.equal(r.rounds, 1);
});

test('advisory-only findings: round 2 skippable, and a critical design never raises the cap', () => {
  const r = escalate([payload('pragmatist', [finding({ kind: 'design', severity: 'critical' })])]);
  assert.equal(r.rounds, 1);
  assert.equal(r.maxIterations, DEFAULT_MAX_ITERATIONS);
});

test('one warning defect: round 2 runs, cap stays at the default', () => {
  const r = escalate([payload('auditor', [finding()])]);
  assert.equal(r.rounds, 2);
  assert.equal(r.maxIterations, DEFAULT_MAX_ITERATIONS);
});

test('a critical defect raises the cap', () => {
  const r = escalate([payload('auditor', [finding({ severity: 'critical' })])]);
  assert.equal(r.rounds, 2);
  assert.equal(r.maxIterations, ESCALATED_MAX_ITERATIONS);
});

test('a missing or unrecognized kind counts as blocking — mislabeling cannot dodge round 2', () => {
  assert.equal(escalate([payload('auditor', [finding({ kind: undefined })])]).rounds, 2);
  assert.equal(escalate([payload('auditor', [finding({ kind: 'stylistic' })])]).rounds, 2);
});

test('escalate accepts the keyed-by-persona shape combine.mjs produces', () => {
  const r = escalate({ auditor: payload('auditor', [finding({ severity: 'critical' })]) });
  assert.equal(r.maxIterations, ESCALATED_MAX_ITERATIONS);
});

test('an off-shape payload fails closed: round 2 runs and the problem is named', () => {
  // A payload with no findings array is a lane nobody heard from, not a lane
  // that found nothing — the opposite of the tolerance an earlier version of
  // this file pinned.
  const r = escalate([{ persona: 'auditor' }, null]);
  assert.equal(r.rounds, 2);
  assert.ok(r.problems.length >= 2);
  assert.match(r.roundsReason, /fail closed/);
});

test('the combined object wrapped in an array fails closed instead of reading as empty', () => {
  const combined = { auditor: payload('auditor', [finding({ severity: 'critical' })]) };
  const r = escalate([combined]);
  assert.equal(r.rounds, 2);
  assert.ok(r.problems.length >= 1);
});

test('an expected lane with no payload fails closed', () => {
  const r = escalate([payload('auditor', [])], { expected: ['auditor', 'steward'] });
  assert.equal(r.rounds, 2);
  assert.match(r.roundsReason, /steward/);
});

test('a complete expected roster with nothing blocking still skips round 2', () => {
  const r = escalate(
    [payload('auditor', []), payload('steward', [])],
    { expected: ['auditor', 'steward'] },
  );
  assert.equal(r.rounds, 1);
});


// --- parsePlan and the projections off it -----------------------------------
//
// Three readers used to spell these rules, each validating a different half:
// the lane shape without the registry, the registry without the shape, and the
// `agents` count in exactly one of the three. These pin the union.

const lanesOf = (...lanes) => parsePlan({ lanes }).lanes;

test('parsePlan: a plan.json round-trips its own planReview output', () => {
  const plan = planReview({ files: filesOf(20), numstat: evenNumstat(filesOf(20), 900) });
  assert.deepEqual(parsePlan(JSON.parse(JSON.stringify(plan))).lanes.map((l) => l.persona),
    plan.lanes.map((l) => l.persona));
});

test('parsePlan: a skipped lane\'s `agents: 0` is a legitimate count, not a malformed one', () => {
  const [lane] = lanesOf({ persona: 'pragmatist', run: false, agents: 0, reason: 'skip' });
  assert.equal(lane.agents, 0);
  assert.equal(lane.run, false);
});

test('parsePlan: a lane omitting `agents` defaults to one when it runs, none when it does not', () => {
  const [runs, skipped] = lanesOf(
    { persona: 'auditor', run: true }, { persona: 'pragmatist', run: false });
  assert.equal(runs.agents, 1);
  assert.equal(skipped.agents, 0);
});

test('parsePlan: an explicit null `agents` is malformed, not an omission', () => {
  assert.throws(() => lanesOf({ persona: 'auditor', run: true, agents: null }),
    /invalid `agents` count/);
});

test('parsePlan: a running lane cannot claim zero agents', () => {
  assert.throws(() => lanesOf({ persona: 'auditor', run: true, agents: 0 }),
    /invalid `agents` count/);
});

test('parsePlan: every lane persona is checked against the registry, split or not', () => {
  for (const agents of [1, 2]) {
    assert.throws(() => lanesOf({ persona: 'referee', run: true, agents }),
      /is not a persona/, `agents: ${agents} must still be checked`);
  }
});

test('parsePlan: a lane must SAY whether it ran, rather than be read as truthy', () => {
  // `--agents` filtered on a truthy `run` and bridge-io tested `=== true`, so
  // `run: 1` got a worktree from one reader and was refused by the next.
  // Reading it as false would have silently dropped the lane's agents instead.
  for (const run of ['yes', 1, undefined, null, 0]) {
    assert.throws(() => lanesOf({ persona: 'auditor', run, agents: 1 }),
      /must say whether it ran/, `run: ${JSON.stringify(run)}`);
  }
});

test('parsePlan: a lane cannot split further than the a-z suffix scheme reaches', () => {
  assert.throws(() => lanesOf({ persona: 'auditor', run: true, agents: 27 }),
    /suffix scheme tops out at 26/);
  assert.equal(agentNames(lanesOf({ persona: 'auditor', run: true, agents: 26 })).at(-1),
    'auditor-z');
});

test('parsePlan: a lane that is not an object is refused, not read through', () => {
  for (const lane of [null, 'auditor', ['auditor']]) {
    assert.throws(() => parsePlan({ lanes: [lane] }), /a lane is not an object/);
  }
});

test('parsePlan: a file with no `lanes` array is refused', () => {
  for (const plan of [null, { oops: true }, { lanes: 'auditor' }]) {
    assert.throws(() => parsePlan(plan), /not a plan\.json/);
  }
});

test('splitLanes names only lanes that run AND were split', () => {
  const lanes = lanesOf(
    { persona: 'auditor', run: true, agents: 2 },
    { persona: 'adversary', run: false, agents: 2 },
    { persona: 'steward', run: true, agents: 1 });
  assert.deepEqual(splitLanes(lanes).map((l) => l.persona), ['auditor']);
});

test('runLanes and skippedLanes partition the roster', () => {
  const lanes = lanesOf(
    { persona: 'auditor', run: true, agents: 1 },
    { persona: 'pragmatist', run: false, agents: 0 });
  assert.deepEqual(runLanes(lanes).map((l) => l.persona), ['auditor']);
  assert.deepEqual(skippedLanes(lanes).map((l) => l.persona), ['pragmatist']);
});

test('agentNames suffixes a split lane per agent and leaves a solo lane bare', () => {
  const lanes = lanesOf(
    { persona: 'auditor', run: true, agents: 2 },
    { persona: 'steward', run: true, agents: 1 },
    { persona: 'pragmatist', run: false, agents: 0 });
  assert.deepEqual(agentNames(lanes), ['auditor-a', 'auditor-b', 'steward']);
});

test('agentNames reads the lane\'s own count, not a hardcoded two', () => {
  const lanes = lanesOf({ persona: 'auditor', run: true, agents: 3 });
  assert.deepEqual(agentNames(lanes), ['auditor-a', 'auditor-b', 'auditor-c']);
});

// The size skip and round 2's participation rule and the regression pass's
// eligibility are three readers of ONE sentence — "nothing this lane reports
// can block" — and the planner held a third copy of it, without the
// `kinds.length` guard the shared predicate has. A registry is injected because
// the Pragmatist is the only advisory-only lane in the real one, so any
// assertion over that registry agrees with a hard-coded `!== 'pragmatist'` and
// cannot tell one implementation from the other.
const registry = {
  reviewer: { kinds: ['defect', 'design'] },
  advisor: { kinds: ['design'] },
  // A lane registered with no kinds at all. `[].every(...)` is vacuously true,
  // which is how the planner's copy came to disagree with the shared one.
  blank: { kinds: [] },
};

test('a lane with no kinds is not size-skippable — an empty list is not an advisory list', () => {
  assert.equal(sizeSkippable('blank', { personas: registry }), false);
});

test('size-skippability is the advisory-only question, asked of the registry', () => {
  assert.equal(sizeSkippable('advisor', { personas: registry }), true);
  assert.equal(sizeSkippable('reviewer', { personas: registry }), false);
  // Unknown names fail toward giving the lane work rather than throwing on
  // `undefined.kinds`, which is what indexing the registry directly did.
  assert.equal(sizeSkippable('nobody', { personas: registry }), false);
});
