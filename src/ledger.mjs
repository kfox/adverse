// The adjudication ledger: what this review has already decided, and why.
//
// Why a loop needs one. Review, fix, re-review is only a convergence loop if
// each pass starts from the last one's conclusions. Without a record, iteration
// 2 re-reports everything iteration 1 deliberately declined, someone re-argues
// it, and the panel oscillates instead of converging — which reads as "the
// reviewers keep finding things" when what is actually happening is that the
// same finding is being rediscovered forever.
//
// The ledger is a decision log, not a suppression list, and the difference is
// the whole design:
//
//   declined / deferred  settled. A later pass is told the decision and its
//                        reason, and told not to re-open it. This is the part
//                        that makes the loop terminate.
//   fixed                NOT settled — the opposite. A finding recorded fixed
//                        that comes back means the fix did not work, which is
//                        the single most valuable thing a re-review can tell
//                        you. It is surfaced louder than a new finding, never
//                        suppressed, and it still holds the loop open.
//   noted                NOT settled. Something was written down that nobody
//                        adjudicated — a fix agent's own footnote, folded by
//                        src/decisions.mjs so the handoff cannot drop it. It
//                        annotates the next briefing with that reasoning and
//                        decides nothing, because the agent that wrote it was
//                        explicitly told deferring is not its call.
//
// Suppressing `fixed` would be the natural-looking optimization and it would
// quietly convert this from a convergence loop into a machine for declaring
// victory. Letting `noted` settle was the same mistake wearing a footnote: a
// fix agent copying a blocking critical's title verbatim into
// `named_not_fixed` — which its own prompt tells it to do — closed that
// critical with no code change and no warning, and `convergenceStatus`
// reported "converged: no blocking finding is unsettled".
//
// Identity across iterations is kind-routed, because a line number is not an
// identity once a fix has shifted the file. Positions are re-projected by
// src/trace.mjs first; matching then works on the traced anchor.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

import { refuseDirectRun } from './entryGuard.mjs';
import { ADVISORY_KINDS } from './taxonomy.mjs';
import { isBlocking, isOpenBlocking } from './synthesis.mjs';

refuseDirectRun(import.meta.url);

export const LEDGER_VERSION = 1;

// How far a traced anchor may drift and still be the same finding. Tighter
// than triage's clustering window: clustering guesses that two findings are
// related, this asserts that two findings ARE one, and a false match here
// silently buries a real finding under an old decision.
const MATCH_WINDOW_LINES = 5;
const MAX_BINDING_PROBLEMS = 20;
// Bound the ledger, not its vocabulary.
//
// This was a cap on DISTINCT REFS, and it was a self-inflicted denial of the
// decision record: `SAFE_REF` admits unbounded spellings of one commit
// (`HEAD~0~0`), but a branch reviewed across enough commits legitimately names
// that many too. Past the cap the resolver returned null, so the run accused
// real commits of not existing and exited 2 — and since `recordDecisions`
// appends forever and the ledger outlives the run, the file became permanently
// unreadable AND unwritable, with deleting it (losing every recorded decline)
// the only way out. A count cap bounds the same work, never fires on an honest
// ledger — this branch's own has ~30 entries after five iterations — and says
// plainly what tripped it.
const MAX_LEDGER_ENTRIES = 1000;

// The weakest match that may settle a finding. Below it, annotate only.
export const SETTLING_SCORE = 3;

// How many of a commit's changed paths `unsupportedFixes` names before it
// stops. The list comes from git rather than from the model, so it is bounded
// by the repository — but a sweeping refactor's commit legitimately touches
// hundreds, and the point of the line is to let a reader recognize the commit,
// which the first few do as well as all of them.
const MAX_NAMED_FILES = 5;

// Longest ledger `reason` copied into a briefing. The ledger is a JSON file on
// disk, and its text is rendered into the round-2 prompt, so it is a channel
// for whoever can write that file. Clipping bounds the payload; labeling it in
// the briefing is what tells a reviewer it is data, not instruction.
const MAX_REASON_CHARS = 500;

// How many of a recorded root cause's citations ride into a briefing. The
// group comes off the same JSON file on disk as everything else here, so its
// member list is as attacker-chosen as its `reason` is; a decision covering
// twenty citations has already said what it needs to.
const MAX_RECORDED_CITATIONS = 20;

export function clipReason(text) {
  const flat = String(text ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ');
  return flat.length > MAX_REASON_CHARS ? `${flat.slice(0, MAX_REASON_CHARS)}… [clipped]` : flat;
}

export const DISPOSITIONS = Object.freeze(['fixed', 'declined', 'deferred', 'noted']);
const SETTLED = new Set(['declined', 'deferred']);

export function isSettled(disposition) {
  return SETTLED.has(disposition);
}

// The one disposition minted for an item the report never raised.
//
// Every other disposition answers a finding some lane filed, which is why
// `uncoveredDecisions` reports one that matches nothing. This one matches
// nothing BY DESIGN: src/decisions.mjs mints it for what a fix agent noticed
// and no lane reported, and that channel exists precisely because the report
// has never seen the item. Exported so that file states the fact once rather
// than spelling `noted` a second time.
export const UNREPORTED_DISPOSITION = 'noted';

// One rendering of "what this batch decided", for every bridge that prints it.
//
// Both bridges hand-typed `fixed · declined · deferred` and both went stale the
// moment a fourth disposition existed: `noted` entries were written to the
// ledger and counted nowhere, so the summary an operator reads before recording
// said the batch decided fewer things than it did. Derived from DISPOSITIONS so
// a fifth cannot go missing the same way, and each count says whether that
// disposition CLOSES a question — which is the line an operator has to be able
// to find before a footnote closes a critical.
export function summarizeDispositions(decisions) {
  const known = new Set(DISPOSITIONS);
  const parts = DISPOSITIONS.map((d) => {
    const n = decisions.filter((x) => x.disposition === d).length;
    return `${d}: ${n}${isSettled(d) ? ' (settles)' : ''}`;
  });
  // `recordDecisions` refuses an unknown disposition and `foldFixPayloads`
  // mints none, so this is unreachable from either bridge today. It is counted
  // rather than dropped because the alternative failure is silent: a total that
  // does not add up to the decision count printed one line above it.
  const unrecognized = decisions.filter((x) => !known.has(x.disposition)).length;
  if (unrecognized) parts.push(`unrecognized: ${unrecognized}`);
  return parts.join(' · ');
}

// Trim BEFORE stripping trailing punctuation: a title with trailing whitespace
// keeps its period otherwise, and two spellings of one title stop matching.
export function normalizeTitle(t) {
  return String(t ?? '').toLowerCase().trim().split(/\s+/).join(' ').replace(/[.:,;!?]+$/, '');
}

export function emptyLedger(base = null) {
  return { version: LEDGER_VERSION, base, iterations: [], entries: [] };
}

export function loadLedger(file) {
  if (!file || !existsSync(file)) return emptyLedger();
  const raw = JSON.parse(readFileSync(file, 'utf-8'));
  if (raw.version !== LEDGER_VERSION) {
    throw new Error(`ledger version ${raw.version} is not ${LEDGER_VERSION}; refusing to guess at its shape`);
  }
  raw.entries ??= [];
  raw.iterations ??= [];
  return raw;
}

// Refuse a ledger that does not belong to this repository.
//
// `loadLedger` checks only `version`, so a ledger naming another repo entirely
// loaded fine and its entries adjudicated findings they had never seen. Commits
// are the one field that cannot be faked across repositories: if `base` or an
// entry's `atCommit` does not resolve here, this ledger is not about this tree.
// `resolve` is injected rather than imported so this module stays pure.
export function checkBinding(ledger, resolve) {
  const problems = [];

  // Resolve each distinct ref once, negatives included.
  //
  // `resolveRef` deliberately does not cache negatives — a ref that does not
  // exist yet must stay resolvable later. That is right for the process and
  // wrong for this loop: entry count is attacker-chosen, so N entries sharing
  // one bogus commit cost N `git rev-parse` spawns before the ledger can be
  // refused. Measured at 26.1 s for 2000 entries, ~1100x per entry. This cache
  // lives for one call, so it cannot go stale.
  const entryCount = (ledger.entries ?? []).length;
  if (entryCount > MAX_LEDGER_ENTRIES) {
    return [`ledger holds ${entryCount} entries, more than the ${MAX_LEDGER_ENTRIES} `
      + 'a decision log for one branch can plausibly reach; refusing rather than '
      + 'resolving that many commits'];
  }

  const seen = new Map();
  const resolveOnce = (ref) => {
    if (!seen.has(ref)) seen.set(ref, resolve(ref));
    return seen.get(ref);
  };

  if (ledger.base && !resolveOnce(ledger.base)) {
    problems.push(`base ${ledger.base} is not a commit in this repository`);
  }
  for (const e of ledger.entries ?? []) {
    // The caller refuses the ledger on the first problem, so listing every one
    // of a million entries only buries the reason under its own output.
    if (problems.length >= MAX_BINDING_PROBLEMS) {
      problems.push(`… and further entries not checked (${MAX_BINDING_PROBLEMS} problems is enough to refuse this ledger)`);
      break;
    }
    // Presence is required, not merely validity. Checking `if (e.atCommit)`
    // made the whole binding opt-out: delete the field from a foreign ledger
    // and it passed clean. `recordDecisions` always writes one, so an entry
    // without it did not come from this tool.
    if (!e.atCommit) {
      problems.push(`entry ${JSON.stringify(e.title)} carries no atCommit; every recorded decision has one`);
      continue;
    }
    if (!resolveOnce(e.atCommit)) {
      problems.push(`entry ${JSON.stringify(e.title)} is anchored at ${e.atCommit}, which is not a commit in this repository`);
    }
    // Validity when present, not presence. `atCommit` above is required
    // because every entry carries one; `fixCommit` is null on every
    // disposition but `fixed` — a decline closes nothing with a commit — so
    // its absence says nothing about where this ledger came from. When it IS
    // there it is what `closureOf` derives a regression pass's exclusion list
    // from, and one that resolves nowhere drops out of that derivation in
    // silence: the ledger would answer "this commit closed nothing", which is
    // the derived form of `--closed-by-none`.
    if (e.fixCommit && !resolveOnce(e.fixCommit)) {
      problems.push(`entry ${JSON.stringify(e.title)} names fix commit ${e.fixCommit}, which is not a commit in this repository`);
    }
    if (e.disposition !== undefined && !DISPOSITIONS.includes(e.disposition)) {
      problems.push(`entry ${JSON.stringify(e.title)} has disposition ${JSON.stringify(e.disposition)}, which is not one of ${DISPOSITIONS.join(', ')}`);
    }
  }
  return problems;
}

export function saveLedger(file, ledger) {
  writeFileSync(file, JSON.stringify(ledger, null, 2) + '\n', 'utf-8');
}

// Score how well a ledger entry matches an incoming finding.
//
// Pure: the caller re-projects the entry's anchor with src/trace.mjs and
// passes the result in, so every interesting case is testable without a git
// history. Returns null for no match.
//
//   3  same title — the strongest signal, and kind-independent, because a
//      reviewer who reports the same defect twice tends to name it the same way
//   2  same kind, same file, and an anchor that lines up
//   1  same kind and file, but one side has no line to compare
//
// Only an identical title may SETTLE a finding — see SETTLING_SCORE. Position
// annotates; it does not adjudicate.
//
// That bar was score 2, and the difference is the difference between showing a
// reviewer a nearby decision and DELETING a finding. A positional match knows
// kind, file, and that two lines are close. It does not know the two findings
// are the same one. So an honest `declined` critical — "not exploitable here,
// the input is bounded upstream", the most routine decision a maintainer makes
// — settled a brand-new cross-validated critical RCE five lines away, and the
// loop printed "converged" and exited 0. Adding a severity check narrowed that
// to same-severity pairs and left the class intact; entries tiling the
// severities and kinds every eleven lines rebuilt the file-wide blanket amnesty
// this scale was written to refuse.
//
// The asymmetry settles it. A wrong settle is SILENT and drops a real finding.
// A missed settle is noisy and safe: the finding returns with the earlier
// decision attached as context, a reviewer re-declines it in one line, and the
// new title is recorded — so it settles from then on and the loop still
// terminates. Rephrasing costs one extra decision; proximity cost criticals.
//
// `normalizeTitle` absorbs case, whitespace and trailing punctuation, so this
// is identity of the finding as written, not of the byte string.
//
//   3  same title, in the same file, of the same kind — settles
//   2  an anchor that lines up (positional, or a contract pair) — annotates
//   1  same kind and file, but one side has no line to compare — annotates
// A line number, or null for anything that is not one.
//
// The ledger is a JSON file on disk, so `line` arrives as whatever it says. A
// string line made `Math.abs(cl - finding.line)` NaN, and the contract
// branch's guard is `cdrift > MATCH_WINDOW_LINES` — false for NaN — so a
// non-numeric line SETTLED the finding at score 2 and carried its own text
// into the briefing. The positional branch's guard is written the other way
// round (`drift <= MATCH_WINDOW_LINES`) and failed closed on the same input.
// Both sides of both comparisons go through here, so which way a comparison
// happens to be written no longer decides whether a finding settles.
function numericLine(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function scoreMatch(entry, finding, traced = null) {
  if ((entry.kind ?? null) !== (finding.kind ?? null)) return null;

  // EQUALITY, not presence. `!entryFile || !finding.file` also rejected the case
  // where NEITHER side names a file, which is not the cross-file leak this
  // guard is for: `buildFinding` requires only a title and a severity, an
  // unclassified kind is blocking, and a `design` advisory legitimately carries
  // no file at all. Those decisions then matched nothing ever again, so the
  // briefing re-raised them every iteration — the circling the ledger exists to
  // stop — and a run holding one file-less blocking finding could not reach
  // exit 0 however honestly it was declined.
  const entryFile = traced?.file ?? entry.file;
  if ((entryFile ?? null) !== (finding.file ?? null)) return null;

  // For a contract finding the counterpart is half the identity — the claim is
  // "X contradicts Y" — which is why the branch below treats a counterpart
  // mismatch as no match at all. That has to hold for the title branch too:
  // reviewers reuse a generic title ("the docstring contradicts the code")
  // precisely because the same shape recurs against a DIFFERENT counterpart,
  // and a stale-README decline was settling a cross-validated critical about a
  // security doc 388 lines away.
  //
  // EQUALITY, not presence, for the same reason spelled out for `file` twelve
  // lines up — the identical hole, one field over. `!entry.counterpart` also
  // rejected the case where NEITHER side names one, and `validateFinding`
  // requires no counterpart on a `contract` finding (triage only annotates it),
  // so `counterpart: null` is legitimate input on both sides. Measured: a
  // `declined` contract decision with byte-identical title, kind, file and line
  // and both counterparts null gave `matchFinding` null and left
  // `convergenceStatus` at `done: false, "1 still open"` forever, however
  // honestly the finding had been declined.
  if (entry.kind === 'contract'
      && (entry.counterpart ?? null) !== (finding.counterpart ?? null)) return null;

  // Title equality is checked HERE, below the identity guards, not above them.
  // It used to return first, so a decision recorded in one file settled an
  // identically-titled finding in another, of any kind and any severity.
  if (normalizeTitle(entry.title)
      && normalizeTitle(entry.title) === normalizeTitle(finding.title)) {
    return { score: 3, why: `identical title in ${entryFile ?? 'no file'}` };
  }

  const entryLine = numericLine(traced?.line ?? entry.line);
  const findingLine = numericLine(finding.line);

  if (entry.kind === 'contract') {
    // A code/counterpart pair with no line is file-wide, exactly the shape
    // SETTLING_SCORE exists to refuse. It used to score 2 here — one planted
    // entry settled every contract finding in a file, and the loop reported
    // itself converged. It annotates; only an anchor that lines up settles.
    if (entryLine === null || findingLine === null) {
      return { score: 1, weakBecause: 'no-line', why: `same code/counterpart pair (${entryFile} vs ${entry.counterpart ?? 'no counterpart'}), but no line on one side` };
    }
    const cdrift = Math.abs(entryLine - findingLine);
    if (cdrift > MATCH_WINDOW_LINES) return null;
    return { score: 2, why: `same code/counterpart pair at ${entryFile}:${entryLine} (drift ${cdrift})` };
  }

  // Contract, though advisory, matched above: its code/counterpart anchor is
  // checkable. For the rest of the advisory set a positional match buys
  // nothing and a wrong one buries real feedback — title equality above is
  // the only path.
  if (ADVISORY_KINDS.has(entry.kind)) return null;

  if (entryLine === null || findingLine === null) {
    return { score: 1, weakBecause: 'no-line', why: `same kind in ${entryFile ?? 'no file'}, but no line on one side` };
  }
  const drift = Math.abs(entryLine - findingLine);
  if (drift > MATCH_WINDOW_LINES) return null;

  // Proximity is not identity, and this is the difference between annotating a
  // finding and DELETING it.
  //
  // A positional match compares kind, file and line drift. It never compared
  // severity, so an ordinary `declined` warning about a noisy log line settled
  // a brand-new cross-validated critical command injection five lines away,
  // and the loop printed "converged" and exited 0. No crafted ledger was
  // needed: declines are routine, the whole convergence story depends on them,
  // and `traceFor` re-projects the old anchor as the file is edited, so the
  // five-line amnesty follows the code around.
  //
  // The asymmetry decides the rule. A wrong settle is SILENT and drops a real
  // finding; a missed settle is noisy and safe — the finding comes back with
  // the earlier decision attached as context, and a reviewer re-declines it in
  // one line. So a positional match settles only when the severity agrees too;
  // anything else annotates. A missing severity does not equal anything, which
  // fails in the safe direction.
  // `?? null` collapsed both sides to null, so missing DID equal missing and
  // took the stronger branch — the opposite of what this comment used to
  // promise. `recordDecisions` writes `severity: d.severity ?? null` and
  // validates nothing, so a decisions.json omitting the field produces exactly
  // that shape. Missing now equals nothing, including another missing.
  const entrySeverity = typeof entry.severity === 'string' ? entry.severity : null;
  const findingSeverity = typeof finding.severity === 'string' ? finding.severity : null;
  if (entrySeverity === null || findingSeverity === null || entrySeverity !== findingSeverity) {
    return {
      score: 1,
      weakBecause: 'severity',
      why: `same kind at ${entryFile}:${entryLine} (drift ${drift}), but the `
        + `decision was taken on a ${entrySeverity ?? 'severity-less'} finding `
        + `and this one is ${findingSeverity ?? 'severity-less'}`,
    };
  }
  return { score: 2, why: `same kind and severity at ${entryFile}:${entryLine} (drift ${drift})` };
}

// The best-matching ledger entry for a finding, or null.
//
// `traceFor(entry)` re-projects an entry's anchor to the current commit; pass
// `() => null` to match on titles and files alone.
export function matchFinding(ledger, finding, traceFor = () => null) {
  let best = null;
  for (const entry of ledger.entries ?? []) {
    const scored = scoreMatch(entry, finding, traceFor(entry));
    if (!scored) continue;
    if (!best || scored.score > best.score) best = { entry, ...scored };
  }
  return best;
}

// Did a recorded FIX fail to hold?
//
// Both regression headings say "recorded fixed", so both key on that
// disposition and on a match strong enough to be about this finding — keying on
// "annotated and unsettled" announced REGRESSED, which the Skill calls the
// loudest signal in a run, for a brand-new finding in a file that merely
// carried one line-less decline. Exported because `triage.mjs` computes the
// same thing for `briefing.regressed` and had drifted to the older predicate.
export function isRegressionCandidate(finding) {
  return finding.adjudicated?.disposition === 'fixed'
    && finding.adjudicated.matchScore >= SETTLING_SCORE
    && !finding.adjudicated.settled;
}

// The root cause a decision was taken on, sanitized for the briefing.
//
// Recorded as CONTEXT and never as a match key. Identity across iterations is
// still per-finding — kind, file, anchor, title — because widening it to "was
// in the same group" would let one decision settle every citation of a group,
// which is the silent-settle failure the whole scoring scale above exists to
// refuse. What the group buys is the sentence in `note`: a finding that comes
// back after a root-cause fix is a different kind of news from one that comes
// back after a symptom-level fix, and until now the ledger could not tell them
// apart.
// A group id is machine-minted (`G1`, `G2`, …). It has no reason to be free
// text at all, and `clipReason` is the wrong tool for it: that function bounds
// length and strips most control characters but DELIBERATELY keeps `\n`, so
// prose survives — which is right for `reason` and wrong for an identifier
// that gets interpolated into tool-authored prose a round-2 reviewer is told
// to trust.
const GROUP_ID = /^[A-Za-z0-9_.-]{1,32}$/;

function recordedGroup(group) {
  if (!group || typeof group !== 'object' || Array.isArray(group)) return null;
  const citations = Array.isArray(group.citations) ? group.citations : [];
  return {
    // `RegExp.test` coerces, so a NUMBER id passed the shape check and was
    // then stored raw — the value that reaches the note is not the value that
    // was validated. Check the type first, store the checked string.
    id: typeof group.id === 'string' && GROUP_ID.test(group.id) ? group.id : null,

    title: clipReason(group.title ?? '') || null,
    citations: citations.slice(0, MAX_RECORDED_CITATIONS).map((c) => ({
      id: clipReason(c?.id ?? '') || null,
      title: clipReason(c?.title ?? '') || null,
    })),
    citationCount: citations.length,
  };
}

function groupNote(group, disposition, { sameReport = false } = {}) {
  if (!group) return '';
  // Quoted, exactly like the title beside it. `id` was interpolated raw, and
  // `briefing.json` IS the round-2 prompt, so this is a path from a recorded
  // value into text a later reviewer reads as the tool's own voice.
  const where = `root cause ${JSON.stringify(group.id ?? '(unnamed)')} `
    + `(${JSON.stringify(group.title ?? '')}), covering ${group.citationCount} citation(s)`;

  if (isSettled(disposition)) {
    return ` That decision was taken on ${where}, not on this finding alone.`;
  }
  // A `noted` entry is a fix agent's footnote, not a ruling, and calling it
  // "That decision" contradicted the sentence it is appended to — which says in
  // as many words that it settles nothing. Same inference-from-`!== 'fixed'`
  // shape as the rung below, one function apart.
  if (disposition === 'noted') {
    return ` That note was made about ${where}, not about this finding alone.`;
  }
  if (disposition !== 'fixed') {
    return ` That entry covers ${where}, not this finding alone.`;
  }
  // A fix recorded against THIS report has not been re-observed — the report
  // predates it. The note this is appended to says exactly that, and appending
  // "the ROOT-CAUSE fix did not close every symptom" contradicted it with a
  // regression claim about something nobody has looked at yet. REGRESSED is
  // the loudest signal in the loop, and an alarm raised by construction is how
  // that signal becomes noise — which is the reason the `sameReport` branch
  // exists at all.
  if (sameReport) {
    return ` That fix was recorded against ${where}. It has not been re-observed`
      + ' yet either — verify it before judging whether it closed them.';
  }
  return ` The fix was recorded against ${where} — so if this finding is back, the `
    + 'ROOT-CAUSE fix did not close every symptom. Say which citation is still live; '
    + 'that is a different failure from a fix that missed its own finding.';
}


// The one sentence a reviewer is told to read about a match.
//
// Extracted from `annotate` because the ladder now has five rungs and the last
// two used to be reached by falling off the end of the settled/tooWeak
// ternary — which silently made them mean "the disposition is `fixed`". Adding
// `noted` broke that assumption without touching a line: a footnote a fix agent
// wrote was announced to the next reviewer as "recorded FIXED in an earlier
// iteration. If it is still real, the fix did not work", about a fix nobody had
// ever claimed. The disposition is now read rather than inferred.
function matchNote(m, { settled, tooWeak, sameReport }) {
  if (settled) {
    return 'Already decided in an earlier iteration. Do not re-open it. Challenge '
      + 'only if that decision rested on something the fix has since changed.';
  }
  if (tooWeak) {
    return m.weakBecause === 'severity'
      ? 'An earlier decision sits within a few lines of this one, but it was '
        + 'taken on a finding of a different severity, so it is too weak to '
        + 'settle this. Judge this finding on its merits — and consider whether '
        + 'the earlier decision was made at the right severity.'
      : 'An earlier decision covers this file, but it names no line, so it is '
        + 'too weak to settle this finding. Judge the finding on its merits; '
        + 'the earlier reason is shown only as context.';
  }
  // NOTED, and nothing else. A fix agent named this and did not fix it; no
  // reviewer triaged it and no orchestrator decided it, so it settles nothing
  // and the finding stays open. Carrying its reason here is the whole point of
  // the channel — the measured alternative is two round-1 reviewers spending a
  // lane-pair's attention next iteration re-deriving a conclusion that was
  // already written down.
  //
  // Match strength is tested HERE and not by `tooWeak` above, which only ever
  // sees a settling disposition. A `noted` item may legitimately carry
  // `line: null` (the schema says so), so one footnote naming a file matched
  // every same-kind finding in it at score 1 — and said "NOTED this" about all
  // of them, where the identical `declined` entry hedges. An identity claim
  // needs the same score the settling rungs demand before it may be made.
  if (m.entry.disposition === 'noted') {
    return m.score >= SETTLING_SCORE
      ? 'An earlier pass NOTED this and left it undecided — a fix agent named it '
        + 'outside its own scope. That is not an adjudication and settles nothing: '
        + 'this finding is still open. The reasoning below is that agent\'s, shown '
        + 'so you do not re-derive it; judge the finding on its merits.'
      : 'An earlier pass NOTED something in this file and left it undecided, but '
        + 'the match is too weak to say it was THIS finding — it may have been a '
        + 'different one in the same file. Nothing is settled either way; the '
        + 'reasoning below is shown only as context, and may not be about this.';
  }
  // Neither settled, nor noted, nor fixed. `checkBinding` tolerates an entry
  // whose disposition is MISSING — it tests `!== undefined` before membership —
  // while an entry carrying an unrecognized value is refused there, and both
  // callers reject the whole ledger on any problem (triage.mjs, converge.mjs),
  // so that one never reaches `annotate` through the real flow. The missing
  // case does, and it used to fall through to the NOTED rung and be announced
  // as "a fix agent named it outside its own scope" — provenance invented for
  // an entry whose provenance is precisely what is unknown. This rung is also
  // where a fifth disposition lands until it is given one of its own, and the
  // defense-in-depth answer for any future caller that skips the binding
  // check.
  if (m.entry.disposition !== 'fixed') {
    return 'An earlier entry matches this finding, but it records no disposition '
      + 'this tool recognizes, so nothing can be inferred about what was decided '
      + 'or by whom. Nothing is settled. Judge the finding on its merits.';
  }
  if (sameReport) {
    return 'Recorded FIXED against THIS report, which was produced before the '
      + 'fix. Not evidence of anything yet: the fix has not been observed. '
      + 'Verify it (Phase 9) and re-synthesize before judging.';
  }
  // The THIRD time this class has been closed in this function, and the last
  // rung to get it. `isRegressionCandidate` requires `matchScore >=
  // SETTLING_SCORE` before it will call a `fixed` match a regression; this
  // sentence did not, so a score-1 file-wide match told round 2 "the fix did not
  // work" while `briefing.regressed` was empty — the tool asserting a regression
  // its own arithmetic declined to count. Every rung now tests match strength:
  // settled and tooWeak on `isSettled`, `noted` on its own, and this one here.
  if (m.score < SETTLING_SCORE) {
    return 'An earlier iteration recorded a fix for something in this file, but the '
      + 'match is too weak to say it was THIS finding. Do not read it as a failed '
      + 'fix; judge the finding on its merits, and note the earlier reason is shown '
      + 'only as context.';
  }
  return 'This was recorded FIXED in an earlier iteration. If it is still real, '
    + 'the fix did not work — say exactly what the fix missed. That is more '
    + 'important than any new finding on this pass.';
}

// Annotate findings with the decision that already covers them.
//
// `adjudicated.settled` is the flag that suppresses re-litigation. A finding
// matching a `fixed` entry is annotated too, but never settled — see the note
// at the top of this file. So is a `noted` one, for a different reason: nobody
// decided it.
// `reportDigest` identifies the report being checked. An entry recorded from
// that same report is the SAME observation, not a new one — see `sameReport`.
export function annotate(findings, ledger, traceFor = () => null, { reportDigest = null } = {}) {
  // Destructured away, not spread over: a finding arrives from report.json,
  // which is read back off disk exactly like the ledger is, and `adjudicated`
  // is the field the stop condition subtracts by. On the no-match path this
  // used to return the finding untouched, so a report could declare its own
  // blocking critical settled and converge the loop against an EMPTY ledger —
  // the fail-open this file keeps closing, moved from the bucket side to the
  // input side. Only an entry in the ledger may write this block.
  return findings.map(({ adjudicated: _selfDeclared, ...f }) => {
    const m = matchFinding(ledger, f, traceFor);
    if (!m) return f;
    const settled = isSettled(m.entry.disposition) && m.score >= SETTLING_SCORE;
    const tooWeak = isSettled(m.entry.disposition) && m.score < SETTLING_SCORE;
    const sameReport = Boolean(reportDigest) && m.entry.reportDigest === reportDigest;
    const group = recordedGroup(m.entry.group);
    return {
      ...f,
      adjudicated: {
        group,
        // EVERY string here is copied out of a file on disk and rendered into
        // briefing.json, which becomes the round-2 prompt. Hardening `reason`
        // alone just moved the channel: a 6,000-character `id` full of newlines
        // and a fake system block rode through untouched, and `disposition`
        // spelled exactly 'declined' plus a payload both settled the finding
        // and delivered the text. Sanitize the lot.
        matchedId: clipReason(m.entry.id ?? '') || null,
        disposition: clipReason(m.entry.disposition ?? '') || null,
        reason: m.entry.reason ? clipReason(m.entry.reason) : null,
        reasonIsUntrusted: true,
        // `Number(null)` is 0 and finite, so a null iteration rendered as
        // iteration 0 while an undefined one rendered as unknown — two
        // spellings of missing, shown differently. `Number('')`, `Number([])`
        // and `Number(false)` are 0 too. Accept a number and nothing else.
        iteration: typeof m.entry.iteration === 'number' && Number.isFinite(m.entry.iteration)
          ? m.entry.iteration : null,
        atCommit: clipReason(m.entry.atCommit ?? '') || null,
        // Tool-generated, but it interpolates the entry's own `file` and
        // `line`. Sanitizing the four fields around it just moved the channel
        // here: a 6,164-character line carrying a fake system block rode in
        // through this one. Anything leaving an entry gets clipped.
        matchedBy: clipReason(m.why),
        // `matchScore`, not `confidence`. The finding next to it in the same
        // briefing carries `confidence: "solo"` — a label — while this is a 1-3
        // integer. An orchestrator building decisions.json by copying fields off
        // an annotated finding would have written the number into the entry's
        // string-typed `confidence`.
        matchScore: m.score,
        settled,
        sameReport,
        // The group sentence is appended, not given a field of its own: this
        // is the one string a reviewer is told to read, and a second note
        // beside it is a note that gets skipped.
        note: matchNote(m, { settled, tooWeak, sameReport })
          + groupNote(group, m.entry.disposition, { sameReport }),

      },
    };
  });
}

// The report's findings, or a refusal naming what the file actually is.
// Shared by every reader of a report so that "I could not find the findings"
// cannot come to be spelled one way in one of them. Exported for
// src/decisions.mjs, which reads a report for the same reason and had grown a
// third hand-typed copy of this sentence.
export function requireFindings(report) {
  if (!Array.isArray(report?.findings)) {
    throw new Error('report has no findings array; this is not a synthesis report');
  }
  return report.findings;
}

// The report findings a decision matches strongly enough to settle.
//
// Lifted out of `reportersOf`, which computed exactly this list and then kept
// only the lanes off it. Both callers need the same bar for the same reason
// spelled out below: under SETTLING_SCORE a match knows kind, file and that two
// lines are close, and does not know the two findings are one.
function settlingMatches(decision, findings) {
  return findings.filter((f) => (scoreMatch(decision, f)?.score ?? 0) >= SETTLING_SCORE);
}

// The review lanes that reported the finding a decision answers, read off the
// report that decision was recorded against.
//
// DERIVED, never typed, and that is the whole point of the function.
// `foldFixPayloads` used to write the fix batch's own label into an entry's
// `reporters` — `['fix-auth-guard']` on a finding the auditor reported — so the
// one field that could have named a disinterested reviewer named the interested
// party instead. The fix agent is not asked for the lanes either: it would be
// copying a field out of its own brief, and a fix agent naming the lanes that
// must not review its commit is the same interested party one indirection away.
//
// SETTLING_SCORE, not a positional match, and the bar is what makes the answer
// usable. A score of 2 knows kind, file and that two lines are close; it does
// not know the two findings are one. Attributing lanes off proximity would
// excuse the wrong lane from a regression pass while the artifact claimed a
// disinterest nothing checked — the failure src/regression.mjs is built around.
// No match leaves the list empty, which every reader here treats as "not
// recorded" rather than "nobody reported it".
//
// Every score-3 match contributes rather than the first one winning. Score 3 is
// an identical title in the same file of the same kind, which is this
// repository's own definition of one finding — the bar at which a decision
// SETTLES it — so two report findings reaching it are the same finding and both
// reporter lists belong.
function reportersOf(decision, findings) {
  const lanes = new Set();
  for (const finding of settlingMatches(decision, findings)) {
    for (const lane of finding.reporters ?? []) lanes.add(lane);
  }
  return [...lanes].sort();
}

// Which of `scoreMatch`'s identity guards a title-equal pair fails.
//
// `counterpart` is named only for a `contract` decision, because that is the
// only kind whose match depends on it — reporting it for a `defect` would send
// an operator to edit a field that changes nothing.
function identityGap(decision, finding) {
  const pair = (a, b) => `(${a ?? 'none'} here, ${b ?? 'none'} in the report)`;
  if ((decision.kind ?? null) !== (finding.kind ?? null)) {
    return `the kinds differ ${pair(decision.kind, finding.kind)}`;
  }
  if ((decision.file ?? null) !== (finding.file ?? null)) {
    return `the files differ ${pair(decision.file, finding.file)}`;
  }
  if (decision.kind === 'contract'
      && (decision.counterpart ?? null) !== (finding.counterpart ?? null)) {
    return `the counterparts differ ${pair(decision.counterpart, finding.counterpart)}`;
  }
  return 'they differ in a field this check does not compare';
}

// Why a decision matched nothing, in the terms its author has to act in.
//
// A bare "matched nothing" is not actionable, and the two bugs this check
// exists to catch both produce a decision whose title IS in the report and
// whose identity fields are one field off: `toNamedNotFixed` hardcoding
// `counterpart: null` against `scoreMatch`'s contract guard, and that guard
// testing counterpart presence rather than equality. Naming the field is the
// difference between a refusal fixed in one edit and one that reads as the
// tool being broken.
// The title is asked FIRST, and the near-miss second. Both orders were written;
// this one is right because a title-equal finding IS the finding the decision
// was taken on — `upsert` merges on a normalized title, so a report carries at
// most one — while a score-1 near-miss is only the closest thing in the file.
// With the near-miss first, one unrelated contract finding elsewhere in the
// same file (score 1, "no line on one side") shadowed the counterpart
// diagnostic for the finding actually decided, and sent the operator to fix a
// line number on a finding they never touched.
function whyUncovered(decision, findings) {
  const norm = normalizeTitle(decision.title);
  const sameTitle = norm && findings.find((f) => normalizeTitle(f.title) === norm);
  if (sameTitle) return `the report carries this title, but ${identityGap(decision, sameTitle)}`;

  let best = null;
  for (const finding of findings) {
    const m = scoreMatch(decision, finding);
    if (m && (!best || m.score > best.score)) best = m;
  }
  if (best) {
    return `matched at score ${best.score} (${best.why}), which annotates but does not settle`;
  }
  return 'no finding in the report carries this title';
}

// Is this decision answering an item the ledger recorded as unreported?
//
// The one exemption `uncoveredDecisions` grants, and it is narrow on purpose.
// Keyed on ANY prior settling entry, it exempted a mis-anchored decision with
// its own first recording: iteration 1 named it, the finding it meant to
// answer never settled and so came back, the identical decision was recorded
// again, and from iteration 2 the run went quiet all the way to the cap.
// Measured. That is exactly the holds-open-with-no-symptom failure this check
// exists to catch, arriving one iteration late — and a loop iterates by
// definition, so the second recording is the likely one.
//
// UNREPORTED_DISPOSITION is the one disposition minted for an item no report
// has seen, which is what makes it the one that can vouch for another. Every
// other entry is itself an answer to a finding, and an answer nothing matched
// has no standing to excuse the next one.
function onNotedRecord(ledger, decision) {
  return (ledger.entries ?? []).some((entry) =>
    entry.disposition === UNREPORTED_DISPOSITION
    && (scoreMatch(entry, decision)?.score ?? 0) >= SETTLING_SCORE);
}

// Decisions that will settle nothing, because nothing they could be answering
// matches them at SETTLING_SCORE (kfox/adverse#58, item 1).
//
// A decision whose identity fields are subtly wrong is recorded, matches
// nothing, and settles nothing — so the finding it honestly decided is either
// re-raised from scratch next iteration or holds the loop open until the cap.
// Both failures are SILENT at the moment they are caused: the decision is in
// the ledger, the summary counts it, and only the finding's stubborn
// reappearance, iterations later, ever hints at it. This names it while its
// author is still holding the report it was written against.
//
// REPORTED, never refused, and the batch is recorded either way. Three
// documented paths produce a decision that legitimately matches no report
// finding — a `noted` item decided in a later iteration, a root-cause citation
// synthesis could not resolve, and any decision recorded against a report this
// run was not given — and a check that stopped the write would freeze the
// iteration counter on all three. `iterations` grows only under `--record`, so
// a branch that does not record makes the cap unreachable and the loop
// non-terminating; see references/convergence-loop.md. A decision matching
// nothing never settles the WRONG finding, which is the failure worth a
// refusal — it only fails to settle the right one.
//
// The ledger is consulted beside the report because a decision may be
// answering something already on record rather than something the panel just
// filed. That is the ordinary shape of deciding a `noted` item, which the loop
// reference says still needs a decision and which is in no report by
// construction. Only a `noted` entry vouches, for the reason `onNotedRecord`
// gives: any-prior-match let a mistake exempt itself one iteration later.
//
// The whole report, never its `findings` array, for the reason `recordDecisions`
// spells out: a caller doing the extraction itself spells "this is not a
// report" as "I was given no report".
export function uncoveredDecisions(decisions, report, { ledger = emptyLedger() } = {}) {
  const findings = requireFindings(report);
  const uncovered = [];
  for (const d of decisions) {
    // A disposition this vocabulary does not have is `recordDecisions`' refusal
    // to make, and it makes it in one line naming the field. Reporting such a
    // decision here instead would answer a question nobody asked — whether it
    // matched a finding — about an entry that is not a decision yet.
    if (!DISPOSITIONS.includes(d.disposition)) continue;
    if (d.disposition === UNREPORTED_DISPOSITION) continue;
    if (settlingMatches(d, findings).length) continue;
    if (onNotedRecord(ledger, d)) continue;
    uncovered.push({
      title: clipReason(d.title ?? ''),
      disposition: d.disposition ?? null,
      why: clipReason(whyUncovered(d, findings)),
    });
  }
  return uncovered;
}

// The commit a decision says closed the finding, under either of its names.
//
// Two spellings, because two writers. `decisions.json` — the file
// references/convergence-loop.md teaches you to write by hand — carries
// `commit`, and src/decisions.mjs renames it to `fixCommit` on the way through
// so a ledger entry and a fix payload do not read as the same shape. Everything
// here had been written against the entry's spelling alone, so a hand-written
// decision following the documented schema was recorded with `fixCommit: null`:
// its commit dropped in silence, invisible to `closureOf`, and the `commit`-on-
// a-decline refusal that the same documented paragraph promises never fired.
// Measured on all three. Read through one function so the two cannot come apart
// again — two corrected copies is how they drifted.
export function fixCommitOf(decision) {
  return decision?.fixCommit ?? decision?.commit ?? null;
}

// `fixed` decisions whose own commit does not support the claim
// (kfox/adverse#58, item 2).
//
// A `fixed` disposition asserts a code change. Nothing checked that one was
// made, and the failure is not hypothetical: a fix agent that believed it had
// edited a file, or an orchestrator assembling decisions.json from a report it
// read rather than a tree it inspected, records `fixed` against a commit that
// does not contain the fix. The finding comes back next iteration as REGRESSED
// — the loudest signal this system has — pointing at a fix that was never
// made, which sends whoever reads it looking for a fix that broke rather than
// a fix that is missing.
//
// The issue asks for `git log -S` over the recorded range. Per-decision
// `fixCommit` (kfox/adverse#86) makes a sharper question available: not "did
// anything in the range touch this file" but "did the commit THIS decision
// names touch it". Four answers, and only the first is silent:
//
//   touches the cited file        supported. Nothing to say.
//   touches only other files      reported. A root-cause fix in another file
//                                 is legitimate and common, so this is not an
//                                 accusation — but it is the shape a fictional
//                                 fix also has, and the reason should say
//                                 which one it is.
//   changes no file at all        reported, loudest. An empty commit closes
//                                 nothing, whatever it says in its message.
//   cannot be read                reported. A merge, or a git that would not
//                                 run. Never silent: `filesChangedIn` keeps
//                                 these distinguishable from an empty list
//                                 precisely so that not knowing cannot pass
//                                 for knowing the fix is absent.
//
// A decision citing no file is supported by any commit — there is no claim
// about a location to check — so it is silent rather than reported. And this
// REPORTS; it does not refuse, for the reason `uncoveredDecisions` gives at
// length: only `--record` advances the iteration counter, and a branch that
// does not record makes the cap unreachable.
export function unsupportedFixes(decisions, filesChanged) {
  const unsupported = [];
  const name = (d, commit, why) => ({ title: clipReason(d.title ?? ''), commit, why });

  for (const d of decisions) {
    if (d?.disposition !== 'fixed') continue;

    const commit = fixCommitOf(d);
    // No evidence offered, which is not the same accusation as evidence that
    // contradicts the claim, and says so. `validateFix` requires a commit on
    // every `fixed` entry, so a folded batch cannot reach this — it is the
    // hand-written decisions.json, which `recordDecisions` accepts without one.
    // `closureOf` already skips such an entry when asked what a commit closed,
    // so today a fix recorded this way is invisible to the machinery that
    // picks a disinterested reviewer, silently.
    if (!commit) {
      unsupported.push(name(d, null,
        'it names no commit at all, so nothing records what change it made'));
      continue;
    }

    const changed = filesChanged(commit);
    // Its own branch, and the loudest, because it is the only one that is not
    // about this decision alone. `checkBinding` refuses a whole ledger carrying
    // an entry whose fix commit resolves nowhere, and the ledger is append-only
    // — so recording this makes every later `converge.mjs` run, status and
    // record both, exit 2 on a file that cannot be repaired. The remedies the
    // block offers for the other branches do not apply to it.
    if (changed.status === 'unresolved') {
      unsupported.push(name(d, commit,
        `${clipReason(changed.why ?? 'that commit does not resolve here')}. Recording this `
        + 'makes the ledger unreadable from the next run on — fix the commit before you record'));
      continue;
    }
    if (changed.status !== 'ok') {
      unsupported.push(name(d, commit,
        `what it changed cannot be read: ${clipReason(changed.why ?? 'no reason given')}`));
      continue;
    }
    if (!changed.files.length) {
      unsupported.push(name(d, commit, 'that commit changes no file at all'));
      continue;
    }
    if (!d.file) continue;
    if (changed.files.includes(d.file)) continue;

    unsupported.push(name(d, commit,
      `that commit does not touch ${clipReason(d.file)}; it touches `
      + `${changed.files.slice(0, MAX_NAMED_FILES).map((f) => clipReason(f)).join(', ')}`
      + `${changed.files.length > MAX_NAMED_FILES ? ', …' : ''}`));
  }
  return unsupported;
}

// Add this iteration's decisions. Entries are appended, never rewritten: the
// ledger is the record of what was decided when, and a decision that gets
// revisited is a second entry rather than an edit to the first.
export function recordDecisions(ledger, decisions, {
  iteration = (ledger.iterations ?? []).length + 1, atCommit, reportDigest = null,
  report = null,
} = {}) {
  // The whole report, not its `findings` array, and the first draft of this
  // took the array. `report.findings` on a file that is not a synthesis report
  // is `undefined`, `undefined` passed for a defaulted parameter takes the
  // default — so a caller doing the extraction itself spelled "I read a report
  // and could not find its findings" as "I was given no report", and the guard
  // below could not fire on the one input it exists for.
  //
  // The rule is `convergenceStatus`' rule for the same file: "I could not find
  // the findings" must not be spelled the same way as "there were none". Any
  // JSON that is not a synthesis report — a ledger, a decisions array, a
  // briefing — would derive no lane for anything and record a whole iteration
  // whose fix commits can never say who must not review them. A genuinely
  // finding-less report writes `findings: []` and passes.
  if (report !== null) requireFindings(report);

  const next = { ...ledger, entries: [...(ledger.entries ?? [])] };
  for (const d of decisions) {
    if (!DISPOSITIONS.includes(d.disposition)) {
      throw new Error(`unknown disposition ${JSON.stringify(d.disposition)}; expected one of ${DISPOSITIONS.join(', ')}`);
    }
    if (!d.reason || !String(d.reason).trim()) {
      throw new Error(`decision for ${JSON.stringify(d.title)} has no reason; an unexplained decision cannot be reviewed later`);
    }
    // Refused rather than ignored, the same call `validateFix` makes on a
    // top-level `deferred` key and for the same reason: ignoring a key leaves
    // the payload looking like it was read. `reporters` is derived here from
    // the report, and a caller that supplies its own is supplying the field a
    // regression pass excuses a lane on — which is the one selection the party
    // whose commit is under review must not make.
    if (d.reporters !== undefined) {
      throw new Error(`decision for ${JSON.stringify(d.title)} carries \`reporters\`; the `
        + 'reporting lanes are derived from the report this decision answers, not declared by '
        + 'whoever wrote the decision. Pass the report to --record instead');
    }
    // A fix commit on a decision that fixed nothing asserts the change the
    // decision says was not made — and `fixCommit` is what `closureOf` reads,
    // so the assertion would excuse a lane from reviewing a commit that closed
    // nothing it reported. `validateFix` refuses `commit` on a declined
    // payload entry for the same reason; this is the guard for a caller that
    // skipped the validator, which is the whole reason src/decisions.mjs keeps
    // its own.
    //
    // Read through `fixCommitOf`, so a decline spelling it `commit` — which is
    // the spelling the documented schema uses — is refused rather than waved
    // through. It was waved through: measured, a `declined` carrying `commit`
    // recorded at exit 0, past the refusal this comment describes.
    const declaredCommit = fixCommitOf(d);
    if (declaredCommit && d.disposition !== 'fixed') {
      throw new Error(`decision for ${JSON.stringify(d.title)} is ${d.disposition} and names `
        + `fix commit ${JSON.stringify(declaredCommit)}; only a fixed decision closes a finding `
        + 'with a commit');
    }
    next.entries.push({
      id: d.id ?? null,
      title: d.title,
      kind: d.kind ?? null,
      severity: d.severity ?? null,
      file: d.file ?? null,
      line: d.line ?? null,
      counterpart: d.counterpart ?? null,
      citedLine: d.citedLine ?? null,
      confidence: d.confidence ?? null,
      // The lanes that reported it, and the batch that decided it. Two facts,
      // and they were one field: `reporters` held the fix batch's label, so
      // the ledger said a fix agent had reported the finding it fixed.
      reporters: report ? reportersOf(d, report.findings) : [],
      agent: d.agent ?? null,
      // Which commit closed THIS finding, where `atCommit` below is the commit
      // the line numbers are valid at — the tree the panel READ. One batch
      // commit for every decision could not answer "what did this commit
      // close", so a regression pass's exclusion list had to be typed by the
      // party whose commit was under review (kfox/adverse#58, item 6).
      fixCommit: declaredCommit,
      disposition: d.disposition,
      reason: String(d.reason).trim(),
      // The root cause this decision was taken on, when it was taken on one:
      // `{id, title, citations: [{id, title}]}`. A group decision writes ONE
      // entry per citation, all carrying the same block — one decision made, N
      // entries recorded — so per-finding matching keeps working unchanged and
      // the group rides along only as context. See `recordedGroup`.
      group: d.group ?? null,
      iteration,
      atCommit,
      reportDigest,
    });
  }
  next.iterations = [...(ledger.iterations ?? []),
    { n: iteration, atCommit, reportDigest, decided: decisions.length }];
  return next;
}

// Which iteration a ledger is currently on, read off its own record of them.
//
// NOT the highest number any ENTRY carries. An iteration that recorded no
// entries is a documented, instructed state — `converge.mjs` tells the operator
// to record an iteration whose lanes all failed with "the decisions you have —
// an empty list is valid", because only `--record` advances the counter toward
// the cap. Derived from the entries, such an iteration answers with the
// PREVIOUS one, putting commits that were already passed or declared back on
// the list, one iteration late and every iteration after. `recordDecisions`
// writes `{ n: iteration }` as it writes those entries, so the row is the
// number they carry rather than a re-derivation of it.
//
// The entries are the fallback for a ledger with no iteration rows at all —
// answering 0 there would make this silent on a malformed ledger, which is the
// direction this check exists to fail away from.
function latestIteration(ledger) {
  const recorded = (ledger.iterations ?? []).at(-1)?.n;
  if (Number.isInteger(recorded)) return recorded;
  return Math.max(0, ...(ledger.entries ?? []).map((e) => e.iteration ?? 0));
}

// The fix commits one iteration produced, and what each closed
// (kfox/adverse#58, item 3).
//
// `closureOf` answers "what did THIS commit close" for a commit the caller
// already has. This is the other direction — "which commits are there to ask
// about" — and nothing could answer it, which is why nothing could check that
// a regression pass was offered per fix commit. Phase 9 runs one pass per fix
// commit, so the pass needs the list before it can say which of them it read.
//
// Scoped to one iteration by default, and that default is the latest. A ledger
// accumulates every iteration's commits forever, so the whole-ledger list would
// accuse iteration 3 of skipping passes on iteration 1's commits — which were
// either passed or declared at the time, and are in neither case this
// iteration's work.
//
// Distinct by the spelling recorded, which means two decisions naming one
// commit two ways arrive as two rows. Resolving here would need a repository
// and this module stays pure — the caller already has one, because it has to
// resolve a pass's commit too (a pass names whatever the fix agent typed), so
// it is where the merge belongs.
export function fixCommitsIn(ledger, { iteration = null } = {}) {
  const entries = (ledger.entries ?? []).filter((e) => e.disposition === 'fixed' && e.fixCommit);
  const n = iteration ?? latestIteration(ledger);
  const byCommit = new Map();
  for (const e of entries) {
    if ((e.iteration ?? 0) !== n) continue;
    byCommit.set(e.fixCommit, (byCommit.get(e.fixCommit) ?? 0) + 1);
  }
  return [...byCommit].map(([commit, closes]) => ({ commit, closes }));
}

// What a fix commit closed, according to the ledger.
//
// This is the question item 6 of kfox/adverse#58 was filed because nothing
// could answer, and the answer has one consumer: the regression pass, which
// must not be run by a lane that reported a finding this commit closed. That
// list used to be typed on the command line by the orchestrator that wrote the
// commit — `--closed-by auditor` — and one wrong-but-well-formed name bought an
// artifact asserting a disinterest nothing had checked.
//
// `resolve` maps a revision to a commit id and is injected the way
// `checkBinding` injects it, so this module stays pure. Revisions are compared
// RESOLVED, never as strings: an entry holds whatever the fix agent named, so
// `HEAD~1` and the sha it pointed at are one commit spelled two ways, and
// string equality would answer "closed nothing" for both — the derived form of
// `--closed-by-none`, reached by spelling a revision differently.
//
// Four fields, because a caller has four situations to tell apart and three of
// them look identical from a lane list alone. Only the third is an answer:
//
//   recorded: false   no `fixed` entry here names a fix commit at all, so this
//                     ledger was written before the mapping existed and cannot
//                     say. An empty `lanes` means "unanswerable", not "nothing".
//   unattributed > 0  entries matched, and that many recorded no reporting
//                     lane — `--record` ran without `--report`, so the report
//                     that names the lanes was never read. Deriving from the
//                     attributed half would claim a completeness nobody has.
//   closed: 0         this commit closed no recorded finding. A real answer,
//                     and the derived form of `--closed-by-none`.
//   lanes             the lanes, sorted and deduped.
//
// An entry whose own `fixCommit` resolves nowhere silently fails to match and
// would push a caller toward `closed: 0`. That is closed one layer up:
// `checkBinding` refuses such a ledger outright, and every bridge that reads
// one runs it first.
export function closureOf(ledger, commit, resolve) {
  const seen = new Map();
  const resolveOnce = (ref) => {
    if (!seen.has(ref)) seen.set(ref, resolve(ref));
    return seen.get(ref);
  };

  const target = resolveOnce(commit);
  // Thrown, not answered. Every honest return value from here says something
  // about a commit, and there is nothing to say about one that does not exist;
  // "it closed nothing" is what a typo would get, and it excuses no lane.
  if (!target) {
    throw new TypeError(`ledger: ${JSON.stringify(commit)} does not resolve to a commit in this`
      + ' repository, so what it closed cannot be read');
  }

  const fixes = (ledger.entries ?? []).filter((e) => e.disposition === 'fixed' && e.fixCommit);
  const closed = fixes.filter((e) => resolveOnce(e.fixCommit) === target);
  const lanes = new Set();
  for (const e of closed) for (const lane of e.reporters ?? []) lanes.add(lane);

  return {
    recorded: fixes.length > 0,
    closed: closed.length,
    unattributed: closed.filter((e) => !(e.reporters ?? []).length).length,
    lanes: [...lanes].sort(),
  };
}

// The stop condition.
//
// Terminate when nothing is both credible enough and consequential enough to
// hold the change open, after subtracting what has already been settled. Every
// input is data the panel already produced; no model judges this.
export function convergenceStatus(report, ledger, traceFor = () => null,
                                  { maxIterations = 3, reportDigest = null } = {}) {
  // `report.findings ?? []` read a missing array as an empty one, so any valid
  // JSON that is not a synthesis report — a ledger, a decisions array, a
  // briefing — converged the loop and exited 0, the success signal, on a review
  // nobody read. A genuinely clean run writes `findings: []` and still
  // converges; "I could not find the findings" must not be spelled the same way
  // as "there were none".
  if (!Array.isArray(report.findings)) {
    throw new Error('report has no findings array; this is not a synthesis report');
  }

  // `blocking` is the gate everything below derives from, and it was a
  // truthiness test on a field read out of a JSON file — so a report that
  // simply omits it converged with a critical defect inside. That is the same
  // fail-open `examined` was changed from `!== false` to `=== true` to close,
  // twenty lines down, and the two must not disagree about what missing means.
  //
  // So the field can only ever ADD: a finding whose own shape is blocking
  // blocks whatever the field says, which also stops a report from marking a
  // critical defect non-blocking. `isBlocking` is imported rather than
  // re-spelled here, because two definitions of blocking is how they drift.
  const blocking = report.findings.filter((f) => f.blocking === true || isBlocking(f));

  // Annotate EVERY blocking finding, then bucket. Two things turn on this.
  //
  // `done` is derived from what is left unsettled, not from the union of the
  // buckets below. Three times now a blocking finding has converged the loop by
  // matching no bucket — first the confidence gate dropped solo findings, then
  // a report-wide flag disarmed the gate that replaced it, then a challenged
  // critical fell between `open` and `unexamined`. Each fix added a bucket and
  // left the same shape of hole for the next one. Deriving the stop condition
  // from `unsettled` closes the shape: a finding that matches no bucket is
  // still counted, and the buckets only decide how it is described.
  //
  // And `regressed`/`unverified` used to be computed over the credible subset
  // alone, so a solo finding recorded FIXED that came back was described as
  // never cross-examined — while the Skill calls a REGRESSED finding the
  // loudest thing in the run. One pass over everything says it once.
  const annotated = annotate(blocking, ledger, traceFor, { reportDigest });
  const settled = annotated.filter((f) => f.adjudicated?.settled);
  const unsettled = annotated.filter((f) => !f.adjudicated?.settled);

  // A finding recorded FIXED against the very report being checked has not
  // been re-observed — the report predates the fix. Calling that REGRESSED
  // makes the first convergence check after every fix batch scream, and the
  // Skill tells the orchestrator to lead with REGRESSED, so the one signal
  // the loop trusts most would be noise by construction.
  // Both headings speak of a fix — "recorded fixed, reported again" and
  // "recorded fixed against THIS report" — so both have to key on the
  // disposition that gives them that meaning. Keying on "has an adjudication
  // and is unsettled" swept in a `declined` entry that matched too weakly to
  // settle (score 1, file-wide), and announced a brand-new finding as REGRESSED
  // in a file that merely carried one line-less declined entry. The Skill tells
  // the orchestrator to lead with REGRESSED, so that is a manufactured alarm on
  // the loop's loudest signal.
  // The match must also be strong enough to be about this finding: a `fixed`
  // entry with no line matches every finding of its kind in the file, and
  // "the fix did not work" is too loud a claim to make on a file-wide guess.
  const regressed = unsettled.filter((f) => isRegressionCandidate(f)
    && !f.adjudicated.sameReport);
  const unverified = unsettled.filter((f) => isRegressionCandidate(f)
    && f.adjudicated.sameReport);

  // "Credible enough to hold the loop open" is the same question synthesis.mjs
  // answers for the report's headline number — `isOpenBlocking` imported
  // rather than restated here, so the two cannot drift the way they used to.
  const credible = isOpenBlocking;

  // Absence is not evidence of cross-examination.
  //
  // Two things here, and both are the same lesson learned twice. It reads
  // `=== true` rather than `!== false`, because a report written before
  // per-finding `cross_examined` existed — or by hand — carries no such field,
  // and `undefined !== false` counted every blocking finding as examined: the
  // exact leak this gate was added to close, preserved verbatim for missing
  // data. And it consults only the finding, never the report-wide flag it used
  // to fall back to, because a report-wide boolean answers "did anyone
  // cross-examine anything?" — which is true in every ordinary run and says
  // nothing about the finding in hand. Falling back to it re-armed, for
  // legacy reports, precisely the report-wide gate that had to be replaced.
  const examined = (f) => f.cross_examined === true;

  // Not credible on its own, and nobody went on record either way. Held rather
  // than dropped, until a reviewer examines it or a decision settles it.
  const unexamined = unsettled.filter((f) => !credible(f) && !examined(f));

  // Challenged on record — and still blocking until someone decides.
  //
  // `synthesis.mjs` labels a finding `disputed` the moment ONE challenger
  // appears, before it counts reporters, so a critical two personas found and
  // one disagreed with is labeled the same as a lone hunch. Treating that as
  // defeated let any single persona erase a blocking critical from the run by
  // posting one challenge. A dispute is not a verdict; it is the case that most
  // needs adjudicating, and this tool already has the mechanism for that — a
  // recorded decision. So it holds the loop open and the challenger's reasoning
  // goes in the ledger, where the next iteration can see who decided what.
  const disputed = unsettled.filter((f) => !credible(f) && examined(f)
    && f.confidence === 'disputed');

  const open = unsettled.filter(credible);

  // Whatever the named buckets did not describe. Unreachable for a report this
  // tool generated — `solo` means no validators and no challengers, so
  // `toJsonReport` writes `cross_examined: false` — but reachable from a
  // hand-edited one, where `solo` can arrive alongside `cross_examined: true`
  // and match no bucket. That is why the stop condition does not depend on
  // this being empty: such a finding is counted and blocks either way, and
  // surfaces here instead of disappearing.
  const named = new Set([...open, ...unexamined, ...disputed]);
  const other = unsettled.filter((f) => !named.has(f));

  // A lane that was TRIED and FAILED reviewed nothing, and "reviewed and found
  // nothing" is the same input to this gate as "never looked": both contribute
  // zero findings. `synthesis.mjs` states the doctrine where it builds these
  // two lists — "a lane that was skipped and not mentioned reads exactly like a
  // lane that looked and found nothing" — and the stop condition was the last
  // place still reading it that way. The reviewers read the diff, so a file big
  // enough to blow the Adversary's budget removed every security finding from
  // the run and still exited 0, which the ship loop reads as "hand over a green
  // PR".
  //
  // `degraded` holds the loop open; the remedy is to re-run the lane, and a
  // lane that keeps failing reaches the cap, which is a stop that says so.
  // `skipped` does not — it is a deliberate, recorded choice — but it is
  // returned so the run can never render as a clean one.
  const degraded = Array.isArray(report.degraded) ? report.degraded : [];
  const skipped = Array.isArray(report.skipped) ? report.skipped : [];

  const iteration = (ledger.iterations ?? []).length + 1;
  const capped = iteration > maxIterations;
  const done = unsettled.length === 0 && degraded.length === 0;

  return {
    iteration,
    maxIterations,
    open,
    settled,
    regressed,
    unverified,
    unexamined,
    disputed,
    other,
    degraded,
    skipped,
    done,
    capped,
    // The cap is a stop, not a pass. A run that ends here has open findings and
    // has to say so, or the loop's whole promise is a lie told by an exit code.
    reason: done
      ? 'converged: no blocking finding is unsettled'
      : capped
        ? `iteration cap (${maxIterations}) reached with ${unsettled.length} still open`
          + (degraded.length ? `, and ${degraded.length} lane(s) that never reviewed` : '')
        : describeRemaining({ open, unexamined, disputed, other, degraded }),
  };
}

// Say what is actually holding the loop open, in the loop's own vocabulary.
function describeRemaining({ open, unexamined, disputed, other, degraded }) {
  const parts = [];
  if (open.length) parts.push(`${open.length} still open`);
  if (unexamined.length) parts.push(`${unexamined.length} never cross-examined`);
  if (disputed.length) parts.push(`${disputed.length} disputed`);
  if (other.length) parts.push(`${other.length} unclassified`);
  if (degraded.length) parts.push(`${degraded.length} lane(s) failed and reviewed nothing`);
  return parts.join(', ');
}
