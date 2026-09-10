// Unit tests for src/taxonomy.mjs — the kind and severity axes shared across
// prompts, synthesis, rendering, scaling, and the ledger with no prompt prose.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ADVISORY_KINDS, CONFIDENCES, KINDS, ROOT_CAUSE_STATUSES, SEVERITIES,
         SEVERITY_RANK, assertCoversConfidences, citesLaneNames,
         claimedLanes } from '../src/taxonomy.mjs';

test('every advisory kind is a real kind', () => {
  for (const k of ADVISORY_KINDS) assert.ok(KINDS.includes(k), `${k} is not in KINDS`);
});

test('design and contract are advisory; defect and behavioral block', () => {
  assert.deepEqual([...ADVISORY_KINDS].sort(), ['contract', 'design']);
  assert.deepEqual(KINDS.filter((k) => !ADVISORY_KINDS.has(k)), ['defect', 'behavioral']);
});

test('severity rank has exactly one entry per severity, and it is a total order', () => {
  assert.deepEqual(Object.keys(SEVERITY_RANK).sort(), [...SEVERITIES].sort());
  const ranks = Object.values(SEVERITY_RANK);
  assert.equal(new Set(ranks).size, ranks.length, 'ranks must be distinct');
});

test('KINDS, ADVISORY_KINDS, SEVERITIES, and SEVERITY_RANK are frozen', () => {
  assert.ok(Object.isFrozen(KINDS));
  assert.ok(Object.isFrozen(ADVISORY_KINDS));
  assert.ok(Object.isFrozen(SEVERITIES));
  assert.ok(Object.isFrozen(SEVERITY_RANK));
});

test('the root-cause status vocabulary has one home', () => {
  // The five names were spelled in three places — synthesis's status ternary
  // and its label map, and html.mjs's — with nothing keeping them in step, so
  // a sixth status added to one would fall back silently in the others.
  assert.deepEqual([...ROOT_CAUSE_STATUSES].sort(),
    ['confirmed', 'contested', 'oversized', 'proposed', 'split']);
  assert.ok(Object.isFrozen(ROOT_CAUSE_STATUSES));
});

// --- The confidence vocabulary ------------------------------------------------
//
// Spelled out in five places before it lived here — synthesis's sort rank, its
// section titles, its bucket map, and html.mjs's two — with nothing keeping
// them in step. A label added to one was a silent gap in the others: a finding
// in no bucket, dropped from the report with no error at all. `demonstrated`
// was the fifth, and this is the check that makes the sixth loud.

test('the confidence vocabulary carries the label a probe buys', () => {
  assert.ok(CONFIDENCES.includes('demonstrated'));
  assert.equal(new Set(CONFIDENCES).size, CONFIDENCES.length);
});

test('a map missing a confidence is refused at load, naming which', () => {
  assert.throws(
    () => assertCoversConfidences({ solo: 1, disputed: 1 }, 'somewhere'),
    /somewhere: confidence labels are out of step with taxonomy; missing demonstrated/);
});

test('a map inventing a confidence is refused too', () => {
  const extra = Object.fromEntries([...CONFIDENCES, 'vibes'].map((c) => [c, 1]));
  assert.throws(() => assertCoversConfidences(extra, 'somewhere'), /unknown vibes/);
});

// Both forms are checked because both are enumerators: html.mjs derives its
// order from the KEYS of its label map, and synthesis keeps a separate ordered
// ARRAY for its sections.
test('an array of labels is checked the same way a map is', () => {
  assert.deepEqual(assertCoversConfidences([...CONFIDENCES], 'somewhere'), [...CONFIDENCES]);
  assert.throws(() => assertCoversConfidences(['solo'], 'somewhere'), /missing/);
});

// What a citation claims, read one way for every reader of one. `null` is the
// answer that means "not lane names", and every caller refuses on it — so the
// table below is also the list of shapes that stop a report being built.
for (const [label, citation, expected] of [
  ['a resolved citation, by the list synthesis put on it',
    { reporters: ['auditor', 'steward'], reporter: 'adversary' }, ['auditor', 'steward']],
  ['an unresolved citation, by the reporter it claimed',
    { reporters: null, reporter: 'adversary' }, ['adversary']],
  // The absence this exists to distinguish from a claim: it used to contribute
  // an `undefined` that serialized as `null`, counted as a reviewer in the PR
  // comment and rendered as the word "null" in the dashboard.
  ['a citation claiming nobody', { reporters: null }, []],
  ['a citation whose only claim is null', { reporter: null }, []],
  // And the values that are claims this tool cannot read. A bare string is the
  // one the whole vocabulary exists for: `"auditor"` is iterable, so a reader
  // that wrapped it in a list would call it one reviewer and a reader that
  // spread it would call it seven.
  ['a reporters that is a string', { reporters: 'auditor' }, null],
  ['a reporters that is an object', { reporters: { lane: 'auditor' } }, null],
  ['a reporter that is a number', { reporter: 42 }, null],
  ['a reporters holding something that is not a lane name', { reporters: ['auditor', 7] }, null],
]) test(`claimedLanes reads ${label}`, () => {
  assert.deepEqual(claimedLanes(citation), expected);
});

// And whether those fields are lane names at all, which is a different
// question from which lanes they name: the reading above prefers `reporters`,
// and both renderers print the singular `reporter` verbatim. A check made of
// only the first passed a citation carrying a good list beside a junk
// singular, which then reached three artifacts as `[object Object]`.
for (const [label, citation, expected] of [
  ['a citation naming lanes in both fields',
    { reporters: ['auditor'], reporter: 'auditor' }, true],
  ['a citation naming nobody at all', {}, true],
  ['a citation whose fields are both null', { reporters: null, reporter: null }, true],
  ['a citation whose singular reporter is junk', { reporter: 42 }, false],
  ['a citation whose list is junk', { reporters: ['auditor', 7] }, false],
  // The one the reading above cannot see, because it stops at `reporters`.
  ['a citation with a good list beside a junk singular',
    { reporters: ['auditor'], reporter: { lane: 'auditor' } }, false],
]) test(`citesLaneNames judges ${label}`, () => {
  assert.equal(citesLaneNames(citation), expected);
});
