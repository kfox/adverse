// Tests for src/regression.mjs — which lane reads a fix commit for what else
// it changed.
//
// The property under test is a pair of exclusions and a preference, and the
// live risk is a fixture set where two different rules agree on every input:
// "the Adversary when the diff crosses a trust boundary" and "the Adversary,
// always" are indistinguishable unless some case picks somebody else. So the
// boundary cases come in pairs that differ in ONE thing — the same file list
// with one line of diff changed, the same diff with one name in `closedBy` —
// and the fallback cases pin who is chosen as well as that somebody is.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { chooseRegressionLane, unresolvedLanes } from '../src/regression.mjs';

const diffOf = (...added) =>
  ['diff --git a/x b/x', '--- a/x', '+++ b/x', '@@ -1 +1 @@', ...added.map((l) => `+${l}`)].join('\n');

// One file list, two diffs. Nothing but the changed line separates them, so a
// difference in the chosen lane can only have come from the diff.
const FILES = ['src/render/palette.mjs'];
const ROUTINE = { files: FILES, diff: diffOf('const gamma = 2.2;') };
const BOUNDARY = { files: FILES, diff: diffOf('el.innerHTML = req.query.name;') };

test('the trust boundary decides the lens, and its absence is not the same answer', () => {
  // `closesNothing` rather than `closedBy: []`: an empty list is refused now,
  // because it is what an omitted flag looks like. This test is about the lens,
  // so it says out loud that there was nothing to exclude.
  const crossing = chooseRegressionLane({ ...BOUNDARY, closesNothing: true });
  const ordinary = chooseRegressionLane({ ...ROUTINE, closesNothing: true });
  assert.equal(crossing.persona, 'adversary');
  assert.equal(ordinary.persona, 'auditor');
  assert.equal(crossing.conflicted, false);
  assert.equal(ordinary.conflicted, false);
  assert.match(crossing.reason, /crosses a trust boundary/);
  assert.match(ordinary.reason, /crosses no trust boundary/);
});

test('the lane that reported a finding this commit closed does not review the fix', () => {
  // The whole point of the pass: the reporter is the agent most invested in the
  // finding being closed, so it is the worst available lens for what else the
  // fix changed. Both preference orders have to yield.
  assert.equal(chooseRegressionLane({ ...BOUNDARY, closedBy: ['adversary'] }).persona, 'auditor');
  assert.equal(chooseRegressionLane({ ...ROUTINE, closedBy: ['auditor'] }).persona, 'steward');
  assert.equal(
    chooseRegressionLane({ ...ROUTINE, closedBy: ['auditor', 'steward'] }).persona, 'adversary');
});

test('a split lane\'s half is still that lane', () => {
  // `auditor-b` reviewing the fix for `auditor-a`'s finding is the lane checking
  // its own work under a different name, and it is the silent direction: the
  // report would read exactly like a disinterested pass.
  const chosen = chooseRegressionLane({ ...ROUTINE, closedBy: ['auditor-b'] });
  assert.equal(chosen.persona, 'steward');
  assert.equal(chosen.conflicted, false);
});

test('a name that belongs to no lane excludes nothing, and is reported', () => {
  // `closedBy` comes off a caller, where a persona string is model- or
  // hand-written. An unrecognized one must not silently exclude the lane the
  // pass wanted, and must not throw either — but it must not be DROPPED in
  // silence, which is what this test used to pin. `--closed-by Auditor` is one
  // capital letter from `auditor`: it excluded nobody, and the `reason` then
  // asserted the chosen lane "reported none of the findings this commit
  // closed" about the lane that had reported them all.
  const dropped = ['referee', 'AUDITOR', 'auditor_a', '__proto__', null, 42];
  const chosen = chooseRegressionLane({ ...ROUTINE, closedBy: dropped });
  assert.equal(chosen.persona, 'auditor');
  assert.equal(chosen.conflicted, false);
  assert.deepEqual(chosen.unresolved, dropped,
    'every name the resolver could not read, in the order given');
  assert.match(chosen.reason, /named no agent id this review produces/);
  assert.match(chosen.reason, /"AUDITOR"/);
});

test('an id that names a lane excludes it even when the id is malformed', () => {
  // The fail-unsafe flip this exclusion has to survive: a concurrent commit
  // tightened `isLaneAgent`'s suffix from `/^[a-z]+$/` to `/^[a-z]$/`, and
  // exclusion keyed on that exactness silently moved `auditor-ab` from
  // "excludes the auditor" to "excludes nobody". Both arms measured:
  // suffix /^[a-z]+$/ chose steward, suffix /^[a-z]$/ chose auditor — the lane
  // that reported the finding, reviewing its own fix commit. So `laneOf` is
  // generous now: naming a lane at all is enough to be out of the running.
  const chosen = chooseRegressionLane({ ...ROUTINE, closedBy: ['auditor-ab'] });
  assert.equal(chosen.persona, 'steward', 'the auditor named itself and is out');
  // And it is still reported, because it is not an id this system emits — the
  // exclusion is generous, the accounting is exact, and neither is silent.
  assert.deepEqual(chosen.unresolved, ['auditor-ab']);
  assert.match(chosen.reason, /read the exclusion above as approximate/);
});

test('a resolvable list leaves nothing unresolved — the field is not always full', () => {
  // The discriminating case for the assertions above: if `unresolved` were
  // simply `closedBy`, or simply everything, none of the three could hold.
  const chosen = chooseRegressionLane({ ...ROUTINE, closedBy: ['auditor', 'steward-b'] });
  assert.deepEqual(chosen.unresolved, []);
  assert.equal(chosen.persona, 'adversary');
  assert.doesNotMatch(chosen.reason, /named no agent id/);
});

test('unresolvedLanes reports every name this review could not have written', () => {
  // The predicate the skill bridge refuses on, tested where it lives so the
  // bridge's exit code and the library's `unresolved` field cannot disagree.
  // It is the EXACT rule — a different question from `laneOf`'s generous one —
  // so it catches the malformed-but-placeable id as well as the unplaceable.
  assert.deepEqual(
    unresolvedLanes(['auditor', 'Auditor', 'adversary-a', 'adversary-A', 'auditor-ab', 'referee']),
    ['Auditor', 'adversary-A', 'auditor-ab', 'referee']);
  assert.deepEqual(unresolvedLanes(['pragmatist']), [],
    'the Pragmatist is a lane; that it cannot HOLD a pass is a different rule');
  assert.deepEqual(unresolvedLanes([]), []);
  // This arm used to assert `unresolvedLanes('auditor') -> []`, "a non-array
  // excludes nothing, as before" — which is the fail-open it was written to
  // remove, pinned. A caller that passes the wrong shape gets no answer at all
  // now: the bare string is the plausible mistake (one `--closed-by` before
  // `multiple: true`), it resolves as a name, so reporting the ITEMS could
  // never have caught it.
  assert.throws(() => unresolvedLanes('auditor'), /closedBy must be an array, got string/);
  assert.throws(() => unresolvedLanes(undefined), /closedBy must be an array, got undefined/);
});

test('the Pragmatist never runs the pass, not even when nothing else is left', () => {
  // It owns only `design`, every design finding is advisory, and a pass that
  // can produce nothing that blocks cannot report the thing it was run for. The
  // interesting case is the empty candidate set, where a fallback reaching for
  // "whoever has not reported" would land on exactly this lane.
  for (const fixture of [ROUTINE, BOUNDARY]) {
    const chosen = chooseRegressionLane({
      ...fixture, closedBy: ['auditor', 'adversary', 'steward'],
    });
    assert.notEqual(chosen.persona, 'pragmatist');
  }
  assert.notEqual(chooseRegressionLane({ ...ROUTINE, closesNothing: true }).persona,
    'pragmatist');
});

test('an emptied candidate set still returns a lane, and flags itself', () => {
  // Skipping is the silent direction — a skipped pass reads exactly like a
  // clean one — so the pass runs anyway, in the same preference order, and says
  // that its reviewer was already invested in the commit.
  const everyone = ['auditor', 'adversary', 'steward'];
  const crossing = chooseRegressionLane({ ...BOUNDARY, closedBy: everyone });
  const ordinary = chooseRegressionLane({ ...ROUTINE, closedBy: everyone });

  assert.equal(crossing.persona, 'adversary');
  assert.equal(ordinary.persona, 'auditor');
  assert.equal(crossing.conflicted, true);
  assert.equal(ordinary.conflicted, true);
  assert.match(ordinary.reason, /reported a finding this commit closed/);
  assert.match(ordinary.reason, /already invested in this fix/);
});

test('no file list at all fails toward the Adversary, the way assessScope does', () => {
  // An unread diff is not a diff with nothing in it. Both callers of this
  // module hand over whatever git gave them, and a commit nobody could read
  // must not read as a commit with no boundary in it.
  const chosen = chooseRegressionLane({ closesNothing: true, files: [], diff: '' });
  assert.equal(chosen.persona, 'adversary');
  assert.match(chosen.reason, /crosses a trust boundary/);
});

test('called with no exclusion input at all, it refuses to answer', () => {
  // This test used to read "called with nothing at all, it still answers" and
  // assert `typeof chosen.persona === 'string'` — true of every return value,
  // and what it actually pinned was the fail-open: `chooseRegressionLane()`
  // chose the auditor and signed "it reported none of the findings this commit
  // closed" over an exclusion list nobody supplied. There is no honest answer
  // to give here, so there is no answer.
  assert.throws(() => chooseRegressionLane(), /closedBy must name at least one agent id/);
  assert.throws(() => chooseRegressionLane({ ...ROUTINE }),
    /closedBy must name at least one agent id/);
  assert.throws(() => chooseRegressionLane({ ...ROUTINE, closedBy: [] }),
    /closedBy must name at least one agent id/,
    'an empty list is exactly what an omitted flag looks like');
  assert.throws(() => chooseRegressionLane({ ...ROUTINE, closedBy: 'auditor' }),
    /closedBy must be an array, got string/);
  assert.throws(() => chooseRegressionLane({ ...ROUTINE, closedBy: ['auditor'],
    closesNothing: true }), /closesNothing contradicts the 1 name\(s\)/,
  'a caller that says both has not decided which');
});

test('the only way to exclude nobody is to say so, and the artifact says who said it', () => {
  // The escape hatch has to stay distinguishable from the fail-open it
  // replaced. A pass with nothing excluded may not print the sentence a
  // CHECKED exclusion earns, because the two read identically in a report.
  const declared = chooseRegressionLane({ ...ROUTINE, closesNothing: true });
  const checked = chooseRegressionLane({ ...ROUTINE, closedBy: ['steward'] });

  assert.match(declared.reason, /the caller declared that this commit closes no finding/);
  assert.doesNotMatch(declared.reason, /it reported none of the findings/);
  assert.match(checked.reason, /it reported none of the findings this commit closed/);
  assert.doesNotMatch(checked.reason, /the caller declared/);
  assert.equal(declared.conflicted, false);
  assert.deepEqual(declared.unresolved, []);
});

test('a commit description this module cannot read is refused, not assessed', () => {
  // The same fail-open one field over: a non-list `files` is iterated character
  // by character and a non-string `diff` stringifies to something with no added
  // lines in it, so both end at "crosses no trust boundary" — an assessment of
  // a commit nobody read, over the input that decides whether the Adversary is
  // the lane. Measured on the unguarded version: `files: 'src/render.mjs'` chose
  // the auditor and reported no trust-boundary signal.
  assert.throws(() => chooseRegressionLane(
    { closedBy: ['auditor'], files: 'src/render/palette.mjs', diff: BOUNDARY.diff }),
  /files must be an array, got string/);
  assert.throws(() => chooseRegressionLane(
    { closedBy: ['auditor'], files: FILES, diff: { added: 'el.innerHTML = q' } }),
  /diff must be a string, got object/);
});
