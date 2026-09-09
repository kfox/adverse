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

import {
  NAMED_NOT_FIXED_DISPOSITION, foldFixPayloads, reconciliations,
} from '../src/decisions.mjs';
import {
  DISPOSITIONS, convergenceStatus, emptyLedger, isSettled, matchFinding, recordDecisions,
  uncoveredDecisions,
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

test('a folded named-not-fixed item is exempt from the coverage check by construction', () => {
  // The two halves of one fact, in the two modules that hold it. `--record`
  // refuses a decision matching no finding in the report, and every entry this
  // channel mints matches none: no lane reported the item, so the report has
  // never seen it. If the disposition minted here and the one exempted there
  // ever drift apart, every iteration that used this channel is refused and the
  // loop stops dead — which is why neither file spells `noted` twice.
  const decisions = foldFixPayloads([payload({
    fixed: [], named_not_fixed: [namedItem(), namedItem({ title: 'a second footnote' })],
  })]);
  assert.equal(decisions.length, 2);
  assert.deepEqual(uncoveredDecisions(decisions, { findings: [] }), []);
});

test('a folded fixed entry is NOT exempt — it asserts a change to something reported', () => {
  // The discriminating half. An exemption that covered the whole fold would
  // make the check unreachable from the loop's own path, which is the only
  // path it runs on.
  const [d] = foldFixPayloads([payload()]);
  const [uncovered] = uncoveredDecisions([d], { findings: [] });
  assert.equal(uncovered.disposition, 'fixed');
  assert.match(uncovered.why, /no finding in the report carries this title/);
});

// --- the identity a decision carries is the REPORT's ------------------------
//
// A fix agent copies its briefing entry verbatim, because that is what
// `fix.txt` tells it to do. The briefing is per-lane and the report is merged,
// so the two disagree on exactly the fields `scoreMatch` guards, and it is the
// report's copy the ledger has to carry — a merged report is what every later
// pass matches against.

const merged = {
  findings: [{
    title: 'the guard is unreachable', kind: 'defect', severity: 'critical',
    file: 'src/auth.py', line: 88, counterpart: null, reporters: ['auditor', 'pragmatist'],
  }],
};

// What the Pragmatist's lane wrote, before synthesis merged the Auditor's copy
// over it: no file, and an advisory kind.
const briefedByOneLane = decision({
  kind: 'design', severity: 'warning', file: null, line: null,
});

test('a folded decision takes the report\'s identity where a lane merge moved it', () => {
  const [d] = foldFixPayloads(
    [payload({ fixed: [{ ...briefedByOneLane, commit: 'abc1234', mutations: [] }] })],
    { report: merged });
  assert.equal(d.kind, 'defect', 'an advisory kind here matches no blocking finding, ever');
  assert.equal(d.file, 'src/auth.py');
  assert.equal(d.line, 88);
  // Severity is NOT corrected. `scoreMatch`'s title branch never reads it, so
  // the match does not need it, and it is the one field here stated as a
  // judgment rather than copied as an anchor.
  assert.equal(d.severity, 'warning', "the operator's own severity, not the report's");
  // The title is the binding, not a field to correct: it is what identifies the
  // finding, and `upsert` merges on it so a report carries at most one.
  assert.equal(d.title, 'the guard is unreachable');
  assert.deepEqual(uncoveredDecisions([d], merged), [], 'and it now settles what it decided');
});

test('without a report the payload\'s own copy stands, and it matches nothing', () => {
  // The measured cost of the old behavior, which is why the bridge warns when
  // --report is absent rather than treating it as an ordinary option.
  const [d] = foldFixPayloads(
    [payload({ fixed: [{ ...briefedByOneLane, commit: 'abc1234', mutations: [] }] })]);
  assert.equal(d.kind, 'design');
  const [uncovered] = uncoveredDecisions([d], merged);
  assert.match(uncovered.why, /the kinds differ \(design here, defect in the report\)/);
});

test('a named-not-fixed item is never reconciled — the report has never seen it', () => {
  const [d] = foldFixPayloads(
    [payload({ fixed: [], named_not_fixed: [namedItem()] })], { report: merged });
  assert.equal(d.kind, 'behavioral', 'the agent\'s own classification, untouched');
  assert.equal(d.file, 'src/budget.py');
  assert.equal(d.severity, null, 'nobody triaged it, so it claims no severity');
});

test('reconciliations names every field it changed, so the rewrite is readable', () => {
  const p = [payload({ fixed: [{ ...briefedByOneLane, commit: 'abc1234', mutations: [] }] })];
  const [change] = reconciliations(p, merged);
  assert.equal(change.bound, true);
  assert.equal(change.agent, 'fix-auth-guard');
  assert.deepEqual(change.fields.map((f) => f.field).sort(), ['file', 'kind', 'line']);
  assert.deepEqual(change.fields.find((f) => f.field === 'kind'),
    { field: 'kind', from: 'design', to: 'defect' });
});

test('an entry whose title is in no finding is named as unbound, not silently kept', () => {
  // This is what `converge.mjs --record --report` is about to refuse. Naming it
  // here is naming it at the earlier of the two moments the operator can act.
  const p = [payload({ fixed: [{ ...decision({ title: 'a title nobody filed' }), commit: 'abc1234', mutations: [] }] })];
  const [change] = reconciliations(p, merged);
  assert.equal(change.bound, false);
  assert.deepEqual(change.fields, []);
});

test('an unchanged entry is not reported as reconciled', () => {
  // Otherwise every decision in an ordinary batch is listed as corrected, and a
  // block that fires on every run is a block nobody reads.
  const alreadyRight = decision({
    title: 'the guard is unreachable', kind: 'defect', severity: 'critical',
    file: 'src/auth.py', line: 88,
  });
  const p = [payload({ fixed: [{ ...alreadyRight, commit: 'abc1234', mutations: [] }] })];
  assert.deepEqual(reconciliations(p, merged), []);
});

test('the fold refuses a file that is not a synthesis report', () => {
  assert.throws(() => foldFixPayloads([payload()], { report: { version: 1, entries: [] } }),
    /not a synthesis report/);
});

test('a mis-copied title cannot move a decision onto the finding it names', () => {
  // The transposition case, and the reason binding is not title-alone. A title
  // IS the identity here, so a fix agent that copies the wrong one would have
  // its decision rewritten onto the other finding and SETTLE it — turning the
  // safe failure (matches nothing, comes back) into the unsafe one (a finding
  // nobody examined, closed). A stated anchor that disagrees is the signal.
  const report = {
    findings: [
      { title: 'the guard is unreachable', kind: 'defect', severity: 'critical',
        file: 'src/a.c', line: 10, counterpart: null, reporters: ['auditor'] },
      { title: 'the retry loop never exits', kind: 'defect', severity: 'critical',
        file: 'src/b.c', line: 400, counterpart: null, reporters: ['adversary'] },
    ],
  };
  // Decided at src/a.c:10; the title copied is the OTHER finding's.
  const transposed = decision({
    title: 'the retry loop never exits', file: 'src/a.c', line: 10,
  });

  const [d] = foldFixPayloads(
    [payload({ fixed: [], declined: [transposed] })], { report });
  assert.equal(d.file, 'src/a.c', 'the anchor the operator actually examined');
  assert.equal(d.line, 10);
  assert.deepEqual(reconciliations([payload({ fixed: [], declined: [transposed] })], report),
    [{ agent: 'fix-auth-guard', title: 'the retry loop never exits', disposition: 'declined',
       bound: false, fields: [] }]);

  // And it is reported rather than silently settling the wrong finding.
  const [uncovered] = uncoveredDecisions([d], report);
  assert.ok(uncovered, 'a transposed title must not settle anything');
});

test('a null anchor is no claim, so the legitimate merge case still binds', () => {
  // The discriminating half of the guard above. `upsert` fills `file`, `line`
  // and `counterpart` from whichever lane supplied them and never overwrites a
  // value another lane already stated — so a briefing entry's NULL anchor is
  // the ordinary shape of the case this correction exists for.
  const report = {
    findings: [{
      title: 'the guard is unreachable', kind: 'defect', severity: 'critical',
      file: 'src/auth.py', line: 88, counterpart: null, reporters: ['auditor', 'pragmatist'],
    }],
  };
  const [d] = foldFixPayloads([payload({
    fixed: [{ ...decision({ kind: 'design', file: null, line: null }), commit: 'abc1234', mutations: [] }],
  })], { report });
  assert.equal(d.kind, 'defect');
  assert.equal(d.file, 'src/auth.py');
  assert.equal(d.line, 88);
});

test('a decision already on record is covered even when the report has never seen it', () => {
  // The `noted`-then-decided path, at the unit level: the ledger is consulted
  // beside the report because a decision may be answering something already
  // recorded rather than something the panel just filed.
  const item = {
    title: 'preflight_emu is not budgeted', kind: 'behavioral', severity: null,
    file: 'src/budget.py', line: 41, counterpart: null,
  };
  const ledger = recordDecisions(emptyLedger(),
    [{ ...item, disposition: 'noted', reason: 'out of scope' }], { atCommit: 'deadbee' });

  const later = [{ ...item, disposition: 'declined', reason: 'budgeted upstream after all' }];
  assert.deepEqual(uncoveredDecisions(later, { findings: [] }, { ledger }), []);
  // Without the ledger it is uncovered, which is what makes the exemption real
  // rather than the check being unable to see anything at all.
  assert.equal(uncoveredDecisions(later, { findings: [] }).length, 1);
});

test('a line the merge moved does not refuse the correction it came for', () => {
  // `scoreMatch`'s title branch never reads `line`, so a stale one cannot
  // settle the wrong finding — and treating it as an anchor refused a match on
  // title AND file, which both cried wolf and left the stale `kind` in the
  // ledger, the one thing `--report` was added to correct.
  const report = {
    findings: [{
      title: 'the guard is unreachable', kind: 'defect', severity: 'critical',
      file: 'src/auth.py', line: 88, counterpart: null, reporters: ['auditor', 'pragmatist'],
    }],
  };
  const stale = decision({ kind: 'design', file: 'src/auth.py', line: 92 });
  const payloads = [payload({ fixed: [], declined: [stale] })];

  const [d] = foldFixPayloads(payloads, { report });
  assert.equal(d.kind, 'defect', 'the correction this path exists to make');
  assert.equal(d.line, 88);
  assert.deepEqual(uncoveredDecisions([d], report), []);

  const [change] = reconciliations(payloads, report);
  assert.equal(change.bound, true);
  assert.deepEqual(change.fields.map((f) => f.field).sort(), ['kind', 'line']);
});

test('a stated file that disagrees still refuses to bind', () => {
  // The discriminating half: `file` stays an anchor because a stated one that
  // differs can mean a different finding, and settling one nobody examined is
  // the silent failure. Noisy over silent.
  const report = {
    findings: [{
      title: 'the guard is unreachable', kind: 'defect', severity: 'critical',
      file: 'src/auth.py', line: 88, counterpart: null, reporters: ['auditor'],
    }],
  };
  const elsewhere = decision({ kind: 'design', file: 'src/session.py', line: 12 });
  const [d] = foldFixPayloads([payload({ fixed: [], declined: [elsewhere] })], { report });
  assert.equal(d.file, 'src/session.py');
  assert.equal(d.kind, 'design', 'nothing bound, so nothing was corrected');
  assert.equal(uncoveredDecisions([d], report).length, 1);
});

// --- a `noted` identity is the ledger's one vouching token -------------------
//
// `onNotedRecord` grants `uncoveredDecisions`' single exemption to any decision
// a recorded `noted` entry matches at SETTLING_SCORE, and this file is where
// those entries are minted — out of fields a fix agent supplies. So what the
// fold will and will not mint is what decides whether the party being checked
// can write its own exemption.

test('a named-not-fixed item takes the report\'s identity where the report has it', () => {
  // `fix.txt` sends an ASSIGNED finding here whenever a batch leaves one for
  // later, so the report frequently does carry the item — and the briefing the
  // agent copied is per-lane while the report is merged. This list used to skip
  // the correction the other two dispositions get.
  const [d] = foldFixPayloads([payload({
    fixed: [],
    named_not_fixed: [namedItem({
      title: 'the guard is unreachable', kind: 'design', file: null, line: null,
    })],
  })], { report: merged });
  assert.equal(d.kind, 'defect', 'an advisory kind here matches no blocking finding, ever');
  assert.equal(d.file, 'src/auth.py');
  assert.equal(d.line, 88);
  assert.equal(d.reconciled, true);
  assert.equal(d.severity, null, 'nobody triaged it, so it still claims no severity');
  assert.equal(isSettled(d.disposition), false, 'and it still settles nothing');
});

test('a folded entry says whether the report answered it, in three answers', () => {
  // "Nobody looked" and "we looked and the report answers nothing" are
  // different claims, and only the second is the identity that becomes an
  // exemption on fields no lane ever filed.
  const bound = foldFixPayloads([payload()], { report: merged });
  assert.equal(bound[0].reconciled, true);

  const unbound = foldFixPayloads(
    [payload({ fixed: [], named_not_fixed: [namedItem()] })], { report: merged });
  assert.equal(unbound[0].reconciled, false, 'checked, and no finding carries this title');

  const unchecked = foldFixPayloads([payload({ fixed: [], named_not_fixed: [namedItem()] })]);
  assert.equal(unchecked[0].reconciled, null, 'no report was given, so nothing was checked');
});

test('a batch cannot name the identity of a decision it is asserting', () => {
  // The self-serve exemption channel, end to end. A payload that both claims a
  // fix and names the same identity as not-fixed mints the `noted` token that
  // excuses its own claim from the SETTLES NOTHING check from the next
  // iteration on — the party being checked writing its own exemption.
  const launder = payload({
    named_not_fixed: [namedItem({
      title: decision().title, kind: 'defect', file: 'src/auth.py', line: 88,
    })],
  });
  assert.throws(() => foldFixPayloads([launder], { report: merged }),
    /carries the identity of the fixed decision from fix-auth-guard/);
  // With no report neither side is corrected and the identities still coincide,
  // so the refusal cannot be stepped around by withholding report.json.
  assert.throws(() => foldFixPayloads([launder]), /would excuse that decision/);
});

test('a declined decision cannot be vouched for by its own batch either', () => {
  // `onNotedRecord` does not ask what disposition it is excusing, so neither
  // does this: a decline that settles the wrong finding is the failure the
  // coverage check exists to name.
  assert.throws(() => foldFixPayloads([payload({
    fixed: [],
    declined: [decision({ reason: 'reproduced it; unreachable from any caller' })],
    named_not_fixed: [namedItem({
      title: decision().title, kind: 'defect', file: 'src/auth.py', line: 88,
    })],
  })], { report: merged }), /carries the identity of the declined decision/);
});

test('a named item beside a decision it does not settle is minted, not refused', () => {
  // The discriminating half, one field varied at a time. The refusal is keyed
  // on the identity `scoreMatch` settles at, so a title one word off and a
  // second file are both different findings and both legitimate footnotes.
  const near = foldFixPayloads([payload({
    named_not_fixed: [namedItem({
      title: 'the guard is unreachable now', kind: 'defect', file: 'src/auth.py', line: 88,
    })],
  })], { report: merged });
  assert.deepEqual(near.map((d) => d.disposition), ['fixed', 'noted']);

  const elsewhere = foldFixPayloads([payload({
    named_not_fixed: [namedItem({
      title: decision().title, kind: 'defect', file: 'src/session.py', line: 12,
    })],
  })], { report: merged });
  assert.deepEqual(elsewhere.map((d) => d.disposition), ['fixed', 'noted']);
  assert.equal(elsewhere[1].file, 'src/session.py', 'a stated anchor that disagrees does not bind');
});

test('an unbound named-not-fixed entry is reported as unbound, not as corrected', () => {
  // What the bridge prints under its own heading. `converge.mjs --record` never
  // names a `noted` entry — it skips the disposition — so the earliest anyone
  // sees the identity that is about to become an exemption is here.
  const p = [payload({ fixed: [], named_not_fixed: [namedItem()] })];
  assert.deepEqual(reconciliations(p, merged), [{
    agent: 'fix-auth-guard', title: 'preflight_emu is not budgeted', disposition: 'noted',
    bound: false, fields: [],
  }]);
});
