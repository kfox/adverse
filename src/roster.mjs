// Who counts as a reviewer in this run.
//
// The persona string is model-written and it keys everything downstream: the
// output filename of three bridges, the briefing's verdicts, cluster consensus
// (`reporters.size >= 2`), cross-references (`a.reporter !== b.reporter`), and
// the synthesizer's count of DISTINCT personas. A re-cased or invented name
// mints a phantom reviewer whose agreement with its own other half reads as two
// independent lanes; a repeated one silently overwrites the lane that wrote
// first. Consensus is this tool's entire product and this is the cheapest way
// to counterfeit it.
//
// These rules existed in two copies — one in the triage bridge, one in
// combine — and had already drifted three ways: only combine's `not run`
// message named the override that fixes it, only combine warned about a lane
// that ran and sent nothing, and only combine checked that a payload was an
// object at all, so a `findings: 7` payload crashed triage with a TypeError
// and a stack trace against a contract that says a bridge which could not read
// its input exits 2. One implementation, both bridges.
//
// Pure: it returns problems rather than writing them, because the exit codes
// are part of the bridges' tested contract and a module that exits cannot be
// asked what it would have said. `checkBinding` in ledger.mjs already answers
// this shape.

import { DEFAULT_PERSONAS, crossReviews } from './personas.mjs';
import { runLanes, skippedLanes, splitLanes } from './scaling.mjs';

// exit 2 is deliberately not exit 1: exit 1 is a claim about a review, and
// these are runs that could not read one. Same line converge.mjs draws.
export const USAGE = 2;
export const REFUSED = 1;

const problem = (exit, message) => ({ exit, message });
const at = (src, message) => (src ? `${src}: ${message}` : message);

// The lanes a caller must expect two payloads from: the ones named by hand
// plus the ones the plan actually split. A split lane exists only in round 1 —
// round 2 spawns one agent per persona from the briefing, and its payloads
// carry validates/challenges rather than findings, so merging two would
// silently drop the second one's work.
export function mergeRoster(lanes, explicit = [], { round = 1 } = {}) {
  return new Set([
    ...explicit,
    ...(lanes && round === 1 ? splitLanes(lanes).map((l) => l.persona) : []),
  ]);
}

function checkIdentity(payload, { personas, ruledOut, round }) {
  const { persona, src } = payload;
  if (typeof persona !== 'string') {
    return problem(REFUSED, at(src, 'missing or invalid `persona` field'));
  }
  if (!personas.includes(persona)) {
    return problem(REFUSED, at(src, `unknown persona '${persona}'`
      + ` (expected one of ${personas.join(', ')})`));
  }
  // A lane that does not cross-review cannot have produced a round-2 payload,
  // so one under its name is a stale file from round 1 or a spoof. Refused
  // rather than warned: its `challenge` entries are applied by synthesis like
  // anyone else's, and one challenger relabels a finding `disputed` however
  // many personas reported it — which moves it out of `Open blocking` and
  // demands a human adjudication the lane has no standing to ask for.
  if (!crossReviews(persona, round)) {
    return problem(REFUSED, at(src, `'${persona}' does not cross-review: every kind it owns`
      + ' is advisory, so it has no blocking claim to validate or challenge.\n'
      + '  A round-2 payload under its name is a stale round-1 file or a spoof, not a'
      + ' reviewer. Check the run directory for leftovers from an earlier phase.'));
  }
  if (ruledOut.has(persona)) {
    return problem(REFUSED, at(src, `the plan recorded '${persona}' as not run, so a payload`
      + ' from it is a stale file or a spoof, not a reviewer.\n'
      + '  If you deliberately ran this lane anyway (SKILL.md Phase 1 allows overriding the'
      + ' plan for a thorough pass), the plan is the thing that is out of date: regenerate'
      + ' plan.json, or drop --plan and pass --merge-personas for any split lane.'));
  }
  return null;
}

// A lane named as split was reviewed in two halves. One payload is not a
// merged lane, it is a lane whose other half was never reviewed — and half the
// files getting no reviewer reads downstream exactly like a clean review.
function checkCount(persona, count, merged) {
  if (merged.has(persona)) {
    if (count === 2) return null;
    return problem(REFUSED, `--merge-personas ${persona}: expected exactly 2 payloads`
      + ` for the split lane, got ${count}.`
      + (count < 2
        ? ' What is missing reviewed nothing — re-run it, or pass --degraded to synthesize.'
        : ' Extra payloads mean a stale file or a double glob — clean the run directory.'));
  }
  if (count > 1) {
    return problem(REFUSED, `duplicate persona '${persona}' across inputs`
      + ' (a deliberately split lane needs --merge-personas <persona>)');
  }
  return null;
}

// A lane the plan ran that produced no payload reviewed nothing, and "reviewed
// and found nothing" is the same input downstream as "never looked". Warned
// rather than refused: the Pragmatist legitimately runs in round 1 and never
// cross-reviews, so its absence from a round-2 roster is the design working,
// and a warning that fires on every run is how a real warning gets skimmed.
function silentLanes(lanes, heard, round) {
  return runLanes(lanes).map((l) => l.persona)
    .filter((p) => crossReviews(p, round) && !heard.has(p));
}

export function checkRoster(payloads, {
  personas = DEFAULT_PERSONAS, lanes = null, explicitMerges = [], round = 1,
} = {}) {
  const merged = mergeRoster(lanes, explicitMerges, { round });
  const problems = [...merged]
    .filter((p) => !personas.includes(p))
    .map((p) => problem(USAGE, `${p}: not a persona (${personas.join(', ')})`));

  const ruledOut = new Set(lanes ? skippedLanes(lanes).map((l) => l.persona) : []);
  const counts = new Map();
  for (const payload of payloads) {
    const bad = checkIdentity(payload, { personas, ruledOut, round });
    // A refused payload is not a lane that was heard from. No refusal reason
    // can currently apply to a persona that is also in `runLanes` — the three
    // are "not a string", "not in the registry" and "the plan ruled it out",
    // and a running lane is none of those — so this `else` is unreachable
    // today and no test discriminates it. It is kept because it fails in the
    // safe direction: if a future refusal reason does apply to a running lane,
    // counting it would SUPPRESS that lane's silence warning, and a lane that
    // said nothing would read as a lane that reviewed and found nothing.
    if (bad) problems.push(bad);
    else counts.set(payload.persona, (counts.get(payload.persona) ?? 0) + 1);
  }

  // Every DECLARED split lane, not only the personas that sent something. A
  // lane that sent nothing never appears in `counts`, so iterating the
  // observed payloads alone let a split lane with ZERO halves through: the
  // most complete version of the failure this check exists to catch, and the
  // one it stopped catching. Union, so an undeclared duplicate is still seen.
  for (const persona of new Set([...merged, ...counts.keys()])) {
    // A name that is not a persona already has its complaint; telling its
    // author it also owes two payloads is noise on top of the real answer.
    if (!personas.includes(persona)) continue;
    const bad = checkCount(persona, counts.get(persona) ?? 0, merged);
    if (bad) problems.push(bad);
  }

  const silent = lanes ? silentLanes(lanes, new Set(counts.keys()), round) : [];
  const warnings = silent.length
    ? [`the plan ran ${silent.join(', ')} but no payload arrived.`
       + ' If that lane failed, declare it: `synthesize --degraded <persona>`.']
    : [];

  return { problems, warnings, merged };
}
