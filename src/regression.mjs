// Which lane reads a fix commit for what else it changed.
//
// Phase 9 verifies a fix with the ORIGINAL REPORTER's persona, and that is the
// right lens for the question it asks: judging whether a finding is closed
// needs the lens that produced it. It is close to the worst available lens for
// the other question — *what else did this diff change* — because the reporter
// is the agent most invested in the finding being closed. So the regression
// pass runs in a lane that did not report into the commit, and no model picks
// it: the one choice an interested party must not make is which disinterested
// party checks its work.
//
// The failure this exists for was measured, not imagined. Iteration 1 of one
// campaign fixed 25 findings; iteration 2 found 40, at least one of them
// created by iteration 1 — new warning paths added by a fix became fresh
// per-message work inside a bounded drain loop, so the bound stopped bounding.
// The fix was correct in isolation and wrong in context, which is the shape
// nobody catches by reading a diff for correctness.
//
// This is a routing decision, not a security judgment: it says who reads the
// commit, never whether the commit is safe.

import { DEFAULT_PERSONAS, advisoryOnlyLane, isLaneAgent } from './personas.mjs';
import { SCOPE_TRIGGER, assessScope } from './scope.mjs';

// The candidate order, best lens first — and the tail matters as much as the
// head, because the first choice is routinely excluded and the second is then
// a decision rather than an accident.
//
// With a trust boundary in the fix diff the Adversary leads, for the reason
// src/scope.mjs gives: on a change that touches a control plane it is the most
// valuable reviewer on the panel. Without one it goes LAST, by the same
// argument read backwards — it has nothing to look at and spends its call
// saying so — which puts the Steward ahead of it, because a fix that quietly
// changed what the code says about itself (a default, a documented bound, a
// changelog that now lies) is exactly the middle category this pass exists to
// give a channel to.
//
// Which of these two an assessment selects is `LENS` below, not `recommend`
// alone: the gate has more than one reason to recommend running, and only one
// of them is a boundary.
//
// The Pragmatist appears in neither, and that is the point rather than an
// oversight: it owns only `design`, every design finding is advisory, and a
// pass that can only produce findings which cannot block is a pass that cannot
// report the thing it was run for.
const CANDIDATE_ORDER = Object.freeze({
  boundary: Object.freeze(['adversary', 'auditor', 'steward']),
  routine: Object.freeze(['auditor', 'steward', 'adversary']),
});

// What the scope gate's answer means here: which order it selects, and the
// clause the artifact prints. One table, because the two used to be derived
// separately from `scope.recommend === 'run'` and that one boolean now stands
// for three different findings.
//
// `boundary` is the only one that may say a boundary was crossed. It used to
// say it for all three, and for the span-limit backstop both halves were
// false: a README-only fix commit whose one added line was 211 characters of
// prose read back as "the fix diff crosses a trust boundary (trust-boundary
// signals present (0 in paths, 1 in added code, 0 in removed code))".
//
// `unreadable` keeps the ROUTINE order, and that is a decision rather than a
// leftover. The boundary order's head position is earned by a positive fact —
// "this change touches a control plane, where the Adversary is the most
// valuable reviewer on the panel". A line too long for a bounded span
// establishes only that the gate could not read it, which is an absence of
// knowledge, and leading with the Adversary on an absence inverts the very
// rationale the order is built on. Two things follow from that:
//
//   - The population is prose. 57 lines of this repository's own tracked files
//     run past the limit, 39 of them in one README, and a signal that fires on
//     most documentation commits carries no information about boundaries — the
//     failure src/scope.mjs's PATH_SIGNALS list was pruned to avoid.
//   - "Noisy" is not additive here. In `planReview` an Adversary that runs on a
//     hunch costs two model calls and takes nothing away. This pass runs ONE
//     lane, so choosing the Adversary is choosing to lose the Steward's read —
//     and the Steward goes from second to LAST. A documentation-only fix commit
//     is the archetype of the middle category the comment above says the
//     Steward is placed ahead of the Adversary to catch.
//
// The Adversary is not excluded, only third, and the clause names the
// unreadable line out loud rather than hiding the demotion. Any genuine signal
// on the same diff still reports `boundary`, unreadable lines merely appended
// to its reason — so the only diffs this moves to `routine` are the ones where
// the gate found no boundary signal at all.
//
// `no-file-list` stays on the boundary order: nothing was read, not even a
// path, so there is no basis for calling the commit routine. Only its wording
// changes, from asserting a boundary to admitting it could not look.
const LENS = Object.freeze({
  [SCOPE_TRIGGER.boundary]: Object.freeze({
    order: 'boundary', clause: 'the fix diff crosses a trust boundary',
  }),
  // `boundary`, not `routine`, and the reasoning that first put `routine` here
  // had it exactly backwards. An unreadable line does establish only that the
  // gate could not read it — but the way a line becomes unreadable is that
  // something padded it past a bounded span, and several CONTENT_SIGNALS are
  // bounded spans between two literals (`/\bSELECT\b.{0,200}?\bFROM\b/is`).
  // So this trigger is precisely the signal-DEFEATED case, which makes it the
  // Adversary's highest-value input rather than its lowest. Measured: a line
  // with 710 characters of column list between SELECT and FROM, wrapping
  // `req.params.id` into a raw query, selected `adversary` before the trigger
  // existed and `auditor` after — while `assessScope` still said `run` both
  // times, so `planReview` was unaffected and only this one-lane choice moved.
  // The clause stays as it is: the sentence was never the part that was wrong.
  [SCOPE_TRIGGER.unreadable]: Object.freeze({
    order: 'boundary', clause: 'the fix diff holds lines no signal could read',
  }),
  [SCOPE_TRIGGER.noFileList]: Object.freeze({
    order: 'boundary', clause: 'the fix diff could not be assessed for a trust boundary',
  }),
  [SCOPE_TRIGGER.none]: Object.freeze({
    order: 'routine', clause: 'the fix diff crosses no trust boundary',
  }),
});

// A trigger the gate can return and this table does not word would fall
// through to a sentence that says nothing, or to `undefined` in the middle of
// the artifact. Checked at module load for the same reason CANDIDATE_ORDER is
// below: the unmatched classifier input that silently does nothing is the shape
// every convergence leak in this project has had.
for (const trigger of Object.values(SCOPE_TRIGGER)) {
  const lens = LENS[trigger];
  /* c8 ignore next 4 */
  if (!lens || !CANDIDATE_ORDER[lens.order]) {
    throw new Error(`regression: scope trigger '${trigger}' has no lens`
      + `${lens ? ` order (CANDIDATE_ORDER.${lens.order} does not exist)` : ''}`);
  }
}

// The lanes that can hold a regression, read off the registry.
const ELIGIBLE = DEFAULT_PERSONAS.filter((p) => !advisoryOnlyLane(p));

// A lane added to the registry and forgotten in the orders above would simply
// never be chosen, and nothing would say so — the classifier whose unmatched
// input silently does nothing, which is the shape every convergence leak in
// this project has had. Checked at module load, so a new lane is a loud
// failure at import rather than a quiet absence in one pass a month later.
for (const [name, order] of Object.entries(CANDIDATE_ORDER)) {
  const missing = ELIGIBLE.filter((p) => !order.includes(p));
  const unknown = order.filter((p) => !ELIGIBLE.includes(p));
  /* c8 ignore next 4 */
  if (missing.length || unknown.length) {
    throw new Error(`regression: CANDIDATE_ORDER.${name} is out of step with the registry`
      + `${missing.length ? `; missing ${missing.join(', ')}` : ''}`
      + `${unknown.length ? `; cannot hold a regression: ${unknown.join(', ')}` : ''}`);
  }
}

// A prefix match below decides which lane an id names, and `find` returns the
// first hit — so a registry where one persona name prefixes another's agent
// namespace would exclude the wrong lane, silently. Checked at module load for
// the same reason CANDIDATE_ORDER is: a new lane should be a loud failure at
// import, not a misrouted pass a month later.
for (const persona of DEFAULT_PERSONAS) {
  const shadowed = DEFAULT_PERSONAS.filter((p) => p !== persona && p.startsWith(`${persona}-`));
  /* c8 ignore next 4 */
  if (shadowed.length) {
    throw new Error(`regression: persona '${persona}' prefixes ${shadowed.join(', ')},`
      + " so an agent id cannot say which lane it belongs to");
  }
}

// The LANE an agent id names — GENEROUSLY, and that is the whole design of it.
//
// A split lane's halves report as `auditor-a` and `auditor-b`, so exclusion
// keyed on the raw string would let `auditor-b` review the fix for `auditor-a`'s
// finding: the same lane checking its own work under a different name.
//
// This used to ask `isLaneAgent`, which is an EXACTNESS test — is this an id
// this system could have emitted — and exactness is the wrong question here,
// because a `null` means "exclude nobody". A concurrent commit tightened
// `isLaneAgent`'s suffix from `/^[a-z]+$/` to `/^[a-z]$/`, and that moved a
// whole class of strings from fail-safe to fail-unsafe with nothing in this
// file changing. Both arms measured:
//
//   closedBy: ['auditor-ab']  suffix /^[a-z]+$/ -> steward   (auditor excluded)
//                             suffix /^[a-z]$/  -> auditor   (auditor reviews
//                                                             its own fix)
//
// So the rule is: if the id names a lane at all, that lane is out. Over-
// excluding costs at worst a CONFLICTED pass, which says so out loud; under-
// excluding hands the reporter its own fix commit under a sentence asserting
// disinterest. Where one direction is noisy and the other silent, take noisy.
//
// Case is deliberately NOT folded. `Auditor` stays unresolved here, because
// lane identity is case-sensitive in `requireKnownPersona`, `combine.mjs` and
// `validate.mjs`, and a fifth rule that disagreed with those four is the second
// signal table this module's own header warns against. The bridge refuses it by
// value instead.
function laneOf(agent) {
  if (typeof agent !== 'string') return null;
  return DEFAULT_PERSONAS.find((p) => agent === p || agent.startsWith(`${p}-`)) ?? null;
}

// The three input shapes this module refuses to guess at, because guessing at
// any of them is the SAME fail-open: a non-list `closedBy` read as "no name in
// here is unreadable", a non-list `files` iterated character by character, and
// a non-string `diff` stringified into something with no added lines in it. Two
// of those three end at "looked and found no trust boundary" and the third at
// "nobody to exclude", and all three are silent. There is no shape-tolerant
// answer here that is not a claim about a commit nobody read.
function shapeOf(value) {
  if (value === null) return 'null';
  return Array.isArray(value) ? 'array' : typeof value;
}

function requireArray(value, label) {
  if (Array.isArray(value)) return value;
  throw new TypeError(`regression: ${label} must be an array, got ${shapeOf(value)}`);
}

function requireString(value, label) {
  if (typeof value === 'string') return value;
  throw new TypeError(`regression: ${label} must be a string, got ${shapeOf(value)}`);
}

// The `closedBy` entries that are not an agent id this review produces, in the
// order given — `Auditor` (a persona this registry does not spell that way),
// `auditor_a` (not the id shape), `auditor-ab` (a lane, but not a half
// `agentNames` can emit), a null, a number.
//
// This is the EXACT question, and it is a different one from `laneOf`'s: not
// "which lane is out" but "did the caller name something this system could have
// written". Both are needed and each is safe for its own question. `laneOf`
// being generous keeps the routing fail-safe for any caller; this keeps the
// caller from being silently guessed at.
//
// The silence was the defect, not the routing. `--closed-by Auditor
// --closed-by adversary` differs from the accepted spelling by one capital
// letter, exited 0, and put the lane that reported the finding in charge of
// reviewing its own fix — under a `reason` reading "it reported none of the
// findings this commit closed". A wrong lane is recoverable; an artifact
// asserting disinterest it does not have is not.
//
// Returned rather than thrown because the exit code belongs to the caller: the
// skill bridge refuses the run at exit 2 (skills/adverse-review/scripts/
// regression.mjs), and `chooseRegressionLane` carries it in both the
// `unresolved` field and the `reason` it signs.
//
// The ARGUMENT is a list, and a non-list is a caller bug this will not guess
// at. `Array.isArray(closedBy) ? closedBy : []` read a string, an object or a
// number as "a list with no unreadable names in it" — the same fail-open as an
// omitted flag, reached by passing the wrong shape: `unresolvedLanes('auditor')`
// answered `[]`, the bridge read that as "every name checks out", and every
// lane stayed eligible including the one that reported the fix. Wrapping the
// value in a list instead would not have closed it either, because the
// plausible mistake is a single well-formed name (`--closed-by` before
// `multiple: true`), which resolves and so reports nothing. Only the shape can
// be refused, so the shape is refused here.
export function unresolvedLanes(closedBy) {
  requireArray(closedBy, 'closedBy');
  return closedBy.filter((agent) => {
    const lane = laneOf(agent);
    return lane === null || !isLaneAgent(lane, agent);
  });
}

// What makes an exclusion input USABLE, written down because the DEFAULT is a
// refusal and a default nobody writes down is a default nobody checked.
//
// Usable, and nothing else is:
//
//   closedBy: ['auditor', 'steward-b', …]   one or more ids; every lane any of
//                                           them names is out of the running
//   closesNothing: true                     the caller's explicit claim that
//                                           this commit closes no finding any
//                                           lane reported, so nothing is
//                                           excluded and the artifact says on
//                                           whose word
//
// The default — the key omitted, `[]`, `null`, a bare string, a number, or both
// forms at once — throws. `closedBy = []` used to be the default, and `[]` is
// indistinguishable from "I forgot the flag": the pass then took the first lane
// in the preference order and signed a `reason` reading "it reported none of the
// findings this commit closed", which is the exact fail-open this module exists
// to prevent, reached by typing LESS rather than by typing something wrong.
// Measured on the bridge before this guard: `regression.mjs --repo . --commit
// HEAD` with no `--closed-by` at all exited 0 and printed
// "auditor: … and it reported none of the findings this commit closed".
//
// Thrown, not returned, and that is a different call from `unresolvedLanes`'.
// There a lane still has to be chosen and the caller owns the exit code. Here
// no lane can be chosen honestly — every return value asserts a disinterest
// nothing checked — and a throw is the one answer no caller can mistake for a
// clean artifact.
function requireExclusionInput(closedBy, closesNothing) {
  const given = closedBy !== undefined && closedBy !== null;
  if (given) requireArray(closedBy, 'closedBy');
  const named = given && closedBy.length > 0;

  if (closesNothing && named) {
    throw new TypeError('regression: closesNothing contradicts the'
      + ` ${closedBy.length} name(s) in closedBy — a commit either closes findings some lane`
      + ' reported or it does not');
  }
  if (!closesNothing && !named) {
    throw new TypeError('regression: closedBy must name at least one agent id that reported a'
      + ' finding this commit closed; pass closesNothing: true to state that none did.'
      + ' An empty or absent list would make this pass claim a disinterest nothing checked');
  }
}

// `closedBy` is the set of personas (or split-lane agent ids) that reported the
// findings this commit closed. `files` and `diff` describe the fix commit, and
// are handed straight to assessScope — the Adversary's gate everywhere else in
// this tool, so the choice reads one signal table instead of a second one that
// can disagree with it. Its bias is one-directional on purpose (an unreadable
// or absent diff recommends running), and the same bias is right here: the cost
// of the Adversary reading a fix commit with no boundary in it is one model
// call, and the cost of the Auditor reading one that has a boundary in it is a
// vulnerability nobody looked for.
//
// `closesNothing` is the caller stating, on the record, that this commit closes
// no finding any lane reported. It is the only way to run the pass with nothing
// excluded, and it exists so that omitting `closedBy` cannot be that way: see
// `requireExclusionInput`.
export function chooseRegressionLane(
  { closedBy, files = [], diff = '', closesNothing = false } = {}) {
  requireExclusionInput(closedBy, closesNothing);
  const names = closedBy ?? [];
  const scope = assessScope(
    { files: requireArray(files, 'files'), diff: requireString(diff, 'diff') });
  // Read off the trigger, never off `recommend`: three of the gate's four
  // answers recommend running and only one of them is a boundary.
  //
  // A trigger with no lens is refused rather than defaulted. The module-load
  // check above covers every value SCOPE_TRIGGER names, so reaching here means
  // the gate answered something this file has never heard of — and every
  // available default would put a sentence about a boundary into an artifact
  // on the strength of an assessment nobody in this file can read.
  const lensFor = LENS[scope.trigger];
  if (!lensFor) {
    throw new TypeError('regression: the scope gate answered with trigger'
      + ` ${JSON.stringify(scope.trigger)}, which names no lens; refusing to word a`
      + ' trust-boundary claim off an assessment this module cannot read');
  }
  const order = CANDIDATE_ORDER[lensFor.order];
  const lens = `${lensFor.clause} (${scope.reason})`;

  const reported = new Set();
  for (const agent of names) {
    const lane = laneOf(agent);
    if (lane) reported.add(lane);
  }

  const unresolved = unresolvedLanes(names);
  // The caveat rides in the sentence the artifact prints, not only in the field
  // beside it: the harm was never the lane chosen, it was a `reason` claiming
  // the pass is disinterested while part of the exclusion list had been
  // discarded in silence. It says what it could not read and makes no claim
  // about what that did or did not exclude — `laneOf` is generous, so an id
  // like `auditor-ab` is unreadable AND still excluded the auditor, and a
  // sentence asserting either half would be false for the other.
  const dropped = unresolved.length
    ? `, though ${unresolved.map((n) => JSON.stringify(n)).join(', ')} named no agent id this`
      + ' review produces — read the exclusion above as approximate'
    : '';

  // Whose word the disinterest rests on. With a list, the sentence is checked
  // against it. Under `closesNothing` there is no list to check it against, so
  // the sentence attributes the claim instead of asserting it — an artifact
  // that says "it reported none of the findings this commit closed" when
  // nothing was excluded is the fail-open in prose, and it reads identically to
  // a pass that really was disinterested.
  const disinterest = closesNothing
    ? 'the caller declared that this commit closes no finding any lane reported, so no lane'
      + ' was excluded on this run'
    : 'it reported none of the findings this commit closed';

  const disinterested = order.find((persona) => !reported.has(persona));
  if (disinterested) {
    return {
      persona: disinterested,
      conflicted: false,
      unresolved,
      reason: `${disinterested}: ${lens}, and ${disinterest}${dropped}`,
    };
  }

  // Exclusion emptied the set: every lane that can hold a regression reported
  // one of the findings this commit closed. The pass runs anyway, in the same
  // preference order over the full set, and says so. Skipping is the silent
  // direction — a skipped pass reads exactly like a clean one, which is the
  // failure src/scope.mjs states for a skipped lane and is worse here, because
  // nothing else in the flow is asking this question at all.
  return {
    persona: order[0],
    conflicted: true,
    unresolved,
    reason: `${order[0]}: ${lens}, but every lane that can hold a regression `
      + `(${order.join(', ')}) reported a finding this commit closed, so this pass is run by`
      + ` one of them${dropped}. Read its silence knowing it was already invested in this fix.`,
  };
}
