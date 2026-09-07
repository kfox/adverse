// Tests for src/briefing.mjs — assembling the round-2 prompt.
//
// These are the properties that used to need a subprocess and a throwaway git
// repo to observe, because the assembly lived in the triage bridge behind
// argv: that a claim-checked, under-anchored or adjudicated finding actually
// ARRIVES in briefing.json rather than being dropped on the way, and that the
// counts the bridge prints describe the same run the file does.
//
// The repository is injected, so nothing here shells out. `checkClaim` and
// `checkCounterpart` are the seams src/triage.mjs's own tests already cover
// against a real checkout; what is under test here is the wiring.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildBriefing } from '../src/briefing.mjs';
import { emptyLedger } from '../src/ledger.mjs';

const ok = () => ({ status: 'ok', inDiff: 'inside' });
const checks = { checkClaim: ok, checkCounterpart: ok };
const build = (reviews, opts = {}) =>
  buildBriefing(reviews, { base: 'base', ...checks, ...opts });

const review = (persona, findings, over = {}) =>
  ({ persona, verdict: 'conditional', summary: `${persona} says so`, findings, ...over });
const finding = (over = {}) => ({
  severity: 'warning', kind: 'defect', file: 'app.py', line: 20,
  counterpart: null, title: 't', detail: 'd', fix: null, ...over,
});

test('the gate summary is carried into the briefing verbatim', () => {
  const { briefing } = build([review('auditor', [])], { gate: 'make test: green' });
  assert.equal(briefing.gate, 'make test: green');
});

test('no gate is null, not absent — a reviewer must be able to tell', () => {
  const { briefing } = build([review('auditor', [])]);
  assert.equal(briefing.gate, null);
});

test('ids are assigned across reviewers in the order they were passed', () => {
  const { briefing } = build([
    review('auditor', [finding(), finding()]),
    review('adversary', [finding()]),
  ]);
  assert.deepEqual(briefing.findings.map((f) => f.id), ['F1', 'F2', 'F3']);
  assert.deepEqual(briefing.findings.map((f) => f.reporter),
    ['auditor', 'auditor', 'adversary']);
});

// --- which AGENT reported it -------------------------------------------------
//
// A split lane's round-2 agent is handed both halves of its own persona's work.
// Without this field it reads all of it as its own prior work and passes the
// lot through unexamined — half the cost kfox/adverse#50 names — because the
// persona name is identical on both halves by design.

test('every finding names the agent that reported it, split lane or not', () => {
  const { briefing } = build([
    review('auditor', [finding()], { agent: 'auditor-a' }),
    review('auditor', [finding()], { agent: 'auditor-b' }),
    review('steward', [finding()]),
  ]);
  assert.deepEqual(briefing.findings.map((f) => f.reporterAgent),
    ['auditor-a', 'auditor-b', 'steward']);
  // Always present, equal to `reporter` for an unsplit lane: a field that
  // appears only sometimes is one every consumer has to guess about.
  assert.deepEqual(briefing.findings.map((f) => f.reporter),
    ['auditor', 'auditor', 'steward']);
});

test('an agent id naming another lane falls back to the lane it arrived under', () => {
  // A bad id reads as the whole lane's work, which gets examined. Trusting it
  // would put a stranger's name on the entry instead.
  const { briefing } = build([
    review('auditor', [finding()], { agent: 'steward-a' }),
    review('auditor', [finding()], { agent: 'auditor_b' }),
  ]);
  assert.deepEqual(briefing.findings.map((f) => f.reporterAgent), ['auditor', 'auditor']);
});

// --- annotated, never dropped ------------------------------------------------
//
// The property every kind check shares: a finding that fails one is reported
// with the failure attached, because only a reviewer can tell a careless label
// from a real defect.

test('an under-anchored defect reaches the briefing carrying its own verdict', () => {
  const { briefing } = build([review('auditor', [finding({ line: null })])]);
  assert.equal(briefing.findings.length, 1);
  assert.equal(briefing.findings[0].kindCheck.status, 'UNDER-ANCHORED');
  assert.deepEqual(briefing.findings[0].kindCheck.missing, ['line']);
});

test('a contract finding with no counterpart reaches the briefing under-anchored', () => {
  const { briefing } = build([review('steward', [finding({ kind: 'contract' })])]);
  assert.deepEqual(briefing.findings[0].kindCheck.missing, ['counterpart']);
});

test('a missing kind and an invented kind both survive as annotations', () => {
  const { briefing } = build([review('auditor', [
    finding({ kind: undefined }), finding({ kind: 'vibes' }),
  ])]);
  assert.deepEqual(briefing.findings.map((f) => f.kindCheck.status), ['MISSING', 'UNKNOWN']);
  assert.equal(briefing.findings.length, 2);
});

test('a design finding is anchor-free and flagged advisory, and is counted as such', () => {
  const { briefing, stats } = build([review('pragmatist',
    [finding({ kind: 'design', file: null, line: null })])]);
  assert.equal(briefing.findings[0].kindCheck.status, 'ok');
  assert.equal(briefing.findings[0].kindCheck.advisory, true);
  assert.equal(stats.advisory.length, 1);
});

test('kindCheck and counterpartCheck both land on the same finding', () => {
  const { briefing } = build([review('steward',
    [finding({ kind: 'contract', counterpart: 'docs/app.md' })])]);
  assert.equal(briefing.findings[0].kindCheck.status, 'ok');
  assert.equal(briefing.findings[0].counterpartCheck.status, 'ok');
});

test('a disproved claim is annotated on the finding and counted for the summary', () => {
  const disprove = () => ({ status: 'DISPROVED', why: 'no such line' });
  const { briefing, stats } = build([review('auditor', [finding()])],
    { checkClaim: disprove });
  assert.equal(briefing.findings[0].claimCheck.status, 'DISPROVED');
  assert.deepEqual(stats.disproved.map((f) => f.id), ['F1']);
});

test('a finding cited outside the diff is annotated, never rejected', () => {
  const outside = () => ({ status: 'ok', inDiff: 'outside' });
  const { briefing, stats } = build([review('auditor', [finding()])],
    { checkClaim: outside });
  assert.equal(briefing.findings.length, 1);
  assert.deepEqual(stats.outside.map((f) => f.id), ['F1']);
});

test('a coerced-away anchor is recorded on the finding, not only in the summary', () => {
  const { briefing, stats } = build([review('auditor', [finding({ line: 'twenty' })])]);
  assert.equal(briefing.findings[0].line, null);
  assert.deepEqual(briefing.findings[0].rejectedAnchors, ['line']);
  assert.deepEqual(stats.rejectedAnchors, ['F1.line']);
});

test('a finding that supplied a clean anchor carries no rejection marker', () => {
  const { briefing } = build([review('auditor', [finding()])]);
  assert.equal(briefing.findings[0].rejectedAnchors, undefined);
});

// --- the edges, and what they imply ------------------------------------------

test('the briefing carries the root-cause groups the edges imply, with their fanout', () => {
  const { briefing } = build([
    review('auditor', [finding({ line: 20, severity: 'critical', title: 'the worst one' })]),
    review('adversary', [finding({ line: 25 })]),
    review('steward', [finding({ file: 'docs/app.md', line: 1, kind: 'contract',
      counterpart: 'app.py', detail: 'app.py line 20 disagrees with this' })]),
  ]);
  assert.equal(briefing.groups.length, 1);
  assert.deepEqual(briefing.groups[0].members, ['F1', 'F2', 'F3']);
  assert.deepEqual(briefing.groups[0].reporters, ['auditor', 'adversary', 'steward']);
  assert.equal(briefing.groups[0].title, 'the worst one');
  assert.equal(briefing.groups[0].citations.length, 3);
});

test('unrelated findings produce no groups, and the briefing says so', () => {
  const { briefing } = build([
    review('auditor', [finding({ file: 'a.py', line: 1, detail: 'no citation' })]),
    review('adversary', [finding({ file: 'b.py', line: 90, detail: 'nor here' })]),
  ]);
  assert.deepEqual(briefing.groups, []);
  assert.deepEqual(briefing.clusters, []);
});

test('two reporters in one file far apart are reported as sharing it, not as a cluster', () => {
  const { briefing } = build([
    review('auditor', [finding({ line: 2 })]),
    review('adversary', [finding({ line: 38 })]),
  ]);
  assert.deepEqual(briefing.clusters, []);
  assert.deepEqual(briefing.sameFileDifferentRegion, [{ file: 'app.py', ids: ['F1', 'F2'] }]);
});

test('one reporter twice in a file is not two voices sharing it', () => {
  const { briefing } = build([review('auditor', [
    finding({ line: 2 }), finding({ line: 38 }),
  ])]);
  assert.deepEqual(briefing.sameFileDifferentRegion, []);
});

// --- verdicts ----------------------------------------------------------------

test('a split lane\'s two payloads merge into one verdict — the worse one, both summaries', () => {
  const { briefing } = build([
    review('auditor', [], { verdict: 'approve', summary: 'half one' }),
    review('auditor', [], { verdict: 'reject', summary: 'half two' }),
  ]);
  assert.equal(briefing.verdicts.auditor.verdict, 'reject');
  assert.match(briefing.verdicts.auditor.summary, /half one/);
  assert.match(briefing.verdicts.auditor.summary, /half two/);
});

test('an off-contract verdict is normalized before a reviewer reads it', () => {
  const { briefing } = build([review('auditor', [], { verdict: 'looks fine to me' })]);
  assert.equal(briefing.verdicts.auditor.verdict, 'reject');
});

test('verdicts are keyed on a null-prototype object, so `__proto__` cannot vanish a lane', () => {
  const { briefing } = build([review('auditor', [])]);
  assert.equal(Object.getPrototypeOf(briefing.verdicts), null);
});

// --- what an earlier iteration already decided -------------------------------

// The same entry shape tests/ledger.test.mjs uses — `annotate` matches on more
// than the id, so a thinner fixture silently matches nothing.
const ledgerWith = (entry) => ({ ...emptyLedger('base'), entries: [entry] });
const settledEntry = (over = {}) => ({
  id: 'F1', title: 't', kind: 'defect', severity: 'warning',
  file: 'app.py', line: 20, counterpart: null, citedLine: null,
  disposition: 'declined', reason: 'intentional', iteration: 1, atCommit: 'abc123', ...over,
});

test('with no ledger, nothing is adjudicated and both id lists are empty', () => {
  const { briefing } = build([review('auditor', [finding()])], { ledger: emptyLedger() });
  assert.equal(briefing.findings[0].adjudicated, undefined);
  assert.deepEqual(briefing.settled, []);
  assert.deepEqual(briefing.regressed, []);
});

test('a settled finding is marked on the finding AND listed by id', () => {
  const { briefing, stats } = build([review('auditor', [finding()])],
    { ledger: ledgerWith(settledEntry()) });
  assert.equal(briefing.findings[0].adjudicated.settled, true);
  assert.deepEqual(briefing.settled, ['F1']);
  assert.deepEqual(briefing.regressed, []);
  assert.deepEqual(stats.settled.map((f) => f.id), ['F1']);
});

test('a finding recorded fixed that comes back is listed regressed, not settled', () => {
  const { briefing } = build([review('auditor', [finding()])],
    { ledger: ledgerWith(settledEntry({ disposition: 'fixed' })) });
  assert.equal(briefing.findings[0].adjudicated.settled, false);
  assert.deepEqual(briefing.regressed, ['F1']);
  assert.deepEqual(briefing.settled, []);
});

test('the id lists name findings that are still present, never replace them', () => {
  const { briefing } = build([review('auditor', [finding()])],
    { ledger: ledgerWith(settledEntry()) });
  assert.equal(briefing.findings.length, 1);
  assert.deepEqual(briefing.settled, briefing.findings.filter((f) => f.adjudicated?.settled)
    .map((f) => f.id));
});

// --- the summary describes the same run as the file --------------------------

test('stats count the reviewers that were passed, not the personas that survived', () => {
  const { stats } = build([
    review('auditor', [], { verdict: 'approve', summary: 'a' }),
    review('auditor', [], { verdict: 'approve', summary: 'b' }),
  ]);
  assert.equal(stats.reviewers, 2);
  assert.equal(Object.keys(build([
    review('auditor', [], { summary: 'a' }),
    review('auditor', [], { summary: 'b' }),
  ]).briefing.verdicts).length, 1);
});

test('every stats list holds findings drawn from the briefing, not copies of them', () => {
  const { briefing, stats } = build([review('auditor', [finding({ line: null })])]);
  assert.equal(stats.underAnchored[0], briefing.findings[0]);
});
