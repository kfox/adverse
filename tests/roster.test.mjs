// Tests for src/roster.mjs — who counts as a reviewer.
//
// These rules used to exist in two copies, one per bridge, and the copies had
// drifted: only one message named the override that fixes it, only one warned
// about a lane that ran and sent nothing, and only one checked that a payload
// was an object at all. The properties below are what both bridges now share.
//
// Exit codes are asserted here rather than only through a subprocess because
// they ARE the contract: 2 means the run could not read its configuration, 1
// means it read it and what it found does not describe a review.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_PERSONAS, PERSONAS, crossReviews } from '../src/personas.mjs';
import { ADVISORY_KINDS } from '../src/taxonomy.mjs';
import { REFUSED, USAGE, checkRoster, mergeRoster } from '../src/roster.mjs';
import { parsePlan } from '../src/scaling.mjs';

const payload = (persona, src = `${persona}.json`) => ({ persona, src });
const lanesOf = (...lanes) => parsePlan({ lanes }).lanes;
const messages = (r) => r.problems.map((p) => p.message).join('\n');

test('a clean roster raises nothing', () => {
  const r = checkRoster([payload('auditor'), payload('steward')]);
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.warnings, []);
});

// The Pragmatist reviews in round 1 and never cross-reviews: every kind it
// owns is `design`, which is advisory and cannot block, so it has no blocking
// claim to validate or challenge. Nothing refused its round-2 payload, and
// synthesis applies anyone's `challenge` — one challenger relabels a finding
// `disputed` however many personas reported it, moving it out of
// `Open blocking` and demanding an adjudication this lane cannot ask for.
test('a round-2 payload from a lane that does not cross-review is refused', () => {
  const r = checkRoster([payload('auditor'), payload('pragmatist')], { round: 2 });
  assert.equal(r.problems.length, 1);
  assert.equal(r.problems[0].exit, REFUSED);
  assert.match(messages(r), /does not cross-review/);
  assert.match(messages(r), /stale round-1 file or a spoof/);
});

test('the same payload is accepted in round 1, where that lane does review', () => {
  const r = checkRoster([payload('auditor'), payload('pragmatist')]);
  assert.deepEqual(r.problems, []);
});

test('lanes that do cross-review are still accepted in round 2', () => {
  const r = checkRoster(
    [payload('auditor'), payload('adversary'), payload('steward')], { round: 2 });
  assert.deepEqual(r.problems, []);
});

test('crossReviews is derived from advisory kinds, not from a hard-coded name', () => {
  // Over the real registry this assertion cannot fail an implementation that
  // simply names the Pragmatist, because it is the only advisory-only lane.
  // The synthetic registry is what makes the claim in this test's name real:
  // `scribe` is advisory-only and is not called 'pragmatist', so a name check
  // returns the wrong answer for it, and `hybrid` owns one blocking kind
  // alongside an advisory one and must still cross-review.
  const personas = {
    scribe: { name: 'scribe', kinds: ['design'] },
    hybrid: { name: 'hybrid', kinds: ['design', 'defect'] },
  };
  assert.equal(crossReviews('scribe', 2, { personas }), false);
  assert.equal(crossReviews('hybrid', 2, { personas }), true);
  assert.equal(crossReviews('scribe', 1, { personas }), true, 'round 1 is never filtered');

  for (const name of DEFAULT_PERSONAS) {
    const advisoryOnly = PERSONAS[name].kinds.every((k) => ADVISORY_KINDS.has(k));
    assert.equal(crossReviews(name, 2), !advisoryOnly, name);
    assert.equal(crossReviews(name, 1), true, `${name} in round 1`);
  }
});

test('a persona outside the registry is refused, not read as a fifth lane', () => {
  const r = checkRoster([payload('Auditor')]);
  assert.equal(r.problems.length, 1);
  assert.equal(r.problems[0].exit, REFUSED);
  assert.match(r.problems[0].message, /unknown persona 'Auditor'/);
});

test('a payload that is not an object is refused before its persona is used', () => {
  for (const bad of [null, undefined, 7, 'auditor']) {
    const r = checkRoster([{ persona: bad?.persona, src: 'x.json' }]);
    assert.match(messages(r), /missing or invalid `persona` field/);
  }
});

test('the problem names the file it came from, so a wide glob says which payload', () => {
  const r = checkRoster([payload('referee', 'run/round1-referee.json')]);
  assert.match(r.problems[0].message, /^run\/round1-referee\.json: /);
});

test('an undeclared duplicate persona is refused, not silently merged', () => {
  const r = checkRoster([payload('steward', 'a.json'), payload('steward', 'b.json')]);
  assert.equal(r.problems.length, 1);
  assert.equal(r.problems[0].exit, REFUSED);
  assert.match(r.problems[0].message, /duplicate persona 'steward'/);
});

test('a declared split lane takes exactly two payloads', () => {
  const twice = [payload('auditor', 'a.json'), payload('auditor', 'b.json')];
  assert.deepEqual(checkRoster(twice, { explicitMerges: ['auditor'] }).problems, []);
});

test('a split lane missing its other half is refused — half the files got no reviewer', () => {
  const r = checkRoster([payload('auditor')], { explicitMerges: ['auditor'] });
  assert.match(messages(r), /expected exactly 2 payloads for the split lane, got 1/);
  assert.match(messages(r), /re-run it/);
});

test('a split lane that sent NOTHING is refused — the most complete version of the failure', () => {
  // Counting only the personas that produced payloads skips a lane that
  // produced none, so the check meant to catch "half the diff got no reviewer"
  // stopped firing when NEITHER half did. The declared roster is the thing
  // being checked against, not the observed one.
  const r = checkRoster([payload('steward')], { explicitMerges: ['auditor'] });
  assert.equal(r.problems.length, 1);
  assert.equal(r.problems[0].exit, REFUSED);
  assert.match(r.problems[0].message, /expected exactly 2 payloads for the split lane, got 0/);
});

test('a split lane the PLAN declared that sent nothing is refused the same way', () => {
  const lanes = lanesOf(
    { persona: 'auditor', run: true, agents: 2 },
    { persona: 'steward', run: true, agents: 1 });
  const r = checkRoster([payload('steward')], { lanes });
  assert.match(messages(r), /expected exactly 2 payloads for the split lane, got 0/);
});

test('every declared split lane is checked, not just the first one missing', () => {
  const r = checkRoster([], { explicitMerges: ['auditor', 'adversary'] });
  assert.equal(r.problems.length, 2);
  assert.match(messages(r), /--merge-personas auditor: expected exactly 2/);
  assert.match(messages(r), /--merge-personas adversary: expected exactly 2/);
});

test('a split lane with a stray third payload is refused, not merged three ways', () => {
  const three = ['a', 'b', 'c'].map((f) => payload('auditor', `${f}.json`));
  const r = checkRoster(three, { explicitMerges: ['auditor'] });
  assert.match(messages(r), /got 3/);
  assert.match(messages(r), /stale file or a double glob/);
});

test('a merge persona outside the registry is a usage error, exit 2, not a refusal', () => {
  const r = checkRoster([payload('auditor')], { explicitMerges: ['referee'] });
  assert.equal(r.problems.length, 1);
  assert.equal(r.problems[0].exit, USAGE);
  assert.match(r.problems[0].message, /not a persona/);
});

test('a usage problem is ordered before a refusal, so the exit code is the earlier claim', () => {
  const r = checkRoster([payload('Auditor')], { explicitMerges: ['referee'] });
  assert.equal(r.problems[0].exit, USAGE);
  assert.equal(r.problems.at(-1).exit, REFUSED);
});

// --- what the plan rules out -------------------------------------------------

test('a payload from a lane the plan recorded as not run is refused', () => {
  const lanes = lanesOf({ persona: 'pragmatist', run: false, agents: 0 });
  const r = checkRoster([payload('pragmatist')], { lanes });
  assert.equal(r.problems[0].exit, REFUSED);
  assert.match(r.problems[0].message, /recorded 'pragmatist' as not run/);
});

test('the refusal names the override, so the remedy is not guesswork', () => {
  const lanes = lanesOf({ persona: 'pragmatist', run: false, agents: 0 });
  const r = checkRoster([payload('pragmatist')], { lanes });
  assert.match(r.problems[0].message, /regenerate\s+plan\.json/);
});

test('a plan need not be exhaustive — a persona it does not mention is not ruled out', () => {
  // The lane the plan DOES name is deliberately unsplit here. A split lane
  // that sent nothing is refused on its own account (below), which would
  // otherwise mask the thing this test is about: steward, unmentioned, is
  // still a legitimate reviewer.
  const lanes = lanesOf({ persona: 'auditor', run: true, agents: 1 });
  assert.deepEqual(checkRoster([payload('steward')], { lanes }).problems, []);
});

test('the split roster comes off the plan without being retyped', () => {
  const lanes = lanesOf(
    { persona: 'auditor', run: true, agents: 2 },
    { persona: 'steward', run: true, agents: 1 });
  const two = [payload('auditor', 'a.json'), payload('auditor', 'b.json')];
  assert.deepEqual(checkRoster(two, { lanes }).problems, []);
});

test('a lane the plan did NOT split still trips the duplicate guard', () => {
  const lanes = lanesOf({ persona: 'steward', run: true, agents: 1 });
  const two = [payload('steward', 'a.json'), payload('steward', 'b.json')];
  assert.match(messages(checkRoster(two, { lanes })), /duplicate persona 'steward'/);
});

test('round 2 has no split lanes, so the plan\'s split half does not apply', () => {
  const lanes = lanesOf({ persona: 'auditor', run: true, agents: 2 });
  assert.deepEqual([...mergeRoster(lanes, [], { round: 2 })], []);
  assert.deepEqual([...mergeRoster(lanes, [], { round: 1 })], ['auditor']);
});

// --- the lane that ran and said nothing --------------------------------------

test('a lane the plan ran that sent no payload is warned about, not refused', () => {
  const lanes = lanesOf(
    { persona: 'auditor', run: true, agents: 1 },
    { persona: 'steward', run: true, agents: 1 });
  const r = checkRoster([payload('auditor')], { lanes });
  assert.deepEqual(r.problems, []);
  assert.match(r.warnings.join('\n'), /the plan ran steward but no payload arrived/);
});

test('the Pragmatist\'s absence from round 2 is the design, not a silent lane', () => {
  const lanes = lanesOf(
    { persona: 'auditor', run: true, agents: 1 },
    { persona: 'pragmatist', run: true, agents: 1 });
  const round2 = checkRoster([payload('auditor')], { lanes, round: 2 });
  assert.deepEqual(round2.warnings, []);
  const round1 = checkRoster([payload('auditor')], { lanes, round: 1 });
  assert.match(round1.warnings.join('\n'), /pragmatist/);
});

test('a re-cased payload does not stand in for the lane it imitates', () => {
  // The refusal and the silence are both required: 'Steward' is refused as a
  // phantom lane AND the real steward is still reported as having sent
  // nothing. A run that accepted the imitation would report neither.
  //
  // This does NOT exercise `checkRoster`'s skip of refused payloads when
  // counting who was heard: 'Steward' and 'steward' are different keys, so the
  // warning fires either way. That branch is unreachable and src/roster.mjs
  // says so — mutating it changes no test, which is why it is written down
  // rather than left to look covered.
  const lanes = lanesOf(
    { persona: 'auditor', run: true, agents: 1 },
    { persona: 'steward', run: true, agents: 1 });
  const r = checkRoster([payload('auditor'), payload('Steward')], { lanes });
  assert.match(messages(r), /unknown persona 'Steward'/);
  assert.match(r.warnings.join('\n'), /the plan ran steward but no payload arrived/);
});

test('with no plan there is no roster to be silent against', () => {
  assert.deepEqual(checkRoster([payload('auditor')]).warnings, []);
});

test('the registry is the persona module\'s, not a copy', () => {
  const r = checkRoster([payload('auditor')], { personas: [] });
  assert.match(messages(r), /unknown persona 'auditor'/);
  assert.deepEqual(checkRoster(DEFAULT_PERSONAS.map((p) => payload(p))).problems, []);
});
