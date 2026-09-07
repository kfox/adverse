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
import { assessScope } from './scope.mjs';

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
// The Pragmatist appears in neither, and that is the point rather than an
// oversight: it owns only `design`, every design finding is advisory, and a
// pass that can only produce findings which cannot block is a pass that cannot
// report the thing it was run for.
const CANDIDATE_ORDER = Object.freeze({
  boundary: Object.freeze(['adversary', 'auditor', 'steward']),
  routine: Object.freeze(['auditor', 'steward', 'adversary']),
});

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

// The LANE an agent id belongs to, or null. A split lane's halves report as
// `auditor-a` and `auditor-b`, so exclusion keyed on the raw string would let
// `auditor-b` review the fix for `auditor-a`'s finding — the same lane checking
// its own work under a different name, which is the silent direction and the
// only one that matters here.
function laneOf(agent) {
  if (typeof agent !== 'string') return null;
  return DEFAULT_PERSONAS.find((persona) => isLaneAgent(persona, agent)) ?? null;
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
export function chooseRegressionLane({ closedBy = [], files = [], diff = '' } = {}) {
  const scope = assessScope({ files, diff });
  const boundary = scope.recommend === 'run';
  const order = boundary ? CANDIDATE_ORDER.boundary : CANDIDATE_ORDER.routine;
  const lens = boundary
    ? `the fix diff crosses a trust boundary (${scope.reason})`
    : `the fix diff crosses no trust boundary (${scope.reason})`;

  const reported = new Set();
  for (const agent of Array.isArray(closedBy) ? closedBy : []) {
    const lane = laneOf(agent);
    if (lane) reported.add(lane);
  }

  const disinterested = order.find((persona) => !reported.has(persona));
  if (disinterested) {
    return {
      persona: disinterested,
      conflicted: false,
      reason: `${disinterested}: ${lens}, and it reported none of the findings this`
        + ' commit closed',
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
    reason: `${order[0]}: ${lens}, but every lane that can hold a regression `
      + `(${order.join(', ')}) reported a finding this commit closed, so this pass is run by`
      + ' one of them. Read its silence knowing it was already invested in this fix.',
  };
}
