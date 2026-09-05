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
//
// Suppressing `fixed` would be the natural-looking optimization and it would
// quietly convert this from a convergence loop into a machine for declaring
// victory.
//
// Identity across iterations is kind-routed, because a line number is not an
// identity once a fix has shifted the file. Positions are re-projected by
// src/trace.mjs first; matching then works on the traced anchor.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

import { ADVISORY_KINDS } from './prompts.mjs';
import { isBlocking } from './synthesis.mjs';

export const LEDGER_VERSION = 1;

// How far a traced anchor may drift and still be the same finding. Tighter
// than triage's clustering window: clustering guesses that two findings are
// related, this asserts that two findings ARE one, and a false match here
// silently buries a real finding under an old decision.
const MATCH_WINDOW_LINES = 5;
const MAX_BINDING_PROBLEMS = 20;
// `SAFE_REF` admits unbounded distinct spellings of one commit — HEAD, HEAD~0,
// HEAD~0~0 — so de-duplicating on the ref STRING still let 900 entries cost 900
// spawns, and because they all resolved, no problem was recorded and the cap
// never fired: the ledger was accepted after 11 seconds of forking. An honest
// ledger names a handful of commits.
const MAX_DISTINCT_REFS = 50;

// The weakest match that may settle a finding. Below it, annotate only.
const SETTLING_SCORE = 2;

// Longest ledger `reason` copied into a briefing. The ledger is a JSON file on
// disk, and its text is rendered into the round-2 prompt, so it is a channel
// for whoever can write that file. Clipping bounds the payload; labeling it in
// the briefing is what tells a reviewer it is data, not instruction.
const MAX_REASON_CHARS = 500;

function clipReason(text) {
  const flat = String(text ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ');
  return flat.length > MAX_REASON_CHARS ? `${flat.slice(0, MAX_REASON_CHARS)}… [clipped]` : flat;
}

export const DISPOSITIONS = Object.freeze(['fixed', 'declined', 'deferred']);
const SETTLED = new Set(['declined', 'deferred']);

export function isSettled(disposition) {
  return SETTLED.has(disposition);
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
  const seen = new Map();
  let refBudgetSpent = false;
  const resolveOnce = (ref) => {
    if (seen.has(ref)) return seen.get(ref);
    if (seen.size >= MAX_DISTINCT_REFS) {
      refBudgetSpent = true;
      return null;
    }
    seen.set(ref, resolve(ref));
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
    if (e.disposition !== undefined && !DISPOSITIONS.includes(e.disposition)) {
      problems.push(`entry ${JSON.stringify(e.title)} has disposition ${JSON.stringify(e.disposition)}, which is not one of ${DISPOSITIONS.join(', ')}`);
    }
  }
  if (refBudgetSpent) {
    problems.push(`ledger names more than ${MAX_DISTINCT_REFS} distinct commits; `
      + 'a decision log for one branch names a handful');
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
// Only a score of 2 or better may SETTLE a finding — see SETTLING_SCORE. A
// score-1 match is file-wide by construction: an entry carrying `line: null`
// matches every finding of its kind anywhere in that file, so honoring it as a
// settlement turns one `declined` entry into a blanket amnesty for the file.
// The ledger is a JSON file the loop reads back from disk, so that is a way to
// make the panel report a clean review it never performed. Score 1 still
// annotates, because a prior decision nearby is worth showing a reviewer.
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

  const entryFile = traced?.file ?? entry.file;
  if (!entryFile || !finding.file || entryFile !== finding.file) return null;

  // Title equality is checked HERE, below the file and kind guards, not above
  // them. It used to return first, so a decision recorded in one file settled
  // an identically-titled finding in another file, of any kind and any
  // severity — and reviewers reuse titles ("off-by-one in the loop bound")
  // across files precisely because the defect is the same shape.
  if (normalizeTitle(entry.title)
      && normalizeTitle(entry.title) === normalizeTitle(finding.title)) {
    return { score: 3, why: `identical title in ${entryFile}` };
  }

  const entryLine = numericLine(traced?.line ?? entry.line);
  const findingLine = numericLine(finding.line);

  if (entry.kind === 'contract') {
    if (!entry.counterpart || entry.counterpart !== finding.counterpart) return null;
    // A code/counterpart pair with no line is file-wide, exactly the shape
    // SETTLING_SCORE exists to refuse. It used to score 2 here — one planted
    // entry settled every contract finding in a file, and the loop reported
    // itself converged. It annotates; only an anchor that lines up settles.
    if (entryLine === null || findingLine === null) {
      return { score: 1, why: `same code/counterpart pair (${entryFile} vs ${entry.counterpart}), but no line on one side` };
    }
    const cdrift = Math.abs(entryLine - findingLine);
    if (cdrift > MATCH_WINDOW_LINES) return null;
    return { score: 2, why: `same code/counterpart pair at ${entryFile}:${entryLine} (drift ${cdrift})` };
  }

  // An advisory kind never blocks, so a positional match buys nothing and a
  // wrong one buries real feedback. Title equality above is its only path.
  if (ADVISORY_KINDS.has(entry.kind)) return null;

  if (entryLine === null || findingLine === null) {
    return { score: 1, why: `same kind in ${entryFile}, but no line on one side` };
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
  if ((entry.severity ?? null) !== (finding.severity ?? null)) {
    return {
      score: 1,
      why: `same kind at ${entryFile}:${entryLine} (drift ${drift}), but the `
        + `decision was taken on a ${entry.severity ?? 'severity-less'} finding `
        + `and this one is ${finding.severity ?? 'severity-less'}`,
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

// Annotate findings with the decision that already covers them.
//
// `adjudicated.settled` is the flag that suppresses re-litigation. A finding
// matching a `fixed` entry is annotated too, but never settled — see the note
// at the top of this file.
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
    return {
      ...f,
      adjudicated: {
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
        confidence: m.score,
        settled,
        sameReport,
        note: settled
          ? 'Already decided in an earlier iteration. Do not re-open it. Challenge '
            + 'only if that decision rested on something the fix has since changed.'
          : tooWeak
            ? 'An earlier decision covers this file, but it names no line, so it is '
              + 'too weak to settle this finding. Judge the finding on its merits; '
              + 'the earlier reason is shown only as context.'
            : sameReport
              ? 'Recorded FIXED against THIS report, which was produced before the '
                + 'fix. Not evidence of anything yet: the fix has not been observed. '
                + 'Verify it (Phase 9) and re-synthesize before judging.'
              : 'This was recorded FIXED in an earlier iteration. If it is still real, '
                + 'the fix did not work — say exactly what the fix missed. That is more '
                + 'important than any new finding on this pass.',
      },
    };
  });
}

// Add this iteration's decisions. Entries are appended, never rewritten: the
// ledger is the record of what was decided when, and a decision that gets
// revisited is a second entry rather than an edit to the first.
export function recordDecisions(ledger, decisions, { iteration, atCommit, reportDigest = null }) {
  const next = { ...ledger, entries: [...(ledger.entries ?? [])] };
  for (const d of decisions) {
    if (!DISPOSITIONS.includes(d.disposition)) {
      throw new Error(`unknown disposition ${JSON.stringify(d.disposition)}; expected one of ${DISPOSITIONS.join(', ')}`);
    }
    if (!d.reason || !String(d.reason).trim()) {
      throw new Error(`decision for ${JSON.stringify(d.title)} has no reason; an unexplained decision cannot be reviewed later`);
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
      reporters: d.reporters ?? [],
      disposition: d.disposition,
      reason: String(d.reason).trim(),
      iteration,
      atCommit,
      reportDigest,
    });
  }
  next.iterations = [...(ledger.iterations ?? []),
    { n: iteration, atCommit, reportDigest, decided: decisions.length }];
  return next;
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
  const wasFixed = (f) => f.adjudicated?.disposition === 'fixed'
    && f.adjudicated.confidence >= SETTLING_SCORE;
  const regressed = unsettled.filter((f) => wasFixed(f) && !f.adjudicated.sameReport);
  const unverified = unsettled.filter((f) => wasFixed(f) && f.adjudicated.sameReport);

  const credible = (f) => f.confidence === 'cross-validated' || f.confidence === 'consensus';

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
  // one disagreed with is labelled the same as a lone hunch. Treating that as
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
