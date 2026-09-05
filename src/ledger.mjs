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

export const LEDGER_VERSION = 1;

// How far a traced anchor may drift and still be the same finding. Tighter
// than triage's clustering window: clustering guesses that two findings are
// related, this asserts that two findings ARE one, and a false match here
// silently buries a real finding under an old decision.
const MATCH_WINDOW_LINES = 5;

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
export function scoreMatch(entry, finding, traced = null) {
  if (normalizeTitle(entry.title) && normalizeTitle(entry.title) === normalizeTitle(finding.title)) {
    return { score: 3, why: 'identical title' };
  }
  if ((entry.kind ?? null) !== (finding.kind ?? null)) return null;

  const entryFile = traced?.file ?? entry.file;
  if (!entryFile || !finding.file || entryFile !== finding.file) return null;

  if (entry.kind === 'contract') {
    if (entry.counterpart && entry.counterpart === finding.counterpart) {
      return { score: 2, why: `same code/counterpart pair (${entryFile} vs ${entry.counterpart})` };
    }
    return null;
  }

  // `design` is advisory and never blocks, so a positional match buys nothing
  // and a wrong one buries real feedback. Title equality above is its only path.
  if (entry.kind === 'design') return null;

  const entryLine = traced?.line ?? entry.line;
  if (entryLine === null || entryLine === undefined
      || finding.line === null || finding.line === undefined) {
    return { score: 1, why: `same kind in ${entryFile}, but no line on one side` };
  }
  const drift = Math.abs(entryLine - finding.line);
  if (drift <= MATCH_WINDOW_LINES) {
    return { score: 2, why: `same kind at ${entryFile}:${entryLine} (drift ${drift})` };
  }
  return null;
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
export function annotate(findings, ledger, traceFor = () => null) {
  return findings.map((f) => {
    const m = matchFinding(ledger, f, traceFor);
    if (!m) return f;
    const settled = isSettled(m.entry.disposition);
    return {
      ...f,
      adjudicated: {
        matchedId: m.entry.id ?? null,
        disposition: m.entry.disposition,
        reason: m.entry.reason ?? null,
        iteration: m.entry.iteration ?? null,
        atCommit: m.entry.atCommit ?? null,
        matchedBy: m.why,
        confidence: m.score,
        settled,
        note: settled
          ? 'Already decided in an earlier iteration. Do not re-open it. Challenge '
            + 'only if that decision rested on something the fix has since changed.'
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
export function recordDecisions(ledger, decisions, { iteration, atCommit }) {
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
    });
  }
  next.iterations = [...(ledger.iterations ?? []), { n: iteration, atCommit, decided: decisions.length }];
  return next;
}

// The stop condition.
//
// Terminate when nothing is both credible enough and consequential enough to
// hold the change open, after subtracting what has already been settled. Every
// input is data the panel already produced; no model judges this.
export function convergenceStatus(report, ledger, traceFor = () => null, { maxIterations = 3 } = {}) {
  const open = (report.findings ?? []).filter((f) => f.blocking
    && (f.confidence === 'cross-validated' || f.confidence === 'consensus'));

  const annotated = annotate(open, ledger, traceFor);
  const settled = annotated.filter((f) => f.adjudicated?.settled);
  const regressed = annotated.filter((f) => f.adjudicated && !f.adjudicated.settled);
  const remaining = annotated.filter((f) => !f.adjudicated?.settled);

  const iteration = (ledger.iterations ?? []).length + 1;
  const capped = iteration > maxIterations;

  return {
    iteration,
    maxIterations,
    open: remaining,
    settled,
    regressed,
    done: remaining.length === 0,
    capped,
    // The cap is a stop, not a pass. A run that ends here has open findings and
    // has to say so, or the loop's whole promise is a lie told by an exit code.
    reason: remaining.length === 0
      ? 'converged: no blocking finding is unsettled'
      : capped
        ? `iteration cap (${maxIterations}) reached with ${remaining.length} still open`
        : `${remaining.length} blocking finding(s) still open`,
  };
}
