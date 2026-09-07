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

// `provenance` is deliberately NOT gated here, and that is a correction rather
// than an omission. It was gated in 1138977 on the reasoning that combine is a
// reader of the field which a run skipping validate.mjs reaches — true of the
// field, wrong about this bridge. combine's inputs are BOTH agent payloads and
// `regression.mjs`'s own fold, and that fold stamps `provenance` on its header
// and on every finding because stamping it is the fold's job. Measured on the
// bridge's real output: exit 1, with advice ("Remove the key") that would delete
// the regression note from the report. `tests/combine.test.mjs` pins the fold
// being accepted.
//
// Telling the two apart here would mean trusting the filename to say which
// bridge wrote a file, which is exactly the authority this batch established it
// does not have. So the gate lives where agent payloads ENTER — validate.mjs
// for round 1 and round 2, verify.mjs for Phase 9 verification, and
// regression.mjs's own readPayload — and the answer to "a run that skips
// validate.mjs" is to not skip it.

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

// Does this payload DECLARE a half id at all? Not "declare a well-formed one":
// `payloadAgent` in src/synthesis.mjs resolves an ill-formed value to the bare
// persona, so `agent: 42` is a half that will be stamped with the whole lane
// while looking labeled. Answering yes here routes it to the membership check
// below, which says so out loud, instead of the missing-id branch, which would
// pass it over as an omission. Distinct from src/synthesis.mjs's
// `claimedAgent`, which asks whether a declared id is this lane's.
function declaresAgent(payload) {
  const agent = payload?.agent;
  return agent !== undefined && agent !== null && agent !== '';
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
//   - one half declaring NONE while the other declares an id: the unlabeled
//     half's entries are stamped with the bare persona, which `reportedBy`
//     reads as "the whole lane reported this" and uses to discard its
//     sibling's honest ruling. Immunity from cross-examination for the price
//     of one omitted optional field. Measured end to end on a mixed pair:
//     `validators: []` and `confidence: "solo"` where the same review with
//     both halves labeled records `consensus`.
//
// Only the second bullet reads on the population, and only for PRESENCE.
// Membership and distinctness are checked for every merged lane either way.
// Under a plan that declared the lane split, presence is required of every
// half: the plan says how many halves exist. Under `--merge-personas` alone
// there is no roster, and two halves with NO id are the Phase 9 fold's verify
// and regression legs (neither verify.mjs nor regression.mjs emits the field)
// rather than a split — so presence is required there only of a pair where
// some half DOES claim an id, which is a missing half and not a leg. That
// distinction needs no plan, only the sibling.
//
// A pair where NEITHER half claims an id passes this site, and the layer that
// still catches an unlabeled half of a genuinely split lane is validate.mjs:
// `identityFromPath` reads the half off the filename, and `validateAgent`
// (src/prompts.mjs) refuses a payload written to `round1-auditor-b.json` that
// omits the field.
//
// The default is named explicitly: a lane that neither the plan nor the flag
// declared split is not checked here at all. It has one payload, so there is
// no sibling to be confused with, and its `agent` was already held against its
// own filename by validate.mjs.
//
// `legal` is the plan's id list for this lane, or null when no plan declared it
// split. Only presence reads on that difference — see the two branches below.
function splitAgentProblems(persona, legal, halves) {
  const expected = legal ? legal.join(' or ') : `'${persona}-<letter>'`;
  const claimedBy = new Map();
  const problems = [];
  // The half that turns an unlabeled sibling into a MISSING half. Null when no
  // half claims anything, which is the accepted two-leg fold.
  const claimant = halves.find(({ payload }) => declaresAgent(payload));
  for (const { src, payload } of halves) {
    const agent = payload?.agent;
    if (!declaresAgent(payload)) {
      if (legal) {
        problems.push(`${src}: '${persona}' is a declared split lane, so this payload has to`
          + ` say which half wrote it: \`agent\` must be ${expected}.\n`
          + '  An unlabeled half is stamped with the bare persona, and its sibling\'s ruling'
          + ' on it is then discarded as the lane validating itself.');
      } else if (claimant) {
        problems.push(`${src}: ${claimant.src} declares`
          + ` \`agent\` ${JSON.stringify(claimant.payload.agent)}, so this payload has to say`
          + ` which half wrote it too: \`agent\` must be ${expected}.\n`
          + '  Two halves that BOTH omit the field are one lane\'s verify and regression legs,'
          + ' which is why an unlabeled pair is accepted here. One id beside one omission is a'
          + ' missing half instead: the unlabeled half is stamped with the bare persona, and'
          + ' its sibling\'s ruling on it is then discarded as the lane validating itself,'
          + ' which turns a consensus finding into a solo one.');
      }
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

// Every merged persona is checked, but for what differs by population.
// `roster.merged` unions the plan's split lanes with the raw `--merge-personas`
// values, and that flag is also how Phase 9 folds one lane's verify and
// regression payloads — so membership and distinctness (which any claimed id
// must satisfy either way) are enforced for all of them, and presence wherever
// something says a second half exists: `laneAgents` reporting a plan-declared
// split, or, with no plan, a sibling that declares a half id of its own.
const idProblems = [...roster.merged].flatMap((persona) => splitAgentProblems(
  persona, laneAgents(persona),
  payloads.filter(({ payload }) => payload?.persona === persona)));
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
