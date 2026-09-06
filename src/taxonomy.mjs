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
export const SEVERITY_RANK = Object.freeze({ critical: 0, warning: 1, info: 2 });
