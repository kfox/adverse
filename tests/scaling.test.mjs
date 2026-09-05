// Tests for src/scaling.mjs — the review's budget policy.
//
// The properties that matter: only the advisory lane is skippable on size, the
// blocking lanes always run, pins override every size-based economy, round 2
// is dropped only when provably a no-op, and the iteration cap moves in one
// direction only. Most of these pin a rule whose failure would be silent — a
// lane quietly not running looks exactly like a lane that found nothing.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_MAX_ITERATIONS, ESCALATED_MAX_ITERATIONS, LARGE_MIN_ADDED_LINES,
  LARGE_MIN_FILES, SMALL_MAX_ADDED_LINES, SMALL_MAX_FILES, SPLIT_AGENTS,
  diffSize, escalate, planReview,
} from '../src/scaling.mjs';

const diffOfAdded = (n) =>
  ['diff --git a/x b/x', '--- a/x', '+++ b/x', '@@ -1 +1 @@',
    ...Array.from({ length: n }, (_, i) => `+const line${i} = ${i};`)].join('\n');

const filesOf = (n) => Array.from({ length: n }, (_, i) => `src/render/mod${i}.mjs`);

const lane = (plan, persona) => plan.lanes.find((l) => l.persona === persona);

// --- diffSize ------------------------------------------------------------------

test('the small bucket needs BOTH few files and few added lines', () => {
  assert.equal(diffSize({ files: filesOf(SMALL_MAX_FILES), diff: diffOfAdded(SMALL_MAX_ADDED_LINES) }).bucket, 'small');
  assert.equal(diffSize({ files: filesOf(SMALL_MAX_FILES + 1), diff: diffOfAdded(SMALL_MAX_ADDED_LINES) }).bucket, 'medium');
  assert.equal(diffSize({ files: filesOf(SMALL_MAX_FILES), diff: diffOfAdded(SMALL_MAX_ADDED_LINES + 1) }).bucket, 'medium');
});

test('the large bucket needs EITHER many files or many added lines', () => {
  assert.equal(diffSize({ files: filesOf(LARGE_MIN_FILES), diff: '' }).bucket, 'large');
  assert.equal(diffSize({ files: filesOf(1), diff: diffOfAdded(LARGE_MIN_ADDED_LINES) }).bucket, 'large');
  assert.equal(diffSize({ files: filesOf(LARGE_MIN_FILES - 1), diff: diffOfAdded(LARGE_MIN_ADDED_LINES - 1) }).bucket, 'medium');
});

test('a 2-file diff with a large body is large, not small — large is checked first', () => {
  assert.equal(diffSize({ files: filesOf(2), diff: diffOfAdded(LARGE_MIN_ADDED_LINES) }).bucket, 'large');
});

// --- planReview: lanes -----------------------------------------------------------

test('the auditor and the steward run in every bucket', () => {
  for (const plan of [
    planReview({ files: filesOf(1), diff: diffOfAdded(5) }),
    planReview({ files: filesOf(8), diff: diffOfAdded(200) }),
    planReview({ files: filesOf(30), diff: diffOfAdded(2000) }),
  ]) {
    assert.equal(lane(plan, 'auditor').run, true);
    assert.equal(lane(plan, 'steward').run, true);
  }
});

test('the pragmatist is skipped on a small diff and only there', () => {
  const small = planReview({ files: filesOf(1), diff: diffOfAdded(5) });
  assert.equal(lane(small, 'pragmatist').run, false);
  assert.equal(lane(small, 'pragmatist').agents, 0);

  const medium = planReview({ files: filesOf(8), diff: diffOfAdded(200) });
  assert.equal(lane(medium, 'pragmatist').run, true);
});

test('at least two personas survive every plan — synthesis needs two voices', () => {
  // Worst case: small boundary-free diff skips both skippable lanes.
  const plan = planReview({ files: ['src/render/palette.mjs'], diff: diffOfAdded(3) });
  assert.ok(plan.lanes.filter((l) => l.run).length >= 2);
});

test('the adversary follows assessScope: skipped on a boundary-free diff, run on a boundary', () => {
  const clean = planReview({ files: ['src/render/palette.mjs'], diff: diffOfAdded(3) });
  assert.equal(lane(clean, 'adversary').run, false);
  assert.equal(lane(clean, 'adversary').agents, 0);

  const boundary = planReview({ files: ['src/auth/session.mjs'], diff: diffOfAdded(3) });
  assert.equal(lane(boundary, 'adversary').run, true);
});

test('only the per-file lanes split on a large diff, and only there', () => {
  const large = planReview({ files: [...filesOf(20), 'src/auth/session.mjs'], diff: diffOfAdded(50) });
  assert.equal(lane(large, 'auditor').agents, SPLIT_AGENTS);
  assert.equal(lane(large, 'adversary').agents, SPLIT_AGENTS);
  assert.equal(lane(large, 'steward').agents, 1);
  assert.equal(lane(large, 'pragmatist').agents, 1);

  const medium = planReview({ files: filesOf(8), diff: diffOfAdded(200) });
  assert.equal(lane(medium, 'auditor').agents, 1);
});

// --- planReview: pins ------------------------------------------------------------

test('a matched pin forces every lane on, whatever the size', () => {
  const plan = planReview({
    files: ['src/render/palette.mjs'],
    diff: diffOfAdded(3),
    pins: ['render/palette'],
  });
  for (const l of plan.lanes) assert.equal(l.run, true, l.persona);
  assert.equal(plan.pinned.length, 1);
  assert.equal(plan.pinned[0].file, 'src/render/palette.mjs');
});

test('an unmatched pin changes nothing', () => {
  const plan = planReview({ files: ['src/render/palette.mjs'], diff: diffOfAdded(3), pins: ['hw/dma'] });
  assert.deepEqual(plan.pinned, []);
  assert.equal(lane(plan, 'pragmatist').run, false);
});

// --- planReview: defaults --------------------------------------------------------

test('an empty file list gets the full shape — handed nothing is not "found nothing"', () => {
  const plan = planReview({ files: [], diff: '' });
  for (const l of plan.lanes) assert.equal(l.run, true, l.persona);
});

test('rounds and the cap are the full defaults pre-flight, in every bucket', () => {
  for (const plan of [
    planReview({ files: filesOf(1), diff: diffOfAdded(5) }),
    planReview({ files: filesOf(30), diff: diffOfAdded(2000) }),
  ]) {
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

test('no findings at all: round 2 is provably a no-op', () => {
  const r = escalate([payload('auditor', []), payload('steward', [])]);
  assert.equal(r.rounds, 1);
  assert.equal(r.maxIterations, DEFAULT_MAX_ITERATIONS);
});

test('advisory-only findings: round 2 still has nothing blocking to rule on', () => {
  const r = escalate([payload('pragmatist', [finding({ kind: 'design', severity: 'critical' })])]);
  assert.equal(r.rounds, 1);
});

test('a critical design finding never raises the cap — advisory cannot escalate', () => {
  const r = escalate([payload('pragmatist', [finding({ kind: 'design', severity: 'critical' })])]);
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

test('escalate tolerates payloads with no findings array', () => {
  const r = escalate([{ persona: 'auditor' }, null]);
  assert.equal(r.rounds, 1);
});
