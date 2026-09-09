// Tests for the persona set as a SET, not as four independent prompts.
//
// The design rests on one invariant: every `kind` is owned by someone. Kinds
// are deliberately SHARED — `defect` by the Auditor and the Adversary,
// `behavioral` by three — so what keeps a shared kind from producing duplicate
// findings is not the kind but the EVIDENCE each lane must bring, enforced by
// the exclusion lists in each system prompt. Nothing at runtime checks any of
// it: two personas who both think documentation drift is theirs will each
// report it, and synthesis will read two independent reports of one issue as
// cross-validated consensus. That is the strongest signal the panel produces
// and the easiest to counterfeit, so the map is pinned here instead —
// src/personas.mjs sends a maintainer to OWNERSHIP below to change it.

import { readFileSync, readdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_PERSONAS, PERSONAS, advisoryOnlyLane, crossReviews, isLaneAgent,
  laneAgentOf,
} from '../src/personas.mjs';
import { sizeSkippable } from '../src/scaling.mjs';
import { ADVISORY_KINDS, KINDS } from '../src/taxonomy.mjs';

// One arm of a persona's severity rubric, whitespace-collapsed.
//
// Assertions about a rubric are always about which RUNG something is on, and a
// match against the whole prompt cannot see a rung. Measured: moving the entire
// availability arm out of `critical` and onto `warning` left every assertion
// here green, which is the defect this file exists to guard — the class capped
// at `warning`, and `reject` (src/prompts.mjs:295) unreachable.
// Where a labeled region of a persona prompt ends: at the next `What's `
// header, or at the blank line that ends its list — whichever comes first.
//
// Both halves are load-bearing and the second was the expensive one. The
// out-of-scope list is every persona's LAST section, so a header-only
// terminator runs to the end of the prompt and an assertion that claims to be
// about one section is about "somewhere below this header" instead. Measured:
// the cession's pointer sentence moved verbatim out of the exclusion bullet
// into the closing prose stayed GREEN against the header-only form.
//
// It is a named constant rather than three copies of a literal because the
// third copy was written wrong. `availabilityBullet` arrived with the
// header-only boundary two rounds after the other two were fixed away from it,
// and it took the Auditor's last "bullet" from 61 characters to 2194 and the
// Adversary's availability matches from one to four.
const REGION_END = /\nWhat's |\n\s*\n/;

// Everything from `head` to the end of its region, raw.
function region(persona, head) {
  const src = PERSONAS[persona].system;
  const at = src.indexOf(head);
  assert.notEqual(at, -1, `${persona} has no "${head}" section`);
  const rest = src.slice(at + head.length);
  const end = rest.search(REGION_END);
  return end === -1 ? rest : rest.slice(0, end);
}

function rubricArm(persona, severity) {
  const system = PERSONAS[persona].system;
  const head = `- \`${severity}\` —`;
  const start = system.indexOf(head);
  assert.notEqual(start, -1, `${persona} has no \`${severity}\` rubric arm`);
  // The arms are a list, so this one also terminates at its successor —
  // `REGION_END` alone would run each arm into the next.
  const rest = system.slice(start + head.length);
  const end = rest.search(/\n- `|\n\s*\n/);
  return (end === -1 ? rest : rest.slice(0, end)).replace(/\s+/g, ' ').trim();
}

// One labeled section of a persona prompt, whitespace-collapsed.
function section(persona, head) {
  return region(persona, head).replace(/\s+/g, ' ');
}

// The one out-of-scope bullet that cedes the availability class. Sliced from
// `region` rather than from `section`, because `section` collapses the newlines
// the bullets are delimited by. Per BULLET rather than per section: the list
// also cedes injection, auth and crypto to the same lane, and a section-wide
// match cannot tell an availability sentence from a neighbor's.
function availabilityBullet(persona) {
  const bullets = region(persona, "What's out of scope").split(/\n- /).slice(1);
  const found = bullets.filter((b) => /availabilit/i.test(b));
  assert.equal(found.length, 1,
    `${persona} has ${found.length} out-of-scope bullets naming availability, want 1`);
  return found[0].replace(/\s+/g, ' ').trim();
}


const all = Object.values(PERSONAS);

test('every persona declares kinds, and only real ones', () => {
  for (const p of all) {
    assert.ok(Array.isArray(p.kinds) && p.kinds.length, `${p.name} declares no kinds`);
    for (const k of p.kinds) {
      assert.ok(KINDS.includes(k), `${p.name} claims unknown kind '${k}'`);
    }
  }
});

test('every kind has an owner', () => {
  const owned = new Set(all.flatMap((p) => p.kinds));
  for (const k of KINDS) {
    assert.ok(owned.has(k), `no persona owns '${k}' — findings of that kind cannot be reported`);
  }
});

test('every advisory kind has exactly one owner', () => {
  for (const advisory of ADVISORY_KINDS) {
    const owners = all.filter((p) => p.kinds.includes(advisory));
    assert.equal(owners.length, 1,
      `'${advisory}' is advisory and must have one owner, has: ${owners.map((p) => p.name)}`);
  }
});

test('a persona that owns an advisory kind is told so in its prompt, per kind', () => {
  for (const p of all) {
    for (const kind of p.kinds.filter((k) => ADVISORY_KINDS.has(k))) {
      assert.match(p.system, new RegExp(`\\\`${kind}\\\`[^.]*\\badvisory\\b`, 'i'),
        `${p.name} owns advisory '${kind}' and must be told it cannot block, or it will calibrate as if it could`);
    }
  }
});

// The Adversary's resource lens bounded quantity and never time, and the whole
// class fell between the lanes: the Auditor is told DoS is not its business, and
// the Steward only checks claims the code makes about itself — a codebase with no
// timeouts makes none. So each clause here is pinned individually rather than
// left to the generated-copy drift test, which proves the three copies AGREE and
// passes just as happily on text somebody trimmed back out.
test('every statement of the attack requirement admits an availability bound', () => {
  // Whitespace-collapsed, because these assertions are about the SENTENCES and
  // the prompt is hard-wrapped. Pinning the wrap position too made a reflow
  // that changed no meaning turn this test red three times, which trains the
  // next editor to adjust the assertion rather than read it. Anything that
  // genuinely cares about line width — the generated-copy drift test — is a
  // different test.
  const system = PERSONAS.adversary.system.replace(/\s+/g, ' ');

  // #87 appended an exception after ONE of ten statements of this filter and
  // left nine standing, three of them ahead of the scope list and one in
  // last-word position. Each is pinned separately: the generated-copy drift
  // test proves the copies agree, and the suite stayed green through the whole
  // contradiction, so nothing else here can fail for this reason.
  // Line 2 of the prompt, and the first thing a lane agent reads. Its
  // machine-readable twin is `lens` below; a sweep that amends one and not
  // the other advertises a lane the prompt body then contradicts.
  assert.match(system, /what an attacker can do with this code — and what runs out without one/);

  assert.match(system, /hostile rather than well-intentioned — or, for an availability bound, merely more numerous or slower than expected/);
  assert.match(system, /the attack story carries the lane — and for an availability bound the load story carries it in the attack story's place/);
  assert.match(system, /no abuse story and no availability consequence/);
  assert.match(system, /A resource that leaks is the Auditor's as a mechanism/);
  assert.match(system, /The evidence is what separates the two reports, not the topic/);

  // The one ABSOLUTE imperative statement of the requirement, and the only one
  // #87 left without the exception beside it — it appended a paragraph after
  // this sentence rather than amending it.
  assert.match(system, /or, for an availability bound, a load story in its place/);
  assert.match(system, /coherent attack — or, for an availability bound, the load that exhausts the resource/);

  // The rubric decides what the finding is WORTH, and it was the half the
  // widening missed: all three bullets were keyed to an attacker, so the class
  // could not be rated above `warning` however total the outage — and a
  // `reject` verdict needs a `critical`.
  //
  // Rated by REACHABILITY, and deliberately not by blast radius. An earlier
  // draft required the exhaustion to stop the service "for every caller", which
  // the Auditor's arm has no counterpart for — that one asks only whether the
  // bug fires in normal use — so one hang rated `critical` from one lane and
  // `warning` from the other. Do not re-add a breadth bar here; the second
  // assertion below is what says so in the prompt itself.
  // Pinned to the ARM, not to the prompt: which rung this sits on is the
  // entire content of the fix.
  const critical = rubricArm('adversary', 'critical');
  assert.match(critical, /its exhaustion stops work a caller depends on, AND it is reached by load this system actually sees/);
  assert.match(critical, /a hang that takes out one endpoint's callers is not a rung below one that takes out all of them/);
  assert.match(critical, /Rate it by what stops working, not by who made it stop and not by how many callers it stopped/);

  // …and the precondition it gained, without which a bound on a cold path
  // rated the top severity, forced a reject verdict and raised the cap. The
  // DEMOTION TARGET is named: an assertion stopping at "is the" passed just as
  // happily when `warning` was changed to `info`, which is a cold-path bound
  // demoted to a rung that cannot block at all.
  assert.match(critical, /A bound only a hypothetical load reaches is the \`warning\` below/);
  assert.match(critical, /the same way a wrong answer for inputs nobody sends/);

  // And the arm is NOT on either of the rungs below it. The assertion above
  // proves it is in `critical`; these two prove it did not also get pasted
  // somewhere it would read as the cap.
  assert.doesNotMatch(rubricArm('adversary', 'warning'), /availability bound/);
  assert.doesNotMatch(rubricArm('adversary', 'info'), /availability bound/);
});

test('every lane that owns the availability class advertises it', () => {
  // `lens` builds the subagent frontmatter (dump-prompts.mjs) and prints for
  // `--personas` (src/cli.mjs), so it is the machine-readable surface an
  // orchestrator reads when choosing lanes — and the one the hand-written
  // README and SKILL.md tables do not cover.
  //
  // Derived from the prompt body rather than naming the Adversary, because
  // hardcoding one lane is what let this go stale. The commit that gave the
  // Auditor an availability bullet and three rubric arms left its `lens` at
  // "Correctness, logic, and algorithmic soundness" and its own role sentence
  // at "report only issues a careful programmer would catch by reading the code
  // and asking 'does this compute the right answer?'" — a hang is not a wrong
  // answer, so the lane was told to report a class its self-description
  // excluded. Verbatim the defect this same commit fixed for the Adversary's
  // `lens`, one lane over, and the test that caught that one named the lane.
  // Owning it means having it IN SCOPE. Every other lane names the class in its
  // out-of-scope list in order to hand it over — that is the sweep the sibling
  // test above enforces — so a whole-prompt match makes every lane an owner and
  // demands the Steward advertise a class it was told not to report.
  const owners = Object.values(PERSONAS).filter(
    (p) => /missing bound|no bound|unbounded|with no bound/i
      .test(section(p.name, "What's in scope")),
  );
  assert.ok(owners.length >= 2,
    'no lane names the availability class in its prompt body — this test has lost its subject');
  for (const p of owners) {
    assert.match(p.lens, /runs out|no bound|unbounded|bound/i,
      `${p.name} is told to report unbounded operations, but its advertised lens does not mention them`);
  }

  // And the voice, which is the other self-description a reviewer reads before
  // it reaches any scope list.
  assert.match(PERSONAS.auditor.system, /does this ever finish\?/);
});

test('SKILL.md names the same lane split as the personas do', () => {
  // The README got a test in round 8 for exactly this; SKILL.md did not, and it
  // carries the same claim. Its roster is the file's ONLY one — the sentence
  // under it says so — and this commit amended the Adversary row while leaving
  // the Auditor's at "correctness: does it compute the right answer", which the
  // Auditor's own in-scope bullet and three rubric arms contradict.
  //
  // Pinned to the roster row, not the file: SKILL.md is long prose and most of
  // it is free to change.
  const skill = readFileSync(
    new URL('../skills/adverse-review/SKILL.md', import.meta.url), 'utf-8',
  ).replace(/\s+/g, ' ');

  const auditorRow = /\| \*\*Auditor\*\* \|([^|]*)\|/.exec(skill);
  assert.ok(auditorRow, 'SKILL.md has no Auditor roster row');
  assert.match(auditorRow[1], /bound/,
    "SKILL.md's Auditor row does not mention the bound it is told to report");

  const adversaryRow = /\| \*\*Adversary\*\* \|([^|]*)\|/.exec(skill);
  assert.ok(adversaryRow, 'SKILL.md has no Adversary roster row');
  assert.match(adversaryRow[1], /runs out/);
});

test('every other exclusion list hands the availability class over', () => {
  // src/personas.mjs:35-41: re-aiming a persona means editing every other
  // persona's out-of-scope list in the same change, because two lanes that both
  // believe they own a kind report it twice and duplicate reports render
  // `cross-validated` (src/synthesis.mjs:741) — the one signal the design
  // trusts most. #87 widened the Adversary and left three lists unedited, so
  // this asserts the sweep from the side that would have produced the duplicate.
  // Derived, never listed. src/personas.mjs:35-41 states a rule about EVERY
  // other persona, and a hardcoded three pins today's roster instead: a fifth
  // persona whose exclusion list names "(Adversary's territory)" and never
  // availability turned four other tests red and left this one green.
  for (const persona of Object.keys(PERSONAS).filter((n) => n !== 'adversary')) {
    const outOfScope = section(persona, "What's out of scope");
    assert.match(outOfScope, /availabilit/i,
      `${persona}'s exclusion list never names the availability class`);

    // And it must say who DOES report the bound, because the lane it cedes to
    // is gated (`GATED_LANES`, src/scaling.mjs:140) and the diffs it skips are
    // the diffs this bullet is read on. A bullet that hands the whole class to
    // the Adversary and stops there tells its reader the class is covered when
    // on that diff nobody covers it — the unowned-and-silent state the split
    // exists to prevent. The Auditor is exempt: it is the reporter, and its own
    // bullet cedes the rating instead, which the assertions below pin.
    if (persona === 'auditor') continue;
    assert.match(availabilityBullet(persona), /Auditor/,
      `${persona} cedes availability without naming the lane that reports the bound`);
  }

  // The Auditor's is the one that overlaps: "Resource handling: leaks" is in
  // scope for it, and the exhaustion story is not. Its IN-scope bullet has to
  // say so too — a reader who stops at the in-scope list never reaches the
  // exclusion below it.
  assert.match(PERSONAS.auditor.system,
    /The\s+mechanism is yours — it fails to close\. What exhausts it is not/);

  // And the warning that keeps that cession from reading as pedantry names the
  // right mechanism. It used to say the merge rendered "a consensus of two
  // reviewers that was one reviewer twice", which cannot happen: `reporters`
  // is deduped by persona (src/scaling.mjs:12), so one lane filing the same
  // title twice renders `solo (reporters: auditor)` — measured. The real
  // counterfeit needs two personas, and gets them when this lane writes the
  // other lane's half in the other lane's words.
  assert.match(PERSONAS.auditor.system, /your title normalizes equal to theirs/);
  assert.match(PERSONAS.auditor.system,
    /two personas did report it, and this lane saying it\s+twice would render `solo`/);
  assert.doesNotMatch(PERSONAS.auditor.system, /a consensus of two\s+reviewers that was one reviewer twice/);

  // And the cession is of the RATING, never of the report. `adversary` is in
  // GATED_LANES (src/scaling.mjs:140) and src/scope.mjs carries no duration,
  // timeout, deadline or queue signal, so a diff with no security signals gets
  // no Adversary lane at all. A draft told the Auditor unconditionally that an
  // unbounded resource was "theirs to rate, not yours", which on those diffs
  // left the class UNOWNED rather than double-owned — silent where the
  // duplicate is noisy. Do not simplify this back into a full hand-off until
  // src/scope.mjs can route the lane it hands off to.
  //
  // Pinned to the SECTION, because placement was the defect. A draft put
  // "Report the missing bound anyway" inside `What's out of scope (do NOT flag
  // these)`, where nothing in the in-scope list covered it — the resource
  // bullet is scoped to leaks and cleanup, and a call with no deadline neither
  // leaks nor skips cleanup. An Auditor reading the header on a diff the
  // Adversary was gated out of files nothing, which is the unowned-and-silent
  // state the cession was rewritten to prevent.
  const inScope = section('auditor', "What's in scope for you:");
  const outOfScope = section('auditor', "What's out of scope (do NOT flag these");

  // The observation is an instruction to report, so it lives with the other
  // instructions to report.
  assert.match(inScope, /An operation with no bound on how long it may take or how much it may hold/);
  assert.match(inScope, /The missing bound is a mechanism and mechanisms are yours, so report it here/);
  assert.doesNotMatch(outOfScope, /Report the missing bound/);

  // What the out-of-scope list cedes is the Adversary's EVIDENCE, and it says
  // where the observation went so the two halves cannot be read apart.
  //
  // Magnitude was the wrong axis, and it was the stated axis for two rounds:
  // "how bad an exhaustion is" was ceded here while the Adversary's own
  // `critical` arm refuses to rate by it ("not by how many callers it
  // stopped"). So the half this list handed over was a half no lane would
  // take, and a reviewer who obeyed both prompts left the magnitude unrated by
  // anybody. What the Adversary has and this lane does not is the deployment.
  assert.match(outOfScope, /the load this deployment actually sees, and whether anyone can drive it/);
  assert.match(outOfScope, /Those\s+are not yours to argue/);
  assert.doesNotMatch(outOfScope, /how bad an exhaustion is/);
  assert.doesNotMatch(outOfScope, /and for whom/);
  assert.match(outOfScope, /the missing bound itself is an in-scope bullet above/);

  // The converse, and it is what makes the cession safe to obey: everything the
  // code can answer stays here, including the two questions the rubric below
  // rates on. A cession phrased as magnitude took those with it — "what stops
  // working when the bound is reached" is the rubric's own `critical`
  // condition, ceded away in the same sentence that the rubric requires.
  assert.match(outOfScope, /What is NOT ceded is anything the code can tell you/);
  assert.match(outOfScope, /whether an\s+ordinary path reaches it and what waits on the operation when it does/);
  assert.match(outOfScope, /This\s+lane runs on every diff and that one does not/);
});

test('the Auditor rates a missing bound on every rung, by what waits on it', () => {
  // The other half of the widening, and the one a panel found missing after the
  // in-scope bullet had already landed. Ownership was split so the lane that
  // always runs files the mechanism — but its rubric was untouched, and all
  // three of its arms read "produces a wrong answer or crashes", which a hang
  // is neither. With the exclusion list forbidding it to rate the exhaustion,
  // the only honest arm left was `info`, and `isBlocking` (src/synthesis.mjs)
  // drops `info`: measured `defect`/`critical` -> true, `defect`/`warning` ->
  // true, `defect`/`info` -> FALSE. So on exactly the boundary-free diff the
  // cession was rewritten for, the Auditor's finding rendered and stopped
  // nothing — the same "the rubric was the half that made the widening inert"
  // defect this commit diagnosed for the Adversary, one persona over.
  //
  // Pinned per ARM, via `rubricArm`, because which rung carries the clause is
  // the whole of what it does.
  const critical = rubricArm('auditor', 'critical');
  const warning = rubricArm('auditor', 'warning');
  const info = rubricArm('auditor', 'info');

  assert.match(critical, /A missing bound rates here when nothing in normal operation prevents the bound from being reached AND something a caller waits on stops when it is/);
  assert.match(warning, /A missing bound rates here when reaching it takes something normal operation does not currently do/);
  // The rung a round-7 draft left the class without. Both other arms block
  // (`isBlocking`, measured: `defect`/`warning` -> true) and this lane runs on
  // every diff, so with no `info` route an unbounded operation nobody waits on
  // — a dev script's `exec()`, a hand-run migration's growing array — blocked a
  // merge on the strength of a bound whose exhaustion costs nobody's request.
  // The class the widening was written for is the one with a caller waiting.
  assert.match(info, /A missing bound rates here when nothing waits on the operation/);
  assert.match(info, /its exhaustion costs nobody's request/);

  // The axis, stated once: this lane rates whether the bound is reached, which
  // is what its other arms already rate. Without this the arms above read as an
  // invitation to rate the outage, which the exclusion list cedes — and the two
  // halves would contradict each other in the same prompt.
  const system = PERSONAS.auditor.system.replace(/\s+/g, ' ');
  // Stated as the PAIR it is. "Whether the bound is reached, which is the
  // question all three arms above already ask" was false of `info`, which asks
  // about actionability rather than about firing — so the sentence justifying
  // the arms cited an arm that does not work that way.
  assert.match(system, /you are rating two things — is the bound reached, and does anything wait on the operation when it is/);
  assert.match(system, /does it fire, and is it actionable/);
  // The ceded half is EVIDENCE, not magnitude. "What you are NOT rating is how
  // big the resulting outage is" was the earlier form and it broke both ways:
  // the Adversary's `critical` arm declines to rate by magnitude too, so the
  // sentence ceded a half nobody would take — and the two rubrics then tested
  // the identical pair of conditions while claiming to split the work.
  assert.match(system, /You rate both from the CODE/);
  // One wording for one thing. The Auditor prompt named this evidence three
  // times as "the load this deployment actually sees" and once as "the load
  // this system actually sees", and two of the three were pinned by assertions
  // carrying the divergent text — a green suite BECAUSE the wordings differed,
  // which is the shape that let round 9 find the same false claim in two
  // copies and fix each separately.
  assert.match(system, /What you do not have is what the deployment does — the load this deployment actually sees, and whether anyone can drive it/);
  assert.doesNotMatch(system, /how big the resulting outage is/);
  assert.match(system, /the half you were told to leave; a different rating from that lane later is that lane supplying it, not a correction of yours/);

  // And `info` named as the wrong refuge, with the consequence. A reviewer that
  // cannot see the load reaches for the arm that admits it does not know, and
  // that arm is the one the pipeline discards.
  assert.match(system, /Do not settle for `info` because the load is the part you cannot see/);
  // Verbatim, with its citation. `/does not block/` was the only non-verbatim
  // regex among its neighbors and it guarded nothing: replacing the sentence
  // with "a `design` finding does not block at all…" left this test green, and
  // so did deleting the `isBlocking` citation outright.
  assert.match(system, /`info`\s+does not block at all \(`isBlocking`, src\/synthesis\.mjs\)/);
  // And the other direction, which is the half that keeps the rung usable: the
  // refusal is of `info` as a shrug, not of `info` as an answer.
  assert.match(system, /`info` is the right answer when nothing waits, and the wrong one when you simply cannot say how often the bound is reached in production/);

  // The rung is not the whole job, and TWO earlier drafts argued from the wrong
  // predicate — each one predicate short of the one that governs.
  //
  // `isBlocking` is what drops `info`. `isOpenBlocking` (src/synthesis.mjs:417)
  // is what the report's `Open blocking` headline counts. Neither is the stop
  // condition: that is `unsettled` (src/ledger.mjs:1400), every blocking
  // finding, and src/ledger.mjs:1385-1392 records that it was re-derived from
  // `unsettled` precisely because a confidence gate had dropped solo findings.
  //
  // Measured, via `convergenceStatus` on a `defect`/`critical`:
  //   solo     -> isBlocking TRUE, isOpenBlocking FALSE, openBlocking 0,
  //               done FALSE, reason "1 never cross-examined"
  //   disputed -> the same, done FALSE, reason "1 disputed"
  // So "holds nothing open, at any severity" was false, and the prompt built on
  // it aimed the lane at a consequence that does not exist.
  assert.match(system, /Above `info` the finding is held/);
  assert.match(system, /Those are two different numbers/);
  assert.match(system, /A convergence loop's stop condition is `unsettled` \(src\/ledger\.mjs\), which is EVERY blocking finding/);
  assert.match(system, /still holds the loop open, filed as "never cross-examined"/);
  assert.doesNotMatch(system, /holds nothing open, at any severity/);
  assert.doesNotMatch(system, /Rating it correctly is necessary and it is not sufficient/);

  // The route this lane controls ALONE, which the previous draft omitted while
  // pointing at the one lane it does not control. Measured: one reporter, zero
  // rulings, one confirmed probe -> `demonstrated`, `isOpenBlocking` TRUE,
  // `openBlocking` 1. `src/synthesis.mjs:739` checks `probe?.confirmed` ahead
  // of every reporter and validator count, so it is the ladder's first rung.
  assert.match(system, /one route out of it needs no other lane: attach a reproduction/);
  assert.match(system, /`demonstrated` is the FIRST rung of the confidence ladder, checked ahead of every reporter and validator count/);

  // And the claim a draft made instead, which was simply false: the Steward
  // always runs. `GATED_LANES` is `{ adversary }` (src/scaling.mjs:140), so a
  // diff with no trust-boundary signals loses one lane, not three — and the
  // lane it keeps is the one this rubric tells the Auditor to write for.
  assert.doesNotMatch(system, /this lane is the only one that ran/);
  assert.match(system, /the lane that can rule on this one is the Steward/);
  assert.match(system, /name the call, name what waits on it, and say what is missing rather than what might happen/);
});

test('the region slicers stop at the region, for every persona', () => {
  // Round 7 bounded `rubricArm` and `section` to the blank line that ends a
  // list, because the out-of-scope section is every persona's LAST and a
  // header-only terminator runs to the end of the prompt. Round 9 then added
  // `availabilityBullet` with the header-only boundary, in the same commit
  // whose message says the terminator is shared.
  //
  // Measured, before the terminator became `REGION_END`: the Auditor's last
  // out-of-scope "bullet" ran 2194 characters instead of 61, and the Adversary
  // matched availability in FOUR bullets instead of one — so
  // `availabilityBullet('adversary')` would have thrown on its own arity
  // assertion. It is not called on that persona today, which made the defect a
  // property of the caller rather than of the helper. This asserts the helper.
  for (const persona of Object.keys(PERSONAS)) {
    const src = PERSONAS[persona].system;
    const unbounded = src.slice(src.indexOf("What's out of scope"));
    const bullet = availabilityBullet(persona);

    // Pinned to the MECHANISM, not to a character count: a bullet is free to
    // grow, and a threshold guessed at today is a false failure tomorrow. What
    // must stay true is that the terminator narrowed the slice at all, and that
    // the slice stops before the sections that follow the region.
    assert.ok(bullet.length < unbounded.length / 2,
      `${persona}'s availability bullet is ${bullet.length} of ${unbounded.length}`
      + ' unbounded chars — the terminator is not narrowing the slice');
    assert.doesNotMatch(bullet, /Calibrate severity honestly|Every finding needs a concrete attack story|`critical` —/,
      `${persona}'s availability bullet reaches past its region`);
  }

  // And the out-of-scope region ends before the rubric in every persona, which
  // is the fact both other slicers depend on.
  for (const persona of Object.keys(PERSONAS)) {
    assert.doesNotMatch(section(persona, "What's out of scope"), /`critical` —/,
      `${persona}'s out-of-scope section swallows its rubric`);
  }
});

test('the Pragmatist cedes both halves of the class, and names them apart', () => {
  // Found by mutation: reverting this bullet to "a resource with no bound is
  // that lane's finding" left all 1401 tests green. The sibling test above
  // requires every exclusion list to name the class and the reporting lane,
  // which the old wording did once "Auditor" was added — but "that lane's
  // finding" still contradicts the Auditor's in-scope bullet, and a persona
  // told the finding is somebody else's is told not to expect it from the
  // Auditor either.
  //
  // The Pragmatist gets its own test rather than a clause in the loop because
  // its cession is the only one with no residue: the Steward keeps the
  // contradiction about a bound, and the Auditor keeps the bound itself. This
  // lane keeps nothing, so what it needs said is that BOTH halves are elsewhere
  // and which lane holds each.
  const bullet = availabilityBullet('pragmatist');
  assert.match(bullet, /is the Auditor's to report and the Adversary's to rate/);
  assert.match(bullet, /Neither half is yours/);
  assert.doesNotMatch(bullet, /is that lane's finding/);

  // And no challenge carve-out here, ever. The Pragmatist skips round 2
  // entirely (SKILL.md, Phase 4: "The Pragmatist skips round 2"), so a clause
  // telling it not to challenge the Auditor's finding would describe a move it
  // cannot make — and would read as a license to make it.
  assert.doesNotMatch(section('pragmatist', "What's out of scope"), /`challenge`/);
});

test('the module header ascribes the availability class to the Adversary', () => {
  // The ownership table and the anti-duplication rule are prose the OWNERSHIP
  // fixture below does not cover — it carries bare persona names — and they are
  // where the "(only with a working attack)" qualifier actually lived.
  //
  // All three are matched against a whitespace-collapsed copy with the comment
  // markers folded out, for the same reason the sibling test is collapsed: they
  // pin what the header SAYS, and where its line breaks fall is not something
  // any test here has an interest in. Normalizing one of the three and leaving
  // the other two is how a rewrap that changed no meaning still turned this red.
  const src = readFileSync(new URL('../src/personas.mjs', import.meta.url), 'utf8');
  const flat = src.replace(/\s*\/\/\s*/g, ' ').replace(/\s+/g, ' ');
  assert.ok(flat.includes('defect Auditor · Adversary (a working attack, or an availability bound)'));
  assert.ok(flat.includes('behavioral Auditor (mechanism) · Steward (tests)'
    + ' · Adversary (a working attack, or an availability bound)'));
  assert.ok(!flat.includes('Adversary (the same)'));
  assert.ok(flat.includes('or with an availability bound, whose'));
  assert.ok(flat.includes('story is load rather than a payload'));
});

test('the Adversary bounds duration, not only count and size', () => {
  // Whitespace-collapsed, like its siblings: these pin sentences of a
  // hard-wrapped prompt, and three of them had already been rewritten once to
  // chase a line break that moved.
  const system = PERSONAS.adversary.system.replace(/\s+/g, ' ');

  // The dimension itself, and the question that finds it. "Ask", not "say": the
  // round-1 contract is one JSON object with 1-10 findings and a 200-char
  // summary, so an instruction to enumerate every resource has nowhere to land
  // and costs the lane either its parse or its findings slots.
  assert.match(system, /unbounded \*\*duration\*\*/);
  assert.match(system, /a count, a size, and a clock — so ask which of the three is missing/);

  // Widening the scope list alone changes nothing, because the attack-story gate
  // filters exactly this class: a driver with no operation timeout hanging a
  // handler on a merely-slow dependency has no attacker to name.
  assert.match(system, /An availability bound is in scope even where the attacker is only load/);
  assert.match(system, /reason to describe the load, not a reason to drop the finding/);

  // The two lanes are told the same thing from both sides, and the sweep is
  // what makes that true. Before it, this prompt said "Nobody else reports
  // these: the Auditor's out-of-scope list cedes DoS to you" — a sentence
  // reasoning ABOUT a list the same change rewrote. A round-2 Adversary reading
  // it over a legitimate Auditor bound either challenges the finding as a lane
  // violation, which stamps it `disputed` (src/synthesis.mjs:740), or drops its
  // own load story as a duplicate of something its prompt says cannot exist.
  assert.match(system, /You are not the only lane that sees these, and not the only one that rates them/);
  // The claim this replaced. Round 8 gave the Auditor availability clauses on
  // all three rungs, which made "the only lane that RATES these" false the
  // moment it was written — the same defect as the `Nobody else reports these`
  // pinned out below, one verb over.
  assert.doesNotMatch(system, /the only lane that RATES these/);
  assert.match(system, /because it runs on every diff and you do not/);
  assert.match(system, /is not a lane violation and not your duplicate/);
  assert.match(system, /Add both to it as a `validate` entry on that finding, in its `reason`/);
  // What the Auditor has not supplied is this lane's EVIDENCE, not the whole
  // rating — the earlier form said "the load story and the severity are the
  // part nobody has supplied yet", which stopped being true when the Auditor's
  // rubric grew its own availability arms.
  assert.match(system, /what nobody has supplied is your\s+evidence/);
  assert.match(system, /Round 2 has no field that raises a recorded severity/);
  // The clause that keeps the mandated route from losing the reasoning
  // silently: src/synthesis.mjs:709 drops a `validate` whose title matches no
  // finding with no warning and no count, so a typo costs the load story as
  // well as the rating. Found unpinned by mutation.
  assert.match(system, /Copy the title from the briefing exactly/);
  // Keyed on the `id`, because that is what the repair keys on.
  // `skills/adverse-review/scripts/repair.mjs:91-94` rewrites a wrong title
  // from the id and reports that it did; `:86-89` reports an unresolvable id
  // and repairs nothing. So "dropped without a trace" was false for the flow
  // that runs Phase 5 and true only for a payload that reaches synthesis
  // unrepaired — and the sentence made the title load-bearing instead of the id.
  assert.match(system, /Phase 5\s+\(`repair\.mjs`\) rewrites a wrong title from the `id` and says it did/);
  assert.match(system, /an id that resolves to no\s+finding is reported unresolvable and repairs nothing/);
  assert.match(system, /The id is the load story's only anchor/);
  assert.doesNotMatch(system, /dropped without\s+a trace, so a typo loses the load story too/);
  assert.match(system, /Do not re-file it as an `added` finding to raise it/);
  assert.match(system, /the result renders `cross-validated` — the label for two lanes reaching a finding independently, spent on you re-filing the Auditor's/);
  // "Two reviewers agreeing, out of one" was the earlier wording and it
  // misnamed the arithmetic: an `added` finding from THIS lane merging with the
  // Auditor's does put two distinct personas in `reporters`, so the count is
  // honest and the corroboration is what is spent. Measured: two lanes, one
  // title -> `cross-validated (reporters: auditor,adversary)`.
  assert.doesNotMatch(system, /two reviewers agreeing, out of one/);

  // And the reason to `validate` rather than merely refrain, which is the half
  // that makes the instruction worth obeying: a `validate` is what moves the
  // Auditor's mechanism off `solo`, and `solo` holds nothing open
  // (`isOpenBlocking`, src/synthesis.mjs:417 — measured FALSE at `critical`).
  assert.match(system, /Validating is also what gets the finding described correctly/);
  assert.match(system, /files it as "never cross-examined"/);
  assert.match(system, /Your `validate` makes it `consensus`, and `consensus` is in that count/);
  // Neither state retires it — the stop condition is `unsettled`, not a
  // confidence. Measured: `critical`/`solo` -> convergenceStatus done FALSE.
  assert.match(system, /What neither state does is retire it/);
  assert.doesNotMatch(system, /`solo` does not hold a change open at any severity/);

  // The case the mandated route does not reach. Measured: both lanes filing the
  // same title in round 1 merge on `normTitle`, so the Adversary is already in
  // `reporters` — and `reportedBy` (src/synthesis.mjs:709) skips a `validate`
  // from a lane counted there. `validators: []`, and the reason reaches nothing.
  // The forbidden `added` re-file DOES work on that collision (severity
  // `warning` -> `critical`, load story into the merged detail), which is why
  // the prompt has to name the case rather than leave the two rules colliding.
  assert.match(system, /One case the route does not reach/);
  assert.match(system, /a `validate` from a lane already counted there is skipped/);
  assert.match(system, /Round 2 has no field that carries a rating onto an existing finding/);
  // The challenge route named with its consequence, not just forbidden. A
  // challenge sets `disputed` (src/synthesis.mjs:740), and `disputed` is not
  // one of the three confidences `isOpenBlocking` accepts — so challenging the
  // mechanism as a lane violation retires it rather than re-filing it.
  assert.match(system, /moves the mechanism into the `disputed` bucket — still held open, now recorded as contested/);
  assert.doesNotMatch(system, /not a confidence that holds anything open/);
  assert.match(system, /do not `challenge` it as a lane violation/);
  assert.doesNotMatch(system, /rather than challenging it or standing down/);
  assert.doesNotMatch(system, /Nobody else reports these/);

  // One-directional, and the direction matters. A per-attempt timeout inside an
  // unbounded retry loop makes "the source sets no timeout" false and "the
  // operation is unbounded" true, so requiring BOTH to be established would
  // forbid reporting the shape the clause above asks for.
  assert.match(system, /"The source sets no timeout" does not establish "the operation is unbounded"/);
});

test('the lane that can challenge the ceded finding away is told not to', () => {
  // The cession has a hole the Adversary's own carve-out cannot close. That
  // carve-out ("do not `challenge` it as a lane violation") was written into
  // the Adversary, the lane `GATED_LANES` (src/scaling.mjs:140) skips on
  // exactly the boundary-free diffs the cession exists for. The lane still
  // running is the Steward, whose exclusion list hands availability to the
  // Adversary and whose round-2 challenge ground includes "or out of scope" —
  // so it had both the standing and the instruction to stamp the Auditor's
  // finding `disputed`. Measured: `defect`/`critical`/`disputed` ->
  // `isOpenBlocking` FALSE (src/synthesis.mjs:417), so the challenge does not
  // re-file the finding against another lane; it retires it.
  //
  // The Pragmatist gets no such clause and must not grow one: that lane skips
  // round 2 entirely, so it has nothing to challenge with.
  const outOfScope = section('steward', "What's out of scope (do NOT flag these");
  assert.match(outOfScope, /The Auditor reports the missing bound itself, and was told to/);
  assert.match(outOfScope, /do not `challenge` such a finding\s+as a lane violation in round 2/);
  assert.match(outOfScope, /drops it\s+from the report's `Open blocking` count/);
  assert.match(outOfScope, /files it as contested — held open, not settled/);
  assert.match(outOfScope, /a challenge spends the one ruling that would have made it count/);
  // Round 9 wrote "the challenge would retire the finding", reasoning from
  // `isOpenBlocking` alone. Measured via `convergenceStatus`:
  // `defect`/`critical`/`disputed` -> openBlocking 0 but done FALSE, reason
  // "1 disputed". A challenge stalls the finding; it does not retire it, and it
  // does not hand it to the lane the challenger thinks should have had it.
  assert.doesNotMatch(outOfScope, /would retire the finding/);
  assert.doesNotMatch(outOfScope, /not\s+one of the confidences that hold a change open/);

  // The Steward's own half of the class is unchanged and still named — the
  // cession is of the missing bound, never of the contradiction about it.
  assert.match(outOfScope, /the contradiction is the finding, not the missing deadline/);
});

test('the README describes the same split as the personas do', () => {
  // Nothing in this suite read README.md before, which is how the change that
  // widened the Auditor's scope also left the README saying the Adversary names
  // "the bound nobody set" among the things "the Auditor won't think about".
  // Code-versus-claim drift, introduced by the same commit that made the claim
  // false — the Steward lane's own subject, on the one file no lane's tests
  // cover.
  //
  // Pinned to the sentence that states the partition, not to the whole file: a
  // README is prose and most of it is free to change.
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf-8')
    .replace(/\s+/g, ' ');

  // The Adversary rates against the load it can see. It does not own the
  // report, because it does not run on every diff — which is the whole reason
  // the Auditor's in-scope list carries the missing bound — and it does not own
  // the rating outright either, because the Auditor rates from the code.
  // "Rates what an unbounded operation costs when it runs out" was the earlier
  // wording and it stated the magnitude split the personas stopped making.
  assert.match(readme, /rates an unbounded operation against the load this deployment actually sees/);
  assert.match(readme, /the Auditor reports the missing bound itself and rates it on what the code shows, because it runs on every diff and the Adversary does not/);
  assert.doesNotMatch(readme, /rates what an unbounded operation costs when it runs out/);
  assert.doesNotMatch(readme, /and the bound nobody set/);
});

test('every persona hands off to every other persona by name', () => {
  // The exclusion lists are the handoff. A persona that never names another is
  // the one that will duplicate its lane.
  for (const p of all) {
    const scopeSplit = p.system.indexOf('out of scope');
    assert.ok(scopeSplit > 0, `${p.name} has no out-of-scope section`);
    const exclusions = p.system.slice(scopeSplit);
    for (const other of all) {
      if (other.name === p.name) continue;
      assert.ok(exclusions.includes(other.title),
        `${p.name} never hands off to ${other.title} — both may report the same finding, `
        + 'and two reports of one issue read as cross-validated consensus');
    }
  }
});

test('every persona names the kinds it emits', () => {
  for (const p of all) {
    for (const k of p.kinds) {
      assert.ok(p.system.includes(`\`${k}\``), `${p.name}'s prompt never mentions '${k}'`);
    }
  }
});

// The ownership map, pinned. The previous version of this test derived
// `soleOwner` from the very arrays it then asserted against, so its conclusion
// was true by construction and it could not fail for any input — including the
// input it existed to catch, a lane widened into a neighbor's ground. The
// fixture has to be written down independently of the code to be a test at all.
const OWNERSHIP = {
  defect:     ['auditor', 'adversary'],
  behavioral: ['auditor', 'adversary', 'steward'],
  contract:   ['steward'],
  design:     ['pragmatist'],
};

test('each kind is owned by exactly the personas the design assigns it', () => {
  for (const kind of KINDS) {
    const actual = all.filter((p) => p.kinds.includes(kind)).map((p) => p.name).sort();
    const expected = [...(OWNERSHIP[kind] ?? [])].sort();
    assert.deepEqual(actual, expected,
      `'${kind}' is owned by [${actual}], but the design assigns it to [${expected}]. `
      + 'Widening a lane costs findings; narrowing one leaves a kind unclaimed. '
      + 'If this is deliberate, change OWNERSHIP here and the table in personas.mjs.');
  }
});

test('the ownership fixture covers every kind, and invents none', () => {
  assert.deepEqual(Object.keys(OWNERSHIP).sort(), [...KINDS].sort());
});

test('design is owned by exactly one persona, because it cannot block', () => {
  // An advisory kind reported by two lanes would read as cross-validated
  // consensus on a finding that is not allowed to block anything.
  assert.equal(all.filter((p) => p.kinds.includes('design')).length, 1);
});

test('DEFAULT_PERSONAS matches the registry, in a stable order', () => {
  assert.deepEqual([...DEFAULT_PERSONAS], Object.keys(PERSONAS));
});

test('persona titles are distinct — the fake agent and the prompts key on them', () => {
  const titles = all.map((p) => p.title);
  assert.equal(new Set(titles).size, titles.length);
});

test('every lane that always runs solo explains itself from the registry', () => {
  // scaling.mjs reads `soloReason` when it says why a lane runs as one agent.
  // The registry was introduced to stop that rationale living at the call site,
  // and shipped with one entry and one exception — so the Pragmatist's reason
  // was still hard-coded in scaling.mjs, which is the drift it was preventing.
  for (const p of [PERSONAS.steward, PERSONAS.pragmatist]) {
    assert.equal(typeof p.soloReason, 'string', `${p.name} needs a soloReason`);
    assert.ok(p.soloReason.length > 10);
  }
});

// --- isLaneAgent: the id is about to be a filename -------------------------

test('isLaneAgent accepts the ids agentNames can emit, and the bare persona', () => {
  assert.equal(isLaneAgent('auditor', 'auditor'), true);
  for (const suffix of ['a', 'b', 'z']) {
    assert.equal(isLaneAgent('auditor', `auditor-${suffix}`), true, suffix);
  }
});

test('isLaneAgent bounds the suffix LENGTH, not only its alphabet', () => {
  // `/^[a-z]+$/` bounded the character class and not the length, and
  // repair.mjs interpolates the accepted id into a filename: a 300-letter
  // suffix passed this guard and died in writeFileSync with an uncaught
  // ENAMETOOLONG, which is not an exit code at all. `agentNames` emits one
  // letter, so nothing longer is an id this system produces.
  assert.equal(isLaneAgent('auditor', `auditor-${'a'.repeat(300)}`), false);
  assert.equal(isLaneAgent('auditor', 'auditor-ab'), false);
});

test('isLaneAgent refuses another lane, a bad separator, and a non-letter suffix', () => {
  for (const agent of ['adversary', 'adversary-a', 'auditor_a', 'auditor-', 'Auditor-a',
                       'auditor-1', 'auditor-A', 'auditor-a/b', '__proto__', '', null, 42]) {
    assert.equal(isLaneAgent('auditor', agent), false, JSON.stringify(agent));
  }
});

// --- advisoryOnlyLane: its callers, enumerated instead of counted ----------

// Every call site of `advisoryOnlyLane`, and the question that site decides.
// The header comment above the predicate in src/personas.mjs renders this
// table; the table lives HERE because this is the copy a test can check.
//
// It is written down rather than derived from the scan below, or it would be
// true by construction and could not fail. Every COUNT the prose copy ever
// carried was wrong: it said two questions turn on the predicate when three
// did, was corrected to "THREE", and left the sentence four lines below still
// reading "Both callers". So the count is gone from the prose and the names
// are checked from here instead.
// Keyed by the path from the repository root, not by basename, and that is not
// cosmetic: `CALLER_SCAN_DIRS` holds three directories and two of them contain
// a `regression.mjs`. On basenames a caller added under
// `skills/adverse-review/scripts/` collided with `src/`'s and could only be
// named in the header by a path that does not exist. Its sibling scan
// (`handSpelledLaneAgentRule`) was already dir-qualified; this one is now too,
// so the two agree.
const ADVISORY_ONLY_CALLERS = {
  'src/personas.mjs': 'crossReviews',
  'src/regression.mjs': 'ELIGIBLE',
  'src/scaling.mjs': 'sizeSkippable',
};

const SRC_DIR = new URL('../src/', import.meta.url);

// Every directory the sibling scan reads, for the reason that scan reads them:
// the fifth hand-spelled copy of the lane-agent rule lived in
// `skills/adverse-review/scripts/`, not in `src/`. Scanning only `src/` while
// the test's own name said "every call site" meant a caller added under
// `scripts/` passed 22/22 — verified by mutation before widening this.
const CALLER_SCAN_DIRS = ['src', 'bin', 'skills/adverse-review/scripts'];

// `src/` basenames that CALL the predicate. Comment lines are skipped — half
// the modules discuss it — and so is its own declaration; an `import` names it
// without a following paren and so never matches.
function callersOfAdvisoryOnlyLane() {
  const callers = [];

  for (const dir of CALLER_SCAN_DIRS) {
  const base = new URL(`../${dir}/`, import.meta.url);
  for (const name of readdirSync(base)) {
    if (!name.endsWith('.mjs')) continue;
    const calls = readFileSync(new URL(name, base), 'utf-8').split('\n')
      .filter((line) => line.includes('advisoryOnlyLane(')
        && !line.trimStart().startsWith('//')
        && !line.includes('function advisoryOnlyLane('));
    if (calls.length) callers.push(`${dir}/${name}`);
  }
  }

  return callers.sort();
}

// The `//` block immediately above the declaration, and not one line more: the
// whole file mentions these names in passing, so a loose slice would pass on
// prose that says nothing about the callers.
function advisoryOnlyLaneHeader() {
  const lines = readFileSync(new URL('personas.mjs', SRC_DIR), 'utf-8').split('\n');
  const declared = lines.findIndex((l) => l.startsWith('export function advisoryOnlyLane'));
  assert.ok(declared > 0, 'advisoryOnlyLane is not declared where this test looks for it');

  let first = declared;
  while (first > 0 && lines[first - 1].startsWith('//')) first -= 1;

  return lines.slice(first, declared).join('\n');
}

test('the advisoryOnlyLane caller table names every call site, and invents none', () => {
  assert.deepEqual(callersOfAdvisoryOnlyLane(), Object.keys(ADVISORY_ONLY_CALLERS).sort(),
    'a question turns on advisoryOnlyLane that ADVISORY_ONLY_CALLERS does not list, '
    + 'or it lists a module that no longer asks one. Those answers must never '
    + 'disagree, so a new caller is a deliberate edit here and in the table in '
    + 'src/personas.mjs.');
});

test('src/personas.mjs names each caller it answers for, rather than counting them', () => {
  const header = advisoryOnlyLaneHeader();
  for (const [file, symbol] of Object.entries(ADVISORY_ONLY_CALLERS)) {
    assert.ok(header.includes(file),
      `the comment above advisoryOnlyLane never names ${file}`);
    assert.ok(header.includes(symbol),
      `the comment above advisoryOnlyLane never names \`${symbol}\``);
  }
});

test('an unknown persona reaches its callers in the direction that gives it work', () => {
  // The claim in that comment, run. `advisoryOnlyLane` answering true for a
  // name the registry has never heard of would drop the lane from round 2 and
  // let a small diff skip it — silently, which is the direction this design
  // never takes. scaling.test.mjs pins the `sizeSkippable` half from its own
  // side; asserted here too because the conjunction is what the comment
  // promises, and one caller changing its mind would leave it half true.
  assert.equal(advisoryOnlyLane('scribe'), false, 'an unknown name read as advisory-only');
  assert.equal(crossReviews('scribe', 2), true, 'round 2 dropped an unrecognized lane');
  assert.equal(sizeSkippable('scribe'), false, 'a small diff skipped an unrecognized lane');
  // Not vacuous: the one real advisory-only lane answers the other way on
  // every one of them.
  assert.equal(advisoryOnlyLane('pragmatist'), true, 'the pragmatist is advisory-only');
  assert.equal(crossReviews('pragmatist', 2), false, 'the pragmatist has no round-2 claim');
  assert.equal(sizeSkippable('pragmatist'), true, 'the pragmatist is size-skippable');
});

// --- laneAgentOf: one rule, one default ------------------------------------
//
// `isLaneAgent` says whether an id is well formed; `laneAgentOf` says who to
// attribute the work to when it is not, which is the question every caller
// actually had. It exists because that answer was written out longhand once
// per module — src/synthesis.mjs's `claimedAgent`, src/briefing.mjs's ternary,
// and repair.mjs's, where the answer becomes a filename — and round 2's
// self-validation guard keys on it, so two of them disagreeing hands some
// agent an independent-looking vote on its own finding.

test('laneAgentOf keeps an id of this lane and substitutes the lane for anything else', () => {
  assert.equal(laneAgentOf('auditor', 'auditor-b'), 'auditor-b');
  assert.equal(laneAgentOf('auditor', 'auditor'), 'auditor');
  for (const claimed of ['steward-a', 'auditor_b', 'auditor-ab', 'auditor-', '', null, 42]) {
    assert.equal(laneAgentOf('auditor', claimed), 'auditor',
      `a claimed id of ${JSON.stringify(claimed)} was not coerced to its lane`);
  }
});

test('laneAgentOf returns the persona it was given, untouched', () => {
  // Callers read the lane off a JSON payload, so an absent one has to come
  // back absent rather than as the string "undefined" or a coerced ''.
  for (const persona of [null, undefined, 42]) {
    assert.equal(laneAgentOf(persona, 'auditor-a'), persona,
      `a lane of ${JSON.stringify(persona)} did not survive the call`);
  }
});

// Where the rule is still spelled by hand. `isLaneAgent` answers a second,
// legitimate question — "is this id well formed" — and the guards that ask it
// (src/regression.mjs, combine.mjs) are correct as written and are not listed
// here. What IS listed is a call that uses the answer as a ternary condition
// and supplies its own default, which is `laneAgentOf` written out longhand.
//
// src/briefing.mjs was a fourth, and repair.mjs's filename key a fifth. What
// remains is whatever this array lists — do not restate its length in prose,
// which is the defect the sibling table was built to delete and which this
// comment then reintroduced one commit later. Every `isLaneAgent` reference under src/, bin/ and
// skills/adverse-review/scripts/ was read to build this list; what the scan
// below cannot see is the same rule written as an `if`/`else` instead of a
// ternary, so this bounds the copies it can recognize and does not claim there
// can never be another.
const HAND_SPELLED_LANE_AGENT_RULE = [
  'src/synthesis.mjs',
];

// `isLaneAgent(...)` used as a ternary CONDITION — the longhand form. A guard
// that merely negates it, or a ternary that calls it in a branch, does not
// match. src/personas.mjs is skipped: the one there is the implementation.
//
// `?(?!?)`, because `??` is not a ternary: `find((p) => isLaneAgent(p, name))
// ?? null` asks WHICH LANE a name belongs to and defaults to "none of them",
// which is a different question from whose work an id names. Matching it sent
// src/telemetry.mjs a message telling it to call `laneAgentOf` — advice that
// would have made its answer wrong.
const LONGHAND = /isLaneAgent\(.*\)\s*\?(?!\?)/;
const SCANNED_DIRS = ['src', 'bin', 'skills/adverse-review/scripts'];

function handSpelledLaneAgentRule() {
  const root = new URL('../', import.meta.url);
  const sites = [];

  for (const dir of SCANNED_DIRS) {
    const dirUrl = new URL(`${dir}/`, root);
    for (const name of readdirSync(dirUrl)) {
      if (!name.endsWith('.mjs') || `${dir}/${name}` === 'src/personas.mjs') continue;
      const hits = readFileSync(new URL(name, dirUrl), 'utf-8').split('\n')
        .filter((line) => LONGHAND.test(line) && !line.trimStart().startsWith('//'));
      if (hits.length) sites.push(`${dir}/${name}`);
    }
  }

  return sites.sort();
}

test('the longhand detector recognizes the shape, and not the guards beside it', () => {
  // The check below loops over what the scan found, so a detector that matched
  // nothing would pass it vacuously forever. Pinned against literals here so
  // an empty scan means the copies are gone rather than the regex is broken.
  assert.ok(LONGHAND.test(
    'const agent = isLaneAgent(payload.persona, payload.agent) ? payload.agent : payload.persona;'));
  assert.ok(LONGHAND.test('return isLaneAgent(persona, claimed) ? claimed : null;'));
  assert.equal(LONGHAND.test('return lane === null || !isLaneAgent(lane, agent);'), false,
    'a guard that only negates the answer supplies no default and is not a copy');
  assert.equal(
    LONGHAND.test('if (legal ? !legal.includes(agent) : !isLaneAgent(persona, agent)) {'), false,
    'a ternary that calls it in a BRANCH is not the rule written longhand');
  assert.equal(
    LONGHAND.test('return PERSONAS.find((p) => isLaneAgent(p, name)) ?? null;'), false,
    'a nullish default on "which lane is this" is not the fallback rule');
});

test('no new module spells the lane-agent fallback by hand instead of calling laneAgentOf', () => {
  // A SUBSET check, deliberately: converting a listed site is an open handoff
  // and must not turn this red for whoever lands it, while a site the list does
  // not name must. Delete an entry here once its site calls `laneAgentOf`.
  //
  // The count is deliberately not written down. This is the THIRD prose count
  // of the same array to go stale — the first said "two questions" over three,
  // the second survived the commit that deleted its siblings, and this one said
  // "one of the two listed sites" beside a one-element list. The list is right
  // here; anyone who needs its length can read it.
  for (const site of handSpelledLaneAgentRule()) {
    assert.ok(HAND_SPELLED_LANE_AGENT_RULE.includes(site),
      `${site} decides whose work an agent id names with its own ternary. `
      + 'Call laneAgentOf from src/personas.mjs: the round-2 self-validation '
      + 'guard keys on that answer, so a copy that drifts hands an agent an '
      + 'independent-looking vote on its own finding.');
  }
});
