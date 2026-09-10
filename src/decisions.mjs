// Fold fix-agent payloads into the `decisions.json` that `converge.mjs
// --record` appends to the ledger.
//
// The third list is why this file exists, and it exists because of one measured
// failure. A fix agent's report named `preflight_emu is not budgeted` under a
// heading that explicitly said "out of scope, named not fixed". The
// orchestrator read it and recorded nothing. The next iteration, TWO
// independent round-1 reviewers found it — a full lane-pair's attention
// re-deriving a conclusion that was already written down in the previous
// iteration's own artifacts. The agent behaved correctly: it found something
// outside its brief, refused to widen its own scope, and said so. The handoff
// dropped it.
//
// "Read the reports carefully" was already the rule for findings and still
// missed this one, which is why the channel is code rather than more prose. The
// item arrives at the worst possible moment — the end of a long report, while
// the orchestrator is reconciling several such reports and preparing a commit —
// and everything else in that report is about work that WAS done. It reads as a
// footnote and it is a finding.
//
// `fixed` and `declined` are folded here too, though only the third list was
// asked for. Leaving them out would leave the orchestrator hand-assembling two
// thirds of decisions.json out of identity fields the payload already carries,
// and that hand is the defect source #17 removed from every other leg of this
// flow: transcription drift, truncated `detail` fields, a decision recorded
// from memory that had never been written to a file at all.

import { refuseDirectRun } from './entryGuard.mjs';
import {
  SETTLING_SCORE, UNREPORTED_DISPOSITION, identityGap, normalizeTitle, requireFindings,
  scoreMatch,
} from './ledger.mjs';

refuseDirectRun(import.meta.url);

// Ids for items nobody ever assigned one. Two letters so it cannot collide with
// triage's `F<n>` or its root causes' `G<n>`, and it carries the batch label so
// two fix agents folded in separate invocations cannot both mint `NF1` for
// different items. Nothing matches on ids — SKILL.md Phase 9 says they are
// per-run and re-derived — so this is for whoever reads the ledger afterward,
// and which batch noticed the item is most of what they want to know.
const namedItemId = (agent, n) => `NF-${agent}-${n}`;

// `named_not_fixed` is the one list whose schema carries no `id`, and both
// readers below have to agree about that: `reconciliations` decides whether to
// refuse the fold on an id claim, and `foldFixPayloads` mints the entry that
// claim would have bound.
const NAMES_NO_ID = { statesId: false };

// Every item a fix agent named but did not fix is recorded with this
// disposition, and the whole point of it is that `isSettled` says no.
//
// This was `deferred`, which settles, defended by the argument that
// SETTLING_SCORE is 3 so "only an identical title reaches it". That argument
// was false and its falsity was the finding: `FIX_INSTRUCTIONS` tells the agent
// to copy `title`, `kind`, `file` and `line` verbatim out of the briefing,
// because an entry written from a shorter example matches nothing — so an
// identical title is the DESIGNED behavior of this channel, not a hurdle it has
// to clear. Reproduced by execution: a payload with `fixed: []`, `declined: []`
// and one `named_not_fixed` item whose identity fields were copied from an
// assigned cross-validated critical passed `validateFix`, minted `NF-<agent>-1`
// and left `convergenceStatus` reporting `done: true, open: 0, "converged: no
// blocking finding is unsettled"` with the critical untouched. Mentioning a
// blocking finding in a footnote closed it forever, with no code change and no
// warning.
//
// `deferred` is also not the agent's to assert — `validateFix` refuses a
// top-level `deferred` key on exactly those grounds — so minting one on its
// behalf was the same claim through the back door.
//
// What the channel is FOR survives unchanged, and it is why this file exists at
// all: the item reaches the next iteration's briefing with the agent's own
// reasoning attached, so nobody re-derives it. See `annotate`'s noted branch.
// Taken from src/ledger.mjs rather than spelled again, because the ledger has
// to know the same fact from the other side: `uncoveredDecisions` skips this
// disposition outright, and lets an entry carrying it excuse the next decision
// that matches it — unless the fold checked that identity against a report and
// no lane had filed it, which is the one thing `reconciled` below withholds the
// exemption on. A fold given no report records `reconciled: null` and the entry
// still excuses; that degraded mode is the bridge's warning to make, not this
// predicate's. Two spellings of one disposition is how the summary line
// stopped counting `noted` at all.
export const NAMED_NOT_FIXED_DISPOSITION = UNREPORTED_DISPOSITION;

// Does this entry carry the identity that SETTLES that one?
//
// The predicate `uncoveredDecisions` grants its one exemption on, imported
// rather than spelled again: this file mints the entries that exemption is
// granted BY, so it has to refuse exactly the pairs the ledger would let vouch
// for each other. A second copy of a scoring rule is how two copies drift.
function settlesSameThing(a, b) {
  return (scoreMatch(a, b)?.score ?? 0) >= SETTLING_SCORE;
}

// `recordDecisions` throws on a decision with no reason, three frames
// downstream, in a message that names the ledger rather than the payload that
// caused it. Refusing here means the operator is told which item, in which
// batch, is unexplained.
function requireReason(text, what) {
  const reason = String(text ?? '').trim();
  if (!reason) {
    throw new Error(`${what} has no reason; an unexplained decision cannot be reviewed `
      + 'later and the ledger refuses it');
  }
  return reason;
}

function requireTitle(title, what) {
  const t = String(title ?? '').trim();
  if (!t) throw new Error(`${what} has no title; title is what the next pass matches on`);
  return t;
}

// One entry of a payload list, before anything reads a field off it.
//
// The two guards above refuse an entry whose title or reason is missing, and a
// `null` beside them in the same list got neither: `Cannot read properties of
// null (reading 'id')`, naming no batch, no list and no position. Same class as
// the `[null]` a decisions document could carry into the ledger, one file
// earlier in the flow — and this file states the doctrine for it, that a caller
// who skipped `validateFix` must not be able to mint an entry that dies
// somewhere else wearing another component's name.
function requireItem(item, what) {
  if (item === null || typeof item !== 'object' || Array.isArray(item)) {
    const shape = Array.isArray(item) ? 'an array' : JSON.stringify(item);
    throw new Error(`${what} is ${shape}; every entry in a fix payload list is an object `
      + 'carrying at least a title and a reason');
  }
  return item;
}

// The identity fields `scoreMatch` reads next iteration, taken from the REPORT
// where the report has this finding and from the payload where it does not.
//
// The payload's copy comes from the briefing, and the briefing is per-lane
// while the report is merged — so the two legitimately disagree, and the ledger
// has to carry the merged one because a merged report is what every later pass
// matches against. `upsert` in src/synthesis.mjs promotes `kind`, `file`,
// `line` and `counterpart` from whichever lane supplied them, so two lanes
// reporting one title — the `cross-validated` case the whole design is built
// around — produce a briefing entry reading `design`/no file and a report
// finding reading `defect`/`src/auth.py`. Measured: a fix agent copying its
// briefing entry verbatim, exactly as `fix.txt` tells it to, recorded a
// decision that `scoreMatch` refused on kind before it looked at the title, so
// the finding was re-raised from scratch every iteration and no honest decision
// could ever settle it.
//
// A normalized title identifies a report finding uniquely — `upsert` merges on
// exactly that key, so two findings sharing one are one finding — which is why
// the title is the binding and the fields around it are what gets corrected.
// `severity` is deliberately NOT among them. `scoreMatch`'s title branch never
// reads it, so correcting it buys the match nothing — and it is the one field
// here an operator states as a judgment rather than copies as an anchor, so
// rewriting a `warning` into the report's `critical` would put a claim in the
// ledger nobody made.
function identityOf(d, finding) {
  const source = finding ?? d;
  return {
    kind: source.kind ?? null,
    file: source.file ?? null,
    line: source.line ?? null,
    counterpart: source.counterpart ?? null,
  };
}

// Does every anchor this entry actually STATES agree with the report finding's?
//
// The guard against binding a decision onto the wrong finding. A title is the
// identity here, so a mis-copied one — two entries transposed in a payload —
// would otherwise have its decision silently MOVED onto the other finding and
// settle it, turning the safe failure this whole file is about (matches
// nothing, settles nothing, comes back) into the unsafe one (settles a finding
// nobody examined). Measured before this guard: a `declined` on `src/a.c:10`
// whose title was copied from the other finding was rewritten to `src/b.c:400`
// and printed as settling it.
//
// A null on the payload's side is no claim, not a disagreement, which is what
// makes the legitimate case still bind: `upsert` fills `file` and `counterpart`
// from whichever lane supplied them and never overwrites a value another lane
// already stated, so a briefing entry's stated anchor can only equal the
// report's or belong to a different finding.
//
// The set is exactly what `scoreMatch` guards on beside `kind` — a stated
// disagreement here is the only kind that could mean "different finding".
// `kind` itself is excluded because it is what synthesis rewrites, promoting a
// blocking kind over an advisory one and a classified one over UNCLASSIFIED:
// treating it as an anchor would refuse the correction this whole path exists
// to make. `line` is excluded because `scoreMatch`'s title branch never reads
// it, so a stale one cannot settle the wrong finding — while including it
// refused a title-and-file match over a line the merge had moved, which both
// cried wolf and left the stale `kind` in the ledger. Measured.
// The fields `anchorsAgree` guards on, and the same list `identityGap` is
// handed when it explains a refusal. One list, so the message cannot name a
// field the guard never read — which is the whole of what went wrong when the
// bridge explained an anchor refusal in terms of the title.
export const ANCHOR_FIELDS = ['file', 'counterpart'];

function anchorsAgree(d, finding) {
  return ANCHOR_FIELDS.every((field) => {
    const claimed = d[field] ?? null;
    return claimed === null || claimed === (finding[field] ?? null);
  });
}

// What the report said about this entry's identity, in three answers rather
// than two: bound to a finding, checked against a report that carries none, or
// never checked because no report was given. "Nobody looked" and "we looked and
// it answers nothing" are different claims, and only the second is worth a
// block of its own on the bridge's output.
//
// The fold's own statement, carried on the decision and now kept by the ledger
// too. Its whitelist used to end one field short of this one, so every reader
// downstream had only the disposition to go on — and `uncoveredDecisions`
// grants its one exemption on exactly this difference: a `noted` identity the
// report CARRIED excuses the decision answering it, and one this fold looked up
// in a report and did not find does not. `null` — no report reached the fold —
// is neither of those and still excuses; withholding on it would make a
// hand-written decisions.json excuse nothing, and choosing to fold without a
// report is the orchestrator's call, warned about on stderr by both bridges.
function reconciledAgainst(finding, checked) {
  return checked ? finding !== null : null;
}

function toDecision(d, { disposition, agent, finding = null, checked = false }) {
  const label = `${disposition} decision ${JSON.stringify(d?.title)} from ${agent}`;
  return {
    id: d.id ?? null,
    title: requireTitle(d.title, label),
    ...identityOf(d, finding),
    severity: d.severity ?? null,
    confidence: d.confidence ?? null,
    disposition,
    reason: requireReason(d.reason, label),
    reconciled: reconciledAgainst(finding, checked),
    // The batch, and no claim about who reported anything. This label was
    // written into `reporters` — so the ledger said `fix-auth-guard` had
    // reported the finding `fix-auth-guard` fixed, and the only field that
    // could have named a lane with no stake in the fix named the one party
    // that had one. The lanes are derived from the report at record time; see
    // `reportersOf` in src/ledger.mjs.
    agent,
    // Which of this batch's commits closed THIS finding. Only the agent that
    // wrote the commits knows, which is why it is asked for rather than
    // derived — and `recordDecisions` took one commit for a whole batch, so
    // the ledger could not answer what any single fix commit closed
    // (kfox/adverse#58, item 6).
    //
    // Carried on every disposition rather than only on `fixed`, so that a
    // `commit` on a decline reaches `recordDecisions`' refusal instead of
    // being dropped here. `validateFix` refuses it first; a caller that
    // skipped the validator must still not be able to record a decline
    // asserting the fix it says it did not make.
    fixCommit: d.commit ?? null,
  };
}

// `reason` is the only free-text field `recordDecisions` preserves, so a
// suggestion that does not go in it is a suggestion that is lost. Appended
// rather than dropped; `clipReason` bounds the rendered form at
// `MAX_REASON_CHARS` (src/limits.mjs), which is a reason to keep `detail`
// short and not a reason to discard the remedy the agent already worked out.
function toNamedNotFixed(item, { agent, n, finding = null, checked = false }) {
  const label = `named-not-fixed item ${JSON.stringify(item?.title)} from ${agent}`;
  const detail = requireReason(item.detail, label);
  const suggestion = typeof item.suggestion === 'string' ? item.suggestion.trim() : '';
  return {
    id: namedItemId(agent, n),
    title: requireTitle(item.title, label),
    // Through the same correction the other two dispositions get, including
    // the `counterpart` this list once hardcoded to null — `scoreMatch`'s
    // contract guard sits above the title branch, so a `contract` item, the
    // likeliest kind here, matched nothing ever again without it.
    ...identityOf(item, finding),
    // No severity: nobody triaged this item, and `scoreMatch` treats a missing
    // severity as equal to nothing, including another missing one. That costs a
    // positional match the stronger of two annotation scores and costs settling
    // nothing at all, since a `noted` entry settles nothing by disposition.
    severity: null,
    confidence: null,
    disposition: NAMED_NOT_FIXED_DISPOSITION,
    reason: suggestion ? `${detail} Suggested: ${suggestion}` : detail,
    reconciled: reconciledAgainst(finding, checked),
    // The batch that noticed it, which is the whole of what is known about
    // where this item came from when no lane reported it, and it closed no
    // commit either way.
    agent,
    fixCommit: null,
  };
}

// The briefing entries a decision's `id` may name, by id.
//
// Unique within one briefing, so no ambiguity sentinel is needed — unlike
// `indexByTitle` in verify.mjs, which needs one because the briefing is
// per-lane and PRE-merge, so two lanes reporting one title give two entries
// with that title. An id route does not have that problem and a title route
// does.
//
// An entry with no string `id` cannot be named by a decision, and one with no
// string `title` cannot answer the question a decision's id is looked up to
// ask. Both are skipped rather than refused, for the same reason: `briefing.mjs`
// mints the ids and copies the titles, so a missing one is this tool's own bug
// and not a payload's claim. Whether a briefing that yields no usable entries
// is an error is the caller's call, and the bridge makes it.
//
// The title used to go unchecked, and the id route reads `entry.title`:
// `normalizeTitle(undefined)` is `''`, so every decision naming a title-less
// entry read as transposed and the whole batch was refused with `the briefing
// calls F3 undefined` — a payload blamed, in a sentence built to quote a title,
// for a field the briefing did not have.
//
// Through `normalizeTitle`, which is what the comparison uses. Truthiness alone
// closed the instance and left the class: `title: "   "` and `title: "."` both
// pass `typeof === 'string' && e.title`, normalize to `''`, and refuse the batch
// with `the briefing calls F3 " "`.
//
// The refusal is `requireFindings`' sibling and for the same reason: the bridge
// needs this exact list to decide whether the file it was handed is a briefing
// at all, and it had grown a hand-typed copy of the predicate. Two copies is
// how the bridge came to exit 1 with a raw `TypeError` on a `findings` that is
// an object, where its `--report` sibling ten lines up exits 2 naming the file.
export function briefingEntries(briefing) {
  if (!Array.isArray(briefing?.findings)) {
    throw new Error('briefing has no findings array; this is not a briefing.json');
  }
  return briefing.findings.filter((e) => e
    && typeof e.id === 'string' && e.id
    && normalizeTitle(e.title));
}

function briefingIndex(briefing) {
  const byId = new Map();
  for (const e of briefingEntries(briefing)) byId.set(e.id, e);
  return byId;
}

// Every id the briefing STATES, usable entry or not.
//
// The difference matters to the operator and only to the operator: an id that
// names nothing in this briefing is a citation from an earlier iteration, and
// an id that names an entry this tool could not use is this tool's own briefing
// being incomplete. Both leave the id/title check with nothing to compare, and
// the bridge told the operator to "check the id against briefing.json" in both
// — advice that sends them looking for an id the file plainly carries.
function briefingIds(briefing) {
  const ids = new Set();
  for (const e of briefing?.findings ?? []) {
    if (e && typeof e.id === 'string' && e.id) ids.add(e.id);
  }
  return ids;
}

// Which report finding a decision may be bound to, and why not when the answer
// is nothing.
//
// Returns a function rather than the Maps so each absent input has ONE spelling
// — every caller asks the same question and gets the same shape — instead of
// each of them deciding what a missing report or briefing means.
//
// The `cause` is the point. A bare null had two causes and the bridge printed
// one remedy for both: "correct the title against report.json", which for an
// anchor disagreement sends the operator to edit the one field that is already
// verbatim. Reproduced with a byte-identical title and `file: src/authz.py`
// against the report's `src/auth.py`. `ANCHOR_FIELDS` is what `anchorsAgree`
// guards on and what `identityGap` is handed, so the message cannot name a
// field the guard does not read.
//
// **The briefing is asked FIRST, and it is the only guard that catches a
// transposition.** A decision's `id` names a BRIEFING entry — never a report
// finding, which carries no id at all — and the round-2 and verify prompts both
// state outright that `id` and `title` must agree with the briefing. Nothing
// enforced it for a fix payload, because `validateFix` has no briefing to check
// against. So a payload that swapped two titles bound by title alone onto the
// OTHER finding and settled it: measured end to end on `65bc979`, a `declined`
// on a `design` advisory with no file closed a cross-validated `critical` at
// `src/auth.py:88`, and the loop reported `done` with nothing open.
//
// `anchorsAgree` cannot catch that and is not meant to: a `null` on the
// payload's side is no claim, which is what makes the legitimate merge case
// still bind — and the documented shape of a `design` advisory is exactly no
// file and no counterpart. With no anchor stated there is nothing to disagree,
// so title-alone binding is the whole of the check, and the title is the field
// that was mis-copied.
//
// This is not a new join. `bindToBriefing` in
// skills/adverse-review/scripts/verify.mjs already refuses an id whose briefing
// entry disagrees with the payload's title, for the same attack one channel
// over — naming an `info` id to bring a critical back non-blocking. One of the
// two bridges that bind a model-supplied id to a finding had the guard and the
// other did not.
//
// Both presences are tracked as FLAGS rather than read off a map's size. A
// briefing that parses to an object with no usable entries is not the same
// claim as no briefing, and neither is a report with no findings — reading
// either from `.size` is how a file containing the literal `null` came to mean
// "nothing was given", which the `--report` path already learned once.
//
// `statesId` is the caller's answer to whether the entry's schema HAS an `id`,
// and only the two dispositions that do are asked the id question. A
// `named_not_fixed` item's schema carries no id (`FIX_INSTRUCTIONS`, and
// `validateFix` never asks for one), so an `id` on one is an extra key the
// validator tolerates and not an identity claim the payload was asked to make.
// Read as one, it put a stray key one keystroke away from refusing a whole
// batch: a `noted` item whose id happened to name a briefing entry with another
// title reached `cause: 'briefing'`, and the bridge refuses the fold on that —
// taking every legitimate `fixed` decision beside it down as well.
function bindingFor(report, briefing) {
  const haveBriefing = briefing !== null && briefing !== undefined;
  const briefed = haveBriefing ? briefingIndex(briefing) : new Map();
  const stated = haveBriefing ? briefingIds(briefing) : new Set();
  const haveReport = report !== null && report !== undefined;
  const byTitle = new Map();
  if (haveReport) {
    for (const f of requireFindings(report)) byTitle.set(normalizeTitle(f.title), f);
  }

  return (d, { statesId = true } = {}) => {
    // Only a decision that STATES an id makes an id claim, and only one whose
    // id RESOLVES makes a claim the briefing can contradict. Both near-misses
    // cost this function the correction it exists to make, and each cost it in
    // the same way — an early return before the report was ever consulted.
    //
    // States none: a `named_not_fixed` item, whose payload schema has no `id`
    // field at all (`fix.txt`) and whose id is minted here afterwards, and a
    // decision on a round-2 `added` finding, which is in report.json under no
    // briefing key and could not copy an id if it wanted one, because
    // report.json carries none. Reading "states none" as "names nothing"
    // refused every one of them as a stale citation, and printed a remedy
    // ("check the id against briefing.json") for entries with no id to check.
    //
    // States one that resolves to nothing: `briefing.mjs` re-mints ids
    // positionally on every triage run, so an id copied out of an earlier
    // iteration names nothing here. That is worth REPORTING and it is not
    // worth refusing on, because the id is not what binds — the title is, and
    // an id that resolves to nothing leaves the transposition check with
    // nothing to compare, which is exactly the pre-briefing posture. Refusing
    // instead dropped the correction and settled nothing, so the decision's
    // own finding held the loop open: measured on a correct title with
    // `file: null`, where the report supplied `src/auth.py:88` without
    // `--briefing` and supplied nothing with it, and `--briefing` is what
    // references/convergence-loop.md tells an operator to pass on every fold.
    // It travels as `staleId` so binding and reporting can both happen.
    let staleId = null;
    let unusableId = false;
    if (statesId && haveBriefing && d.id !== null && d.id !== undefined && d.id !== '') {
      const entry = briefed.get(d.id) ?? null;
      if (!entry) {
        staleId = d.id;
        // Which of the two it is, for the bridge's wording. `stated` carries
        // the ids of entries this tool skipped as unusable, and telling an
        // operator to check an id that briefing.json does carry is advice that
        // cannot be followed.
        unusableId = stated.has(d.id);
      }
      else if (normalizeTitle(entry.title) !== normalizeTitle(d.title)) {
        return {
          finding: null,
          cause: 'briefing',
          staleId: null,
          unusableId: false,
          gap: `the briefing calls ${d.id} ${JSON.stringify(entry.title)}`,
        };
      }
    }
    if (!haveReport) {
      return { finding: null, cause: 'unchecked', gap: null, staleId, unusableId };
    }
    const finding = byTitle.get(normalizeTitle(d.title)) ?? null;
    if (!finding) return { finding: null, cause: 'title', gap: null, staleId, unusableId };
    if (!anchorsAgree(d, finding)) {
      return {
        finding: null,
        cause: 'anchor',
        staleId,
        unusableId,
        // The same tolerance `anchorsAgree` applies, handed to the walk with
        // the same field list: a message that can name a field this guard
        // waved through is the defect one field over.
        gap: identityGap(d, finding, ANCHOR_FIELDS, { tolerateNullClaims: true }),
      };
    }
    return { finding, cause: null, gap: null, staleId, unusableId };
  };
}

function requireAgent(payload) {
  const agent = payload?.agent;
  if (typeof agent !== 'string' || !agent.trim()) {
    throw new Error('a fix payload has no `agent` label; run validate.mjs --phase fix first');
  }
  return agent;
}

// A batch may not mint the `noted` identity that excuses its own decision.
//
// `uncoveredDecisions` grants its one exemption to any decision a recorded
// `noted` entry matches at SETTLING_SCORE, and this file is where those
// entries are minted — out of fields the fix agent supplies. So a fold that
// both asserts a decision and names the same identity as not-fixed hands the
// ledger the token that excuses that decision: the party whose decisions are
// being checked writing its own exemption. The cross-iteration form of the
// same move is closed on the ledger's side, by refusing to vouch with an
// entry this fold could not bind to a report; this refuses the same-batch
// form, where the two claims sit in one payload and contradict each other.
//
// Refused rather than reported, because the two claims cannot both be true.
// One title, one kind and one file is ONE finding here — `upsert` merges on
// exactly that key — so a batch saying it both decided that finding and did
// not decide it has written something incoherent, and dropping the named item
// loses nothing the `fixed` or `declined` entry does not already say. Across
// batches too: which agent minted the token does not change what it excuses.
function refuseSelfIssuedExemptions(decisions) {
  for (const entry of decisions) {
    if (entry.disposition !== NAMED_NOT_FIXED_DISPOSITION) continue;
    const excused = decisions.find((d) => d.disposition !== NAMED_NOT_FIXED_DISPOSITION
      && settlesSameThing(entry, d));
    if (!excused) continue;
    throw new Error(`named-not-fixed item ${JSON.stringify(entry.title)} from ${entry.agent} `
      + `carries the identity of the ${excused.disposition} decision from ${excused.agent}, so `
      + 'recording it would excuse that decision from the coverage check from the next iteration '
      + 'on. Name the item under an identity of its own, or drop it — the decision already '
      + 'says what happened to that finding');
  }
}

// Every decision a batch of fix payloads implies, in payload order, ready for
// `recordDecisions`.
//
// Callers are expected to have run `validateFix` first — the bridge does — and
// the guards above are deliberately kept anyway. A caller that skipped the
// validator must not be able to mint an entry that dies inside the ledger; that
// is the failure the whole channel exists to stop, and it would arrive wearing
// the ledger's name.
export function foldFixPayloads(payloads, { report = null, briefing = null } = {}) {
  const findingFor = bindingFor(report, briefing);
  // The FLAG, not the match: "no report was given" and "the report answers
  // nothing" are different claims and `reconciledAgainst` keeps them apart.
  const checked = report !== null && report !== undefined;
  const decisions = [];

  for (const payload of payloads) {
    const agent = requireAgent(payload);
    (payload.fixed ?? []).forEach((d, i) => {
      requireItem(d, `fixed[${i}] from ${agent}`);
      decisions.push(toDecision(d,
        { disposition: 'fixed', agent, finding: findingFor(d).finding, checked }));
    });
    (payload.declined ?? []).forEach((d, i) => {
      requireItem(d, `declined[${i}] from ${agent}`);
      decisions.push(toDecision(d,
        { disposition: 'declined', agent, finding: findingFor(d).finding, checked }));
    });
    // Reconciled against the report exactly as the two lists above are. This
    // one used to skip it, on the grounds that no lane had reported these items
    // so there was nothing to reconcile against, and two things were wrong with
    // that. `fix.txt` sends an ASSIGNED finding here whenever a batch leaves one
    // for later, so the report frequently does carry the item; and an identity
    // that reaches the ledger unchecked is the identity `uncoveredDecisions`
    // later vouches with, which made this the one list a fix agent could write
    // its own exemption into.
    (payload.named_not_fixed ?? []).forEach((item, i) => {
      requireItem(item, `named_not_fixed[${i}] from ${agent}`);
      decisions.push(toNamedNotFixed(item,
        { agent, n: i + 1, finding: findingFor(item, NAMES_NO_ID).finding, checked }));
    });
  }

  refuseSelfIssuedExemptions(decisions);
  return decisions;
}

// Which entries `foldFixPayloads` would correct against this report, and what
// it would change. The bridge prints this: a fold that silently rewrites the
// fields a fix agent supplied is a fold whose output nobody can read back
// against the payload it came from.
//
// Every list the fold reads, `named_not_fixed` included, and each row says
// which disposition it will become. The two unbound cases are different
// accusations and the bridge prints them under different headings: an unbound
// `fixed` or `declined` settles nothing and `converge.mjs --record --report`
// names it, while an unbound `noted` records fine and excuses nothing — the
// fold's own `reconciled: false` is what `uncoveredDecisions` withholds its
// exemption on. That is narrower than "only an identity the report carried
// excuses anything": `isSelfIdentified` reads `reconciled === false`, so an
// entry from a fold that consulted no report records `null` and still excuses.
// Withholding on `null` too would make a hand-written decisions.json unable to
// excuse anything, and that call belongs to the orchestrator that chose to fold
// without a report — which is why both bridges warn about it on stderr.
function payloadEntries(payload) {
  const agent = payload?.agent ?? null;
  // Guarded here as well as in the fold, and with the same helper: this reader
  // walks the same three lists and the bridge runs it FIRST, so a `null` in one
  // of them reached `Cannot read properties of null (reading 'title')` from
  // here rather than from the refusal the fold now makes.
  const list = (name, disposition, statesId = true) => (payload?.[name] ?? [])
    .map((d, i) => {
      requireItem(d, `${name}[${i}] from ${agent}`);
      return { d, disposition, statesId };
    });

  return [
    ...list('fixed', 'fixed'),
    ...list('declined', 'declined'),
    ...list('named_not_fixed', NAMED_NOT_FIXED_DISPOSITION, false),
  ];
}

// What made EVERY citation disagree at once, as far as the payloads and this
// briefing can say: `'briefing'`, `'either'`, or null for "one wrong pair at a
// time", which is the ordinary case and needs no paragraph of its own.
//
// The refusal is right in all three — an id and a title naming different
// findings cannot both be honored — but the remedy is not, and pointing an
// operator at the wrong file costs them the iteration.
//
// `briefing.mjs` re-mints ids positionally on every triage run and the loop
// writes them to the same path, so handing the fold another iteration's
// briefing makes every citation disagree together. So does a payload that
// pairs two entries with each other's ids. At two citations those two inputs
// are the same document, and no field distinguishes them:
//
//   briefing        F1 -> "the guard", F3 -> "the budget"
//   payload cites   F3 -> "the guard", F1 -> "the budget"
//
// which is either ids rotated between iterations or a payload with its pairs
// swapped. `'either'` is that answer, said out loud. What the first version of
// this said instead was "check your briefing", and the correction to it said
// "check your payload" — by requiring that none of the titles be in this
// briefing, which is true only of a briefing from an unrelated review and is
// exactly the case that needs the least explaining.
//
// One thing holds in every non-null answer, and it was the first way of
// getting this wrong: every citation the check COULD contradict does. The
// denominator is not every stated id — an id that resolves to nothing leaves
// the check with nothing to compare and can never land in `transposed`, so
// counting those suppressed the whole diagnosis on any batch that also carried
// one stale citation, which a briefing of a different length tends to produce.
export function transpositionCause(changes, payloads, briefing) {
  const transposed = changes.filter((c) => c.cause === 'briefing');
  if (transposed.length < 2) return null;

  const stated = payloads
    .flatMap((p) => [...(p?.fixed ?? []), ...(p?.declined ?? [])])
    .filter((d) => d && d.id !== null && d.id !== undefined && d.id !== '').length;
  const unresolvable = changes.filter((c) => c.staleId !== null && c.staleId !== undefined).length;
  if (transposed.length !== stated - unresolvable) return null;

  const titles = new Set(briefingEntries(briefing).map((e) => normalizeTitle(e.title)));
  return transposed.every((c) => !titles.has(normalizeTitle(c.title))) ? 'briefing' : 'either';
}

export function reconciliations(payloads, report, briefing = null) {
  const findingFor = bindingFor(report, briefing);
  const changes = [];
  for (const payload of payloads) {
    const agent = payload?.agent ?? null;
    for (const { d, disposition, statesId } of payloadEntries(payload)) {
      const { finding, cause, gap, staleId, unusableId } = findingFor(d, { statesId });
      if (!finding) {
        changes.push({
          agent, title: d.title, disposition, bound: false, cause, gap, staleId,
          unusableId, fields: [],
        });
        continue;
      }
      const before = identityOf(d, null);
      const after = identityOf(d, finding);
      const fields = Object.keys(after).filter((k) => before[k] !== after[k])
        .map((k) => ({ field: k, from: before[k], to: after[k] }));
      // A stale id is reported whether or not anything was corrected. Keyed on
      // `fields.length` alone it was silent in the one case an operator most
      // needs it — an id from an earlier iteration whose title still binds
      // cleanly — and silence there reads as an id that resolved.
      if (fields.length || staleId !== null) {
        changes.push({
          agent, title: d.title, disposition, bound: true, cause, gap, staleId,
          unusableId, fields,
        });
      }
    }
  }
  return changes;
}
