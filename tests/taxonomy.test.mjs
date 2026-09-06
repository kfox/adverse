// Unit tests for src/taxonomy.mjs — the kind and severity axes shared across
// prompts, synthesis, rendering, scaling, and the ledger with no prompt prose.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ADVISORY_KINDS, KINDS, ROOT_CAUSE_STATUSES, SEVERITIES, SEVERITY_RANK } from '../src/taxonomy.mjs';

test('every advisory kind is a real kind', () => {
  for (const k of ADVISORY_KINDS) assert.ok(KINDS.includes(k), `${k} is not in KINDS`);
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
