// The finding taxonomy: kind and severity. Split out of prompts.mjs (issue #9)
// because modules with no interest in prompt prose — html.mjs, synthesis.mjs,
// scaling.mjs, ledger.mjs — imported it anyway, for ADVISORY_KINDS alone. A
// renderer depending on ~300 lines of prompt text to learn that `design` is
// advisory was backwards.

// Finding kinds. The axis is orthogonal to severity and answers a different
// question: not "how bad is this" but "what evidence would settle it". That is
// what makes it mechanically useful — it selects how a finding is verified,
// whether it can be traced across commits, and whether it can hold a
// convergence loop open.
//
// `design` is ADVISORY by construction. Design opinions do not converge: a
// reviewer can always want different structure, so counting them in a
// stop condition means the loop never stops. They are recorded and ranked,
// never blocking. Every other kind blocks — including an unrecognized one, so
// that a finding cannot escape the gate by being mislabeled.
export const KINDS = Object.freeze(['defect', 'behavioral', 'contract', 'design']);
export const ADVISORY_KINDS = Object.freeze(new Set(['design']));

export const SEVERITIES = Object.freeze(['critical', 'warning', 'info']);

// Which pass produced a finding. `review` is an ordinary review round;
// `regression` is the read-only pass a lane that did not report the finding
// runs over a fix commit that already landed (src/regression.mjs). The axis
// exists because "the fix introduced this" and "round 2 noticed this" are
// different facts and an operator reading a ranked list cannot act on the first
// without knowing which it is.
//
// Here rather than in synthesis.mjs for the same reason ADVISORY_KINDS is here:
// both renderers have to ask the question, and neither should learn the answer
// from a string literal of its own.
export const PROVENANCE = Object.freeze({ review: 'review', regression: 'regression' });

// Null prototype, because `severity` is reviewer-supplied and callers test
// membership with `severity in SEVERITY_RANK` and `SEVERITY_RANK[s]`. A plain
// object answers `constructor`, `toString`, `valueOf` and nine more with
// something truthy, so those strings passed the severity gate that decides
// whether a finding is built at all.
export const SEVERITY_RANK = Object.freeze(
  Object.assign(Object.create(null), { critical: 0, warning: 1, info: 2 }));

// What round 2 may say about a candidate root cause (src/triage.mjs proposes
// them; nothing deterministic rules on them). `one` collapses the group into a
// single fix and a single disposition with its citations attached; `split`
// dissolves it back into independent findings. Anything else — including
// silence — leaves the group a candidate, which is the pre-grouping behaviour
// and therefore the safe default.
export const GROUP_RULINGS = Object.freeze(new Set(['one', 'split']));

// What a candidate root cause can BE, once round 2 has (or has not) ruled. The
// five names were spelled in three places — synthesis's status ternary and its
// label map, and html.mjs's — with nothing keeping them in step, so a sixth
// status added to one would be a silent fallback in the others. Both renderers
// key their labels off this list, which turns a missing label into a visible
// gap instead.
export const ROOT_CAUSE_STATUSES = Object.freeze(
  ['proposed', 'confirmed', 'contested', 'oversized', 'split']);

// Both renderers keep their own label map, because the wording differs by
// medium. What must not differ is the KEY SET — a status added here and
// missing there used to fall back to the bare status name, which reads like a
// deliberate terse label rather than a gap. Called at module load in each
// renderer, so the failure is loud and immediate instead of one odd-looking
// card in a report nobody re-reads.
export function assertCoversStatuses(labels, where) {
  const missing = ROOT_CAUSE_STATUSES.filter((s) => !Object.hasOwn(labels, s));
  const extra = Object.keys(labels).filter((s) => !ROOT_CAUSE_STATUSES.includes(s));
  if (missing.length || extra.length) {
    throw new Error(`${where}: root-cause status labels are out of step with taxonomy`
      + `${missing.length ? `; missing ${missing.join(', ')}` : ''}`
      + `${extra.length ? `; unknown ${extra.join(', ')}` : ''}`);
  }
  return labels;
}
