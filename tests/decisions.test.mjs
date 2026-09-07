// Unit tests for src/decisions.mjs — folding fix-agent payloads into the
// decisions the ledger records.
//
// The property that matters is not the shape of the output object. It is that
// a `named_not_fixed` entry survives the trip: it arrives with no finding id,
// and it has to leave with one, a disposition, and the agent's own reasoning
// attached — because the alternative, measured, is two round-1 reviewers
// spending an iteration re-deriving it.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { foldFixPayloads } from '../src/decisions.mjs';
import { DISPOSITIONS, matchFinding, recordDecisions, emptyLedger } from '../src/ledger.mjs';

const decision = (over = {}) => ({
  id: 'F3', title: 'the guard is unreachable', kind: 'defect', severity: 'critical',
  confidence: 'consensus', file: 'src/auth.py', line: 88, counterpart: null,
  reason: 'restored the guard', ...over,
});

const namedItem = (over = {}) => ({
  title: 'preflight_emu is not budgeted', kind: 'behavioral',
  file: 'src/budget.py', line: 41,
  detail: 'noticed while reproducing F3; the preflight run is not counted anywhere',
  suggestion: null, ...over,
});

const payload = (over = {}) => ({
  agent: 'fix-auth-guard', commits: ['abc1234'],
  fixed: [{ ...decision(), mutations: [] }], declined: [], named_not_fixed: [],
  ...over,
});

test('a fixed entry becomes a `fixed` decision carrying every identity field', () => {
  const [d] = foldFixPayloads([payload()]);
  assert.equal(d.disposition, 'fixed');
  assert.equal(d.id, 'F3');
  assert.equal(d.kind, 'defect');
  assert.equal(d.severity, 'critical');
  assert.equal(d.confidence, 'consensus');
  assert.equal(d.file, 'src/auth.py');
  assert.equal(d.line, 88);
  assert.equal(d.reason, 'restored the guard');
  assert.deepEqual(d.reporters, ['fix-auth-guard']);
});

test('a declined entry becomes a `declined` decision, not a fixed one', () => {
  const [d] = foldFixPayloads([payload({
    fixed: [], declined: [decision({ reason: 'reproduced it; unreachable from any caller' })],
  })]);
  assert.equal(d.disposition, 'declined');
  assert.equal(d.reason, 'reproduced it; unreachable from any caller');
});

test('a named-not-fixed item leaves with an id it arrived without', () => {
  const [d] = foldFixPayloads([payload({ fixed: [], named_not_fixed: [namedItem()] })]);
  assert.equal(d.id, 'NF-fix-auth-guard-1');
  assert.equal(d.disposition, 'deferred');
  assert.equal(d.title, 'preflight_emu is not budgeted');
  assert.equal(d.reason, namedItem().detail);
  assert.deepEqual(d.reporters, ['fix-auth-guard']);
});

test('a minted id cannot be mistaken for a triage finding or a root cause', () => {
  const ids = foldFixPayloads([payload({
    fixed: [], named_not_fixed: [namedItem(), namedItem({ title: 'second' })],
  })]).map((d) => d.id);
  assert.deepEqual(ids, ['NF-fix-auth-guard-1', 'NF-fix-auth-guard-2']);
  // triage mints F<n> for findings and G<n> for root causes; nothing here may
  // land in either namespace, or a decision answers a finding it never saw.
  for (const id of ids) assert.doesNotMatch(id, /^[FG]\d+$/);
});

test('two batches folded together cannot mint the same id for different items', () => {
  const ids = foldFixPayloads([
    payload({ fixed: [], named_not_fixed: [namedItem()] }),
    payload({ agent: 'fix-budget', fixed: [], named_not_fixed: [namedItem({ title: 'other' })] }),
  ]).map((d) => d.id);
  assert.equal(new Set(ids).size, 2, 'ids collided across batches');
  assert.deepEqual(ids, ['NF-fix-auth-guard-1', 'NF-fix-budget-1']);
});

test("a suggestion rides along in the reason — it is the only field the ledger keeps", () => {
  const [d] = foldFixPayloads([payload({
    fixed: [], named_not_fixed: [namedItem({ suggestion: 'budget it in preflight_cost()' })],
  })]);
  assert.match(d.reason, /noticed while reproducing F3/);
  assert.match(d.reason, /Suggested: budget it in preflight_cost\(\)/);
});

test('an item with no detail is refused here, not left to die inside the ledger', () => {
  // recordDecisions throws on a reasonless decision three frames downstream, in
  // a message that names the ledger rather than the payload that caused it.
  assert.throws(
    () => foldFixPayloads([payload({ fixed: [], named_not_fixed: [namedItem({ detail: '  ' })] })]),
    /preflight_emu is not budgeted.*no reason/s);
  assert.throws(
    () => foldFixPayloads([payload({ fixed: [{ ...decision({ reason: '' }), mutations: [] }] })]),
    /no reason/);
});

test('a payload with no agent label is refused — every decision names its reporter', () => {
  assert.throws(() => foldFixPayloads([payload({ agent: '  ' })]), /`agent` label/);
  assert.throws(() => foldFixPayloads([{}]), /`agent` label/);
});

test('every disposition minted is one the ledger accepts', () => {
  const decisions = foldFixPayloads([payload({
    declined: [decision({ title: 'b', reason: 'left it' })],
    named_not_fixed: [namedItem()],
  })]);
  assert.equal(decisions.length, 3);
  for (const d of decisions) {
    assert.ok(DISPOSITIONS.includes(d.disposition), `${d.disposition} is not a disposition`);
  }
});

// The point of the whole channel: the entry has to be able to ANSWER the
// finding a later panel raises, not merely exist. `scoreMatch` gates on kind
// equality before it looks at anything else, so an entry with a null kind is
// invisible to every finding triage produces.
test('a recorded named-not-fixed entry matches the finding a later panel raises', () => {
  const decisions = foldFixPayloads([payload({ fixed: [], named_not_fixed: [namedItem()] })]);
  const ledger = recordDecisions(emptyLedger(), decisions, { atCommit: 'deadbee' });

  const raisedNextIteration = {
    kind: 'behavioral', severity: 'warning', file: 'src/budget.py', line: 41,
    title: 'preflight_emu is not budgeted', counterpart: null,
  };
  const hit = matchFinding(ledger, raisedNextIteration);
  assert.ok(hit, 'the deferred entry did not match the finding it was recorded to answer');
  assert.equal(hit.entry.disposition, 'deferred');
  assert.match(hit.entry.reason, /the preflight run is not counted anywhere/);
});

test('recordDecisions accepts a folded batch whole', () => {
  const decisions = foldFixPayloads([payload({
    declined: [decision({ title: 'b', reason: 'left it' })],
    named_not_fixed: [namedItem()],
  })]);
  const ledger = recordDecisions(emptyLedger(), decisions, { atCommit: 'deadbee' });
  assert.equal(ledger.entries.length, 3);
  assert.equal(ledger.iterations.at(-1).decided, 3);
});
