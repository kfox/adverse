// Unit tests for src/taxonomy.mjs — the kind and severity axes shared across
// prompts, synthesis, rendering, scaling, and the ledger with no prompt prose.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ADVISORY_KINDS, CONFIDENCES, KINDS, ROOT_CAUSE_STATUSES, SEVERITIES,
         SEVERITY_RANK, assertCoversConfidences } from '../src/taxonomy.mjs';

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
