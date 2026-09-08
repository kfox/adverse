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

import { NAMED_NOT_FIXED_DISPOSITION, foldFixPayloads } from '../src/decisions.mjs';
import {
  DISPOSITIONS, convergenceStatus, emptyLedger, isSettled, matchFinding, recordDecisions,
} from '../src/ledger.mjs';

const decision = (over = {}) => ({
  id: 'F3', title: 'the guard is unreachable', kind: 'defect', severity: 'critical',
  confidence: 'consensus', file: 'src/auth.py', line: 88, counterpart: null,
  reason: 'restored the guard', ...over,
});

const namedItem = (over = {}) => ({
  title: 'preflight_emu is not budgeted', kind: 'behavioral',
  file: 'src/budget.py', line: 41, counterpart: null,
  detail: 'noticed while reproducing F3; the preflight run is not counted anywhere',
  suggestion: null, ...over,
});

const payload = (over = {}) => ({
  agent: 'fix-auth-guard', commits: ['abc1234'],
  fixed: [{ ...decision(), commit: 'abc1234', mutations: [] }],
  declined: [], named_not_fixed: [],
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
  assert.equal(d.commit, undefined, 'the payload key is not carried through under its own name');
  assert.equal(d.fixCommit, 'abc1234');

  // The batch label, under a name that claims nothing about who reported the
  // finding. This assertion read `d.reporters` — so the fold's own contract
  // said the batch that FIXED a finding was the lane that REPORTED it, and the
  // one field a regression pass could have excused a lane on named the only
  // party with a stake in the answer (kfox/adverse#58, item 6).
  assert.equal(d.agent, 'fix-auth-guard');
  assert.equal(d.reporters, undefined,
    'the lanes are derived from the report at record time, never folded from a payload');
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
  assert.equal(d.disposition, 'noted');
  assert.equal(d.title, 'preflight_emu is not budgeted');
  assert.equal(d.reason, namedItem().detail);
  assert.equal(d.agent, 'fix-auth-guard');
  // Nobody reported it and no commit closed it: the batch noticed it, which is
  // the whole of what is known about where it came from.
  assert.equal(d.reporters, undefined);
  assert.equal(d.fixCommit, null);
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
    () => foldFixPayloads([payload({
      fixed: [{ ...decision({ reason: '' }), commit: 'abc1234', mutations: [] }],
    })]),
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
  assert.ok(hit, 'the noted entry did not match the finding it was recorded to answer');
  assert.equal(hit.entry.disposition, 'noted');
  assert.match(hit.entry.reason, /the preflight run is not counted anywhere/);
});

// The other half of the channel's contract, and the one it got wrong. An item
// a fix agent merely NAMED must not close the question: `FIX_INSTRUCTIONS`
// tells the agent to copy `title`, `kind`, `file` and `line` verbatim from the
// briefing, so an identical title is this channel's designed behavior — which
// made "only an identical title settles" a protection that was never there.
test('a named-not-fixed footnote cannot close the blocking finding it names', () => {
  const critical = {
    id: 'F2', title: 'the drain loop never bounds its work budget', kind: 'behavioral',
    severity: 'critical', confidence: 'cross-validated', file: 'src/drain.mjs', line: 88,
    counterpart: null, blocking: true, cross_examined: true,
  };
  const decisions = foldFixPayloads([payload({
    fixed: [],
    named_not_fixed: [namedItem({
      // Verbatim from the briefing, exactly as the fix prompt instructs.
      title: critical.title, kind: critical.kind, file: critical.file, line: critical.line,
    })],
  })]);
  assert.equal(isSettled(decisions[0].disposition), false,
    `${decisions[0].disposition} settles, so this footnote closed a critical`);

  const ledger = recordDecisions(emptyLedger(), decisions, { atCommit: 'deadbee' });
  const status = convergenceStatus({ findings: [critical] }, ledger);
  assert.equal(status.done, false, 'the loop converged with a critical only footnoted');
  assert.equal(status.open.length, 1);
  assert.equal(status.settled.length, 0);

  // …and it still annotates, which is the reason the channel exists at all.
  const [annotated] = status.open;
  assert.equal(annotated.adjudicated.matchedId, 'NF-fix-auth-guard-1');
  assert.match(annotated.adjudicated.reason, /the preflight run is not counted anywhere/);
});

test('a contract item carries its counterpart, so it can answer the finding', () => {
  // `scoreMatch`'s contract guard sits ABOVE the title branch, so an entry
  // folded with a hardcoded `counterpart: null` against a finding that names
  // one matched nothing ever again — and `contract` is the likeliest kind for a
  // list of things noticed and left alone.
  const item = namedItem({
    title: 'SKILL.md promises a pass nobody runs', kind: 'contract',
    file: 'SKILL.md', line: 41, counterpart: 'src/regression.mjs',
  });
  const [d] = foldFixPayloads([payload({ fixed: [], named_not_fixed: [item] })]);
  assert.equal(d.counterpart, 'src/regression.mjs');

  const ledger = recordDecisions(emptyLedger(), [d], { atCommit: 'deadbee' });
  const hit = matchFinding(ledger, {
    title: item.title, kind: 'contract', severity: 'warning',
    file: 'SKILL.md', line: 41, counterpart: 'src/regression.mjs',
  });
  assert.ok(hit, 'a contract item still cannot answer the finding it was recorded for');
  assert.equal(hit.entry.disposition, NAMED_NOT_FIXED_DISPOSITION);
  // The discriminating case: a DIFFERENT counterpart is a different claim.
  assert.equal(matchFinding(ledger, {
    title: item.title, kind: 'contract', severity: 'warning',
    file: 'SKILL.md', line: 41, counterpart: 'README.md',
  }), null);
});

test('a declined entry\'s commit is not dropped here — it reaches the ledger\'s refusal', () => {
  // `validateFix` refuses this payload first, and this file keeps its own
  // guards precisely for a caller that skipped the validator. Dropping the
  // field would be the silent direction: the decision records clean and the
  // one thing wrong with it — a decline asserting a fix commit — is gone.
  const [d] = foldFixPayloads([payload({
    fixed: [],
    declined: [{ ...decision({ reason: 'reproduced; unreachable' }), commit: 'abc1234' }],
  })]);
  assert.equal(d.fixCommit, 'abc1234', 'carried, so the ledger can refuse it');
  assert.throws(() => recordDecisions(emptyLedger(), [d], { atCommit: 'deadbee' }),
    /only a fixed decision closes a finding with a commit/);
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
