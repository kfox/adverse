#!/usr/bin/env node
// Skill bridge: combine N per-persona JSON files into a single keyed-by-persona
// JSON object that the synthesizer accepts.
//
// A duplicate persona across inputs is an error by default — it usually means
// the same file was passed twice. `--merge-personas <persona>` is the
// deliberate case: a lane split across two agents (a large diff, partitioned
// by file) produces two payloads under one persona name, and merging unions
// their findings, keeps the worse verdict, and joins both summaries
// (src/synthesis.mjs's mergeSplitReviews, so the combined payload and triage's
// briefing cannot disagree). The flag names the persona so the duplicate
// guard stays live for every lane that was NOT split — and a named persona
// must arrive in exactly two payloads: one half missing means half the diff
// got no reviewer, which is a degraded lane, not a quiet success.
//
// That holds in round 2 as well, where it used to be refused outright. The
// refusal's reasoning was correct for the code it was written against: two
// cross-reviews unioned under one persona name gave synthesis no way to tell
// which half ruled, so the self-validation guard discarded every ruling and
// the merge really did drop a payload's work. Now each entry is stamped with
// its own agent id, so unioning them is what makes a split lane's second
// round-2 agent worth spawning at all (kfox/adverse#50).
//
// Every persona is checked against the registry before it is used as a key.
// The persona string is model-written and untrusted: a prototype key
// (`__proto__`) used to vanish a whole review into Object.prototype, and a
// re-cased name (`Auditor`) used to mint a phantom fifth reviewer whose
// agreement with its own other half read as cross-lane consensus.

import { parseArgs } from 'node:util';
import { writeFileSync } from 'node:fs';

import { readJson, readPlanLanes, reportRoster, usage } from './bridge-io.mjs';

import { importFromSrc } from './package-root.mjs';

const { mergeSplitCrossReviews, mergeSplitReviews, normalizeVerdict } =
  await importFromSrc('synthesis.mjs');
const { checkRoster } = await importFromSrc('roster.mjs');
const { isLaneAgent } = await importFromSrc('personas.mjs');
const { agentNames } = await importFromSrc('scaling.mjs');

const { values, positionals } = parseArgs({
  options: {
    round1: { type: 'string', multiple: true },
    round2: { type: 'string', multiple: true },
    out:    { type: 'string' },
    'merge-personas': { type: 'string', multiple: true },
    plan:   { type: 'string' },
  },
  allowPositionals: true,
  strict: true,
});

if (!values.out) {
  usage('Usage: combine.mjs (--round1 | --round2) a.json b.json …'
    + ' [--merge-personas <persona>]… [--plan plan.json] --out <combined.json>');
}

const hasRound1 = values.round1 !== undefined;
const hasRound2 = values.round2 !== undefined;
if (hasRound1 === hasRound2) {
  process.stderr.write('combine: provide exactly one of --round1 or --round2\n');
  process.exit(2);
}

const inputs = [...(values.round1 ?? values.round2), ...positionals];
const planLanes = values.plan ? readPlanLanes(values.plan, 'combine') : null;
const payloads = inputs.map((src) => ({ src, payload: readJson(src, 'combine') }));

// Who counts as a reviewer — src/roster.mjs, the same rules triage.mjs applies
// to the same payloads one phase earlier.
const roster = checkRoster(
  payloads.map(({ src, payload }) => ({ persona: payload?.persona, src })),
  {
    lanes: planLanes,
    explicitMerges: values['merge-personas'] ?? [],
    round: hasRound2 ? 2 : 1,
  },
);
reportRoster(roster, 'combine');

// The ids of one declared split lane, from the plan that named the split —
// `agentNames` is the same function Phase 1 used to name the worktrees and the
// files, so this is the roster the orchestrator actually spawned. Null when
// the plan does not split this persona: `--merge-personas` alone declares a
// split the plan has no roster for, and shape is then all there is to check.
//
// Null when the roster comes back EMPTY, not merely when there is no lane:
// `agentNames` starts with `runLanes`, so a plan lane of
// `{run: false, agents: 2}` — which `parseLane` accepts, since its floor is 0
// when `run` is false — yields `[]`, and `[]` is truthy. The membership check
// then read an empty expectation as "no id is legal" and refused both honest
// halves with a message whose remedy line was blank: "expected ". Unreachable
// today because `reportRoster` refuses a payload from a `run: false` lane
// first, but the guard failed toward rejecting honest input with no way to
// read why, so it fails to the shape check instead.
function laneAgents(persona) {
  const lane = planLanes?.find((l) => l.persona === persona);
  const names = lane && lane.agents > 1 ? agentNames([lane]) : [];
  return names.length ? names : null;
}

// Belt and braces on the identity validate.mjs binds to each payload's
// filename. This is the MERGE site: two payloads become one lane here, and the
// per-entry stamp that makes the merge safe is only worth as much as the two
// ids being present, distinct, and this lane's. `checkRoster` counts payloads
// and never reads one, so both ways that goes wrong were invisible:
//
//   - both halves declaring ONE id: the agent that wrote the other half is
//     stamped with its sibling's name, and its round-2 ruling on its own
//     finding counts as independent — a cross-validated critical drops to
//     `disputed` and out of the open-blocking count;
//   - a half declaring NONE: its entries are stamped with the bare persona,
//     which `reportedBy` reads as "the whole lane reported this" and uses to
//     discard its sibling's honest ruling. Immunity from cross-examination for
//     the price of one omitted optional field.
//
// The default is named explicitly: a lane that was NOT declared split is not
// checked here at all. It has one payload, so there is no sibling to be
// confused with, and its `agent` was already held against its own filename by
// validate.mjs.
function splitAgentProblems(persona, halves) {
  const legal = laneAgents(persona);
  const expected = legal ? legal.join(' or ') : `'${persona}-<letter>'`;
  const claimedBy = new Map();
  const problems = [];
  for (const { src, payload } of halves) {
    const agent = payload?.agent;
    if (typeof agent !== 'string' || !agent) {
      problems.push(`${src}: '${persona}' is a declared split lane, so this payload has to`
        + ` say which half wrote it: \`agent\` must be ${expected}.\n`
        + '  An unlabeled half is stamped with the bare persona, and its sibling\'s ruling'
        + ' on it is then discarded as the lane validating itself.');
      continue;
    }
    if (legal ? !legal.includes(agent) : !isLaneAgent(persona, agent)) {
      problems.push(`${src}: \`agent\` ${JSON.stringify(agent)} is not an agent of the`
        + ` '${persona}' lane: expected ${expected}.`);
      continue;
    }
    const first = claimedBy.get(agent);
    if (first) {
      problems.push(`${src}: \`agent\` ${JSON.stringify(agent)} was already claimed by`
        + ` ${first} — two halves cannot be one agent.\n`
        + '  Whichever of the two is lying about its half now has its sibling\'s name on'
        + ' its findings, and its ruling on its own work would count as independent.'
        + ' The filename each was written to says which id it owes.');
      continue;
    }
    claimedBy.set(agent, src);
  }
  return problems;
}

const idProblems = [...roster.merged].flatMap((persona) => splitAgentProblems(
  persona, payloads.filter(({ payload }) => payload?.persona === persona)));
if (idProblems.length) {
  // Exit 1, the same way a duplicate persona is refused: these payloads read
  // fine and fail a domain check, which is a claim about a review.
  for (const message of idProblems) process.stderr.write(`combine: ${message}\n`);
  process.exit(1);
}

// Null prototype: the persona string indexes this map, and a plain object
// would answer `__proto__` with something truthy.
const combined = Object.create(null);
// A split lane's two halves union differently per round — findings, verdict and
// summaries in round 1; validate, challenge, groups and added in round 2 — but
// both stamp every entry with the agent that produced it. That stamp is what
// makes the round-2 merge safe at all: without it both halves' rulings arrive
// under one persona name and synthesis discards them as the lane validating
// itself, which is the reason this was refused before kfox/adverse#50.
//
// "Safe" reads on the stamps being TRUE, which the merge itself cannot tell —
// hence the id check above, and validate.mjs binding each id to the filename
// its payload was written to before this bridge ever sees it.
const merge = hasRound2 ? mergeSplitCrossReviews : mergeSplitReviews;
for (const { src, payload } of payloads) {
  if (hasRound1) {
    // Off-contract verdicts degrade to `reject`, loudly: synthesis scores an
    // unknown string as neutral and counts only the literal `reject` as a
    // block, so passing garbage through is the direction that erases a real
    // rejection.
    const norm = normalizeVerdict(payload.verdict);
    if (norm !== payload.verdict) {
      process.stderr.write(`combine: ${src}: verdict ${JSON.stringify(payload.verdict)} is off-contract; recorded as 'reject'\n`);
      payload.verdict = norm;
    }
  }
  // Duplicates that are not a declared split lane were refused above, so a
  // second payload here is a half of one.
  const existing = combined[payload.persona];
  combined[payload.persona] = existing ? merge(existing, payload) : payload;
}

writeFileSync(values.out, JSON.stringify(combined, null, 2), 'utf-8');

process.stdout.write(`combined ${inputs.length} reviews -> ${values.out}\n`);
