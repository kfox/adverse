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
  //
  // The ROUTING is what this test is about, and it is unchanged. The sentence
  // is not: this used to assert `/crosses a trust boundary/`, which is a claim
  // about a commit whose file list was empty and whose diff nobody scanned.
  // Failing toward the Adversary and asserting a boundary was crossed are two
  // different things, and only the first one is honest here.
  const chosen = chooseRegressionLane({ closesNothing: true, files: [], diff: '' });
  assert.equal(chosen.persona, 'adversary');
  assert.match(chosen.reason, /could not be assessed for a trust boundary/);
  assert.doesNotMatch(chosen.reason, /crosses a trust boundary/);
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

test('both exclusion inputs are attributed to the caller, and the artifact says which', () => {
  // A `closedBy` list is exactly as unchecked as `closesNothing` — nothing
  // verifies the names against what was reported — so neither arm may print an
  // asserted disinterest. The replaced sentence ("it reported none of the
  // findings this commit closed") claimed a verification nothing ran: one
  // wrong-but-well-formed name bought it.
  const declared = chooseRegressionLane({ ...ROUTINE, closesNothing: true });
  const named = chooseRegressionLane({ ...ROUTINE, closedBy: ['steward'] });

  assert.match(declared.reason, /the caller declared that this commit closes no finding/);
  assert.doesNotMatch(declared.reason, /it reported none of the findings/);
  assert.equal(declared.disinterest, 'declared-none');
  assert.match(named.reason, /the caller named 1 lane\(s\) as having reported into this commit/);
  assert.doesNotMatch(named.reason, /it reported none of the findings/);
  assert.doesNotMatch(named.reason, /the caller declared/);
  assert.equal(named.disinterest, 'declared-list');
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

// --- the length backstop is a routing input, not a boundary claim ------------
//
// These come in the pair this file's header asks for: the same README-only
// commit, once with a line long enough to defeat every bounded span and once
// with the same prose wrapped under the limit. Only the length differs, so a
// difference in the chosen lane or the printed sentence can only have come from
// it — and a rule reading "the Adversary, always, once anything is unreadable"
// is distinguishable from the one under test.

const PROSE = 'Amend the scope gate description so that it says what is true of the length '
  + 'backstop, because the sentence it replaces described a gate that only ever matched '
  + 'patterns and that is no longer the gate this repository ships to anybody at all.';

test('a length-only trigger does not claim a boundary was crossed', () => {
  assert.ok(PROSE.length > 200, `fixture is ${PROSE.length} chars`);
  const long = chooseRegressionLane(
    { closedBy: ['pragmatist'], files: ['README.md'], diff: diffOf(PROSE) });
  const short = chooseRegressionLane(
    { closedBy: ['pragmatist'], files: ['README.md'], diff: diffOf(PROSE.slice(0, 200)) });

  // The sentence an operator reads. It used to be "the fix diff crosses a
  // trust boundary (trust-boundary signals present (0 in paths, 1 in added
  // code, 0 in removed code))" for 224 characters of ordinary prose.
  assert.match(long.reason, /holds lines no signal could read/);
  assert.doesNotMatch(long.reason, /crosses a trust boundary/);
  assert.doesNotMatch(long.reason, /trust-boundary signals present/);
  assert.match(long.reason, /ran past the 200-character span limit/);

  // And the shorter twin still reaches the other answer, so the assertion
  // above is about the length and not about README.md.
  assert.match(short.reason, /crosses no trust boundary/);
});

test('a length-only trigger leads with the Adversary, because that is the evasion case', () => {
  // This test replaces one that asserted the opposite, and the reasoning it
  // carried is worth recording because it was careful and wrong. It argued
  // that an unreadable line establishes only that the gate could not read it,
  // so leading with the Adversary acts on an absence of knowledge, and that a
  // docs-only fix is the archetype of the middle category the Steward is
  // placed ahead of the Adversary to catch.
  //
  // Both halves are true. What they miss is HOW a line becomes unreadable:
  // several CONTENT_SIGNALS are bounded spans between two literals, so padding
  // the span defeats the pattern and trips the length backstop in one move.
  // That makes this trigger the signal-defeated case, and routing it to the
  // routine order let an author pick a non-Adversary reviewer by making one
  // line long. Measured on the real bridge: 710 characters of column list
  // between SELECT and FROM, wrapping `req.params.id` into a raw query,
  // selected `adversary` before the trigger existed and `auditor` after.
  const chosen = chooseRegressionLane(
    { closedBy: ['pragmatist'], files: ['README.md'], diff: diffOf(PROSE) });
  assert.equal(chosen.persona, 'adversary');

  // The evasion itself, which is the case the order exists for. The signal is
  // genuinely defeated — `assessScope` reports no boundary — and the lane must
  // still be the Adversary.
  const cols = Array.from({ length: 40 }, (_, i) => `column_number_${i}`).join(', ');
  const evading = `q("SELECT ${cols} FROM accounts WHERE id=" + req.params.id)`;
  assert.ok(evading.length > 200, `fixture is ${evading.length} chars`);
  const evaded = chooseRegressionLane(
    { closedBy: ['pragmatist'], files: ['api.js'], diff: diffOf(evading) });
  assert.equal(evaded.persona, 'adversary');
  assert.match(evaded.reason, /holds lines no signal could read/);

  // The control: shorten the span and the signal matches, so the same lane is
  // reached by the boundary trigger instead. Both routes lead to the Adversary,
  // which is the property that makes padding useless.
  const readable = 'q("SELECT a FROM accounts WHERE id=" + req.params.id)';
  assert.ok(readable.length < 200);
  const seen = chooseRegressionLane(
    { closedBy: ['pragmatist'], files: ['api.js'], diff: diffOf(readable) });
  assert.equal(seen.persona, 'adversary');
  assert.match(seen.reason, /crosses a trust boundary/);

  // The cost, stated rather than hidden: on a docs-only fix the Steward is now
  // third instead of second. Exclude the Adversary and it is next, so it is
  // demoted and not dropped.
  const excluded = chooseRegressionLane(
    { closedBy: ['adversary'], files: ['README.md'], diff: diffOf(PROSE) });
  assert.equal(excluded.persona, 'auditor');
});

test('a real signal on the same long-lined diff still leads with the Adversary', () => {
  // The fix must not be reachable by weakening the gate: a genuine signal
  // beside an unreadable line is still a boundary, still the boundary order,
  // and still says so.
  const diff = diffOf('el.innerHTML = req.query.name;', PROSE);
  const chosen = chooseRegressionLane({ closedBy: ['pragmatist'], files: ['README.md'], diff });
  assert.equal(chosen.persona, 'adversary');
  assert.match(chosen.reason, /crosses a trust boundary/);
  assert.match(chosen.reason, /also ran past the 200-character span limit/);
});

test('each of the gate\'s four answers gets its own sentence, and no two share one', () => {
  // The lens table is a classifier, and the shape every convergence leak in
  // this project has had is the unmatched input that silently does nothing. All
  // four of `assessScope`'s triggers are reachable from here, so all four are
  // checked: an entry missing from the table would put `undefined` into the
  // middle of the artifact, and two entries sharing a sentence would be the
  // laundering this change removed, re-introduced one row over.
  const clauseOf = (args) => chooseRegressionLane({ closesNothing: true, ...args })
    .reason.replace(/^\w+: /, '').replace(/ \(.*$/s, '');
  const clauses = {
    boundary: clauseOf(BOUNDARY),
    none: clauseOf(ROUTINE),
    unreadable: clauseOf({ files: ['README.md'], diff: diffOf(PROSE) }),
    noFileList: clauseOf({ files: [], diff: '' }),
  };

  for (const [trigger, clause] of Object.entries(clauses)) {
    assert.ok(clause && clause.length > 10, `${trigger} has no sentence: ${JSON.stringify(clause)}`);
  }
  assert.equal(new Set(Object.values(clauses)).size, 4,
    `two triggers share a sentence: ${JSON.stringify(clauses)}`);
  // And only one of the four may say a boundary was crossed.
  assert.deepEqual(
    Object.entries(clauses).filter(([, c]) => /crosses a trust boundary/.test(c)).map(([t]) => t),
    ['boundary']);
});
