// The finding taxonomy: kind and severity. Split out of prompts.mjs (issue #9)
// because modules with no interest in prompt prose — html.mjs, synthesis.mjs,
// scaling.mjs, ledger.mjs — imported it anyway, for ADVISORY_KINDS alone. A
// renderer depending on ~300 lines of prompt text to learn that `design` is
// advisory was backwards.

import { refuseDirectRun } from './entryGuard.mjs';

refuseDirectRun(import.meta.url);

// Finding kinds. The axis is orthogonal to severity and answers a different
// question: not "how bad is this" but "what evidence would settle it". That is
// what makes it mechanically useful — it selects how a finding is verified,
// whether it can be traced across commits, and whether it can hold a
// convergence loop open.
//
// `design` and `contract` are ADVISORY by construction, for the same reason
// from two directions. Design opinions do not converge: a reviewer can always
// want different structure. Contract findings do not run out: every sentence of
// prose is a checkable claim, so a fix's own comments and docs replenish the
// supply — counting either kind in a stop condition means the loop never
// stops. Both are recorded and ranked, never blocking. `defect` and
// `behavioral` block — and so does an unrecognized kind. Mislabeling INTO an
// advisory kind is the gate's one blind spot, and round 2 is the defense: a
// second reporter's blocking kind wins the merge (synthesis keeps the worse
// kind), which is one more reason the cross-review is never skipped on size.
export const KINDS = Object.freeze(['defect', 'behavioral', 'contract', 'design']);
export const ADVISORY_KINDS = Object.freeze(new Set(['design', 'contract']));

export const SEVERITIES = Object.freeze(['critical', 'warning', 'info']);

// How strong the evidence behind a finding is. Orthogonal to both axes above:
// severity is how bad it would be, kind is what would settle it, and this is
// how much of that settling actually happened.
//
// Four of the five are counted from who reported and who ruled
// (src/synthesis.mjs). `demonstrated` is the one that is not: it means a
// reviewer attached a reproduction, and src/probe.mjs re-ran that reproduction
// and watched the predicted behavior occur. It outranks the rest because it is
// a fact rather than a concurrence — and it outranks `disputed` in particular,
// which is the interesting case: an argument against a behavior that has been
// observed to happen is an argument that lost. The challenge is still printed
// beside the finding; it just stops deciding the label.
//
// Here rather than in synthesis.mjs for the reason ROOT_CAUSE_STATUSES is
// here. This vocabulary was spelled out in five places — synthesis's sort
// rank, its section titles, its bucket map, and html.mjs's two — with nothing
// keeping them in step, so a fifth label added to one was a silent gap in the
// others: a finding in no bucket, dropped from the report without an error.
export const CONFIDENCES = Object.freeze(
  ['demonstrated', 'cross-validated', 'consensus', 'disputed', 'solo']);

// The same coverage check `assertCoversStatuses` makes, for the same reason and
// with the same failure mode in mind: a map keyed by confidence that is missing
// one silently drops every finding carrying it. Called at module load by each
// enumerator, so a new label is a loud crash on the next run rather than a
// section that quietly renders empty.
export function assertCoversConfidences(map, where) {
  const keys = Array.isArray(map) ? map : Object.keys(map);
  const missing = CONFIDENCES.filter((c) => !keys.includes(c));
  const extra = keys.filter((c) => !CONFIDENCES.includes(c));
  if (missing.length || extra.length) {
    throw new Error(`${where}: confidence labels are out of step with taxonomy`
      + `${missing.length ? `; missing ${missing.join(', ')}` : ''}`
      + `${extra.length ? `; unknown ${extra.join(', ')}` : ''}`);
  }
  return map;
}

// Which pass produced a finding. `review` is an ordinary review round;
// `regression` is the read-only pass a lane that did not report the finding
// runs over a fix commit that already landed (src/regression.mjs). The axis
// exists because "a fix commit's regression pass found this" and "round 2
// noticed this" are different facts and an operator reading a ranked list
// cannot act on the first without knowing which it is — the stamp records
// which pass found the finding, never that the fix caused it; causation lives
// in the classification.
//
// Here rather than in synthesis.mjs for the same reason ADVISORY_KINDS is here:
// both renderers have to ask the question, and neither should learn the answer
// from a string literal of its own.
export const PROVENANCE = Object.freeze({ review: 'review', regression: 'regression' });

// What a `reporters` field is allowed to hold, wherever one is read: a list of
// lane names. Here rather than in either reader by this file's own test — it is
// the shape of a field the ledger, the synthesizer, the HTML renderer and the
// PR comment all read, and none of them owns it.
//
// A string is the reason it exists. `"auditor"` is iterable, so
// `(rc.reporters ?? []).length` published "7 reviewers" and an entry carrying
// one answered `closureOf` with the lanes a, d, i, o, r, t, u. Every reader
// refuses it now, each in its own register.
export const isLaneList = (value) => Array.isArray(value)
  && value.every((lane) => typeof lane === 'string');

// Which lanes a citation claims, or `null` for a claim that is not lane names
// at all — one reading, for the two readers that would otherwise each have
// their own.
//
// A group citation arrives out of briefing.json, so both fields are whatever
// that file says: `reporters` where synthesis resolved the citation against a
// finding, the singular `reporter` it claimed otherwise. An absent one claims
// NOBODY rather than one reviewer named `undefined` — that value serialized as
// `null`, counted in the PR comment's reviewer tally and rendered as the word
// "null" in the dashboard, which is vouching spelled by an absence.
//
// Absence ONLY. A reporter that is present and not a lane name is a malformed
// file rather than an empty claim, and dropping it would put "0 reviewers" in
// a permanent PR comment with nothing said about why. It comes back `null`, so
// each caller refuses it in its own register — and never as one reviewer,
// which is what wrapping a bare `"auditor"` in a list would have made of the
// string this vocabulary exists to catch.
// Whether a citation's reporter fields are lane names — BOTH of them, because
// they are read by different things. `claimedLanes` prefers `reporters`, and
// both renderers print the singular `reporter` verbatim beside the citation
// id; a citation carrying a good list and a junk singular satisfied the first
// and published `[object Object]` through the second, into report.md, the
// dashboard and report.json alike.
//
// Absence is not a bad value, here as there: a citation naming no reporter is
// what a briefing writes for a finding synthesis did not build.
const laneOrAbsent = (value) => value === undefined || value === null
  || typeof value === 'string';
export const citesLaneNames = (citation) => laneOrAbsent(citation?.reporter)
  && (citation?.reporters === undefined || citation?.reporters === null
    || isLaneList(citation.reporters));

export const claimedLanes = (citation) => {
  const claimed = citation?.reporters ?? [citation?.reporter];
  if (!Array.isArray(claimed)) return null;
  const lanes = claimed.filter((lane) => lane !== undefined && lane !== null);
  return isLaneList(lanes) ? lanes : null;
};

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
// silence — leaves the group a candidate, which is the pre-grouping behavior
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
