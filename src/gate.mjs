// What the repository's own checks actually said, and whether that is evidence.
//
// The gate is the one artifact in this flow whose job is to STOP reviewers
// reporting things. Round 2's briefing prompt tells every lane: where the gate
// says green, do not report anything those tools would have caught — type
// errors, lint, failing tests, schema or build drift. That is a suppression
// instruction spanning four lanes and a whole category of finding.
//
// It used to be sourced from a sentence the orchestrator typed from memory
// (`GATE="lint green · 1,412 tests pass · …"`), and nothing checked it. Every
// one of these produced a green-looking string and no error: the checks were
// never run; they ran against a different tree; one was red and the summary
// rounded it off; the numbers were invented. Phase 2 already refuses this exact
// shape for reviewer payloads — "the reviewer writes the file, you never retype
// it" — and the gate has the same provenance problem with a wider blast radius.
// A bad payload costs one lane's findings. A bad gate silently narrows what
// four lanes are willing to say, and the report then shows no findings in a
// category nobody was allowed to look at.
//
// So: a gate is a record of commands that ran, with their exit codes and the
// commit they ran against. `verified` is computed here, in Node, and it is the
// only thing a prompt is allowed to suppress on. Everything else — a missing
// gate, an unreadable one, a hand-typed summary, a green run against the wrong
// tree — is `verified: false`, which suppresses nothing.
//
// That asymmetry is deliberate and it is the whole fix. An unverified green
// costs silence that reads as a clean review. A gate that fails to verify costs
// a handful of findings the user already knew about. The second is recoverable
// by reading past them; the first is not recoverable at all, because nobody can
// see what was never reported.

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

import { refuseDirectRun } from './entryGuard.mjs';

refuseDirectRun(import.meta.url);

export const DEFAULT_CHECK_TIMEOUT_MS = 600_000;

// Every status this module can return, and the contract for reading them:
//   green    every configured check ran and exited 0
//   red      a check ran and said no
//   partial  a check could not be run at all, and none of the others failed
//   unknown  no check ran, or the record did not come from running anything
export const GATE_STATUSES = ['green', 'red', 'partial', 'unknown'];

// `measured` means this module ran the commands. `asserted` means somebody said
// so. The distinction is the point of the file, so it is a field and not a
// convention about how `summary` is worded.
export const GATE_SOURCES = ['measured', 'asserted'];

const NOT_RUN = null;

// HEAD is not the whole answer. Phase 0's second scope rule reviews UNCOMMITTED
// changes, and a commit SHA does not move when those change — so a gate bound
// to HEAD alone stays "current" across an edit that invalidated it. This
// digests the uncommitted state beside it, so the pair identifies the tree the
// checks actually ran against.
//
// `git diff HEAD` covers content changes to tracked files; `git status
// --porcelain` covers files appearing, vanishing, or changing staged state.
// What neither covers is an edit to an already-untracked file, which changes
// nothing in either output. That gap is narrow and it is left open rather than
// papered over: reporting a digest that cannot see part of the tree is better
// than implying one that can.
export function worktreeDigest(repo, { exec = execFileSync } = {}) {
  const git = (args) => exec('git', args, { cwd: repo, encoding: 'utf-8', stdio: 'pipe' });
  try {
    return createHash('sha256')
      .update(git(['status', '--porcelain']))
      .update('\u0000')
      .update(git(['diff', 'HEAD']))
      .digest('hex');
  } catch {
    // Unreadable is not clean. Returning a digest here would claim the tree
    // was inspected; null makes the binding fail to establish instead.
    return null;
  }
}

function lastMeaningfulLine(text) {
  if (typeof text !== 'string') return '';
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1].slice(0, 200) : '';
}

function statusOf(checks) {
  if (!checks.length) return 'unknown';
  if (checks.some((c) => c.exitCode !== NOT_RUN && c.exitCode !== 0)) return 'red';
  if (checks.some((c) => c.exitCode === NOT_RUN)) return 'partial';
  return 'green';
}

function summarize(checks) {
  if (!checks.length) return 'no checks configured';
  return checks.map((c) => {
    if (c.exitCode === NOT_RUN) return `${c.name} did not run`;
    return `${c.name} exit ${c.exitCode}`;
  }).join(' · ');
}

// One check. `run` is injected so the tests do not have to shell out, and so a
// caller that already has results can build a record without re-running them.
export function runCheck({ name, command }, { cwd, timeoutMs = DEFAULT_CHECK_TIMEOUT_MS, run = spawnSync } = {}) {
  const r = run(command, { cwd, shell: true, encoding: 'utf-8', timeout: timeoutMs });

  // A command that could not be spawned, or that the timeout killed, did not
  // answer the question. That is `exitCode: null` — NOT a failure and never a
  // pass. Folding it into either one is how "we could not tell" becomes a
  // verdict, which is the class of bug this whole file exists to close.
  const couldNotRun = r.error != null || r.signal != null || typeof r.status !== 'number';

  return {
    name,
    command,
    exitCode: couldNotRun ? NOT_RUN : r.status,
    // A failure explains itself on stderr; a pass, when it says anything at
    // all, says it on stdout. Reading stderr first either way made every
    // green check report its runner's banner.
    result: couldNotRun
      ? `did not run: ${r.error?.message ?? (r.signal ? `killed by ${r.signal}` : 'no exit status')}`
      : (r.status === 0
        ? (lastMeaningfulLine(r.stdout) || lastMeaningfulLine(r.stderr))
        : (lastMeaningfulLine(r.stderr) || lastMeaningfulLine(r.stdout))),
  };
}

// Run every configured check against `cwd` and bind the result to `head`.
export function runGate(checks, { cwd, head, worktree = null, timeoutMs, run } = {}) {
  const results = checks.map((c) => runCheck(c, { cwd, timeoutMs, run }));
  return finalize({
    status: statusOf(results),
    head: head ?? null,
    worktree,
    source: 'measured',
    summary: summarize(results),
    checks: results,
  });
}

// A hand-typed summary, preserved so a reader can see what was claimed, and
// marked as the claim it is. It never suppresses anything.
export function assertedGate(summary) {
  return finalize({
    status: 'unknown',
    head: null,
    worktree: null,
    source: 'asserted',
    summary: String(summary),
    checks: [],
  });
}

// Compute `verified` and, when it is false, the one-line reason. Everything a
// prompt reads about trust comes from here and nowhere else, so there is one
// place to audit and one place a new status has to be handled.
function finalize(gate, { head = null, worktree = null } = {}) {
  const stale = head != null && gate.head != null && gate.head !== head;
  const unbound = head != null && gate.head == null && gate.source === 'measured';
  // Only checkable when the caller supplied a digest of its own. A caller that
  // did not compute one asks a narrower question, and gets the HEAD answer.
  const moved = worktree != null && gate.worktree != null && gate.worktree !== worktree;
  const unpinned = worktree != null && gate.worktree == null && gate.source === 'measured';

  let why = '';
  if (gate.source !== 'measured') why = 'summary was asserted, not measured — no command is known to have run';
  else if (stale) why = `checks ran against ${gate.head.slice(0, 8)}, not the tree under review (${head.slice(0, 8)})`;
  else if (unbound) why = 'checks are not bound to a commit, so they may describe a different tree';
  else if (moved) why = 'the working tree changed after the checks ran';
  else if (unpinned) why = 'checks are not pinned to a working-tree state, so uncommitted changes may have moved since';
  else if (gate.status === 'red') why = 'a check failed';
  else if (gate.status === 'partial') why = 'a check could not be run';
  else if (gate.status === 'unknown') why = 'no check ran';

  return { ...gate, verified: why === '', why };
}

// Canonicalize whatever arrived — nothing, a legacy summary string, or a record
// written by runGate — into one shape, re-checked against the tree under review.
//
// Re-running `finalize` here rather than trusting a stored `verified` is not
// belt-and-braces: the stored flag was computed when the checks ran, before
// anyone knew which commit would be reviewed. Staleness is only knowable now.
export function normalizeGate(value, { head = null, worktree = null } = {}) {
  if (value == null) return null;
  if (typeof value === 'string') return finalize(assertedGate(value), { head, worktree });
  if (typeof value !== 'object') return finalize(assertedGate(String(value)), { head, worktree });

  const checks = Array.isArray(value.checks) ? value.checks : [];
  const source = GATE_SOURCES.includes(value.source) ? value.source : 'asserted';
  const status = GATE_STATUSES.includes(value.status)
    ? value.status
    : (source === 'measured' ? statusOf(checks) : 'unknown');

  return finalize({
    status,
    head: typeof value.head === 'string' ? value.head : null,
    worktree: typeof value.worktree === 'string' ? value.worktree : null,
    source,
    summary: typeof value.summary === 'string' ? value.summary : summarize(checks),
    checks,
  }, { head, worktree });
}

// `name=command`, the form the bridge accepts. The name is a label for the
// summary line; the command is whatever this repo calls that check.
export function parseCheckSpec(spec) {
  const at = String(spec).indexOf('=');
  if (at < 1) return null;
  const name = spec.slice(0, at).trim();
  const command = spec.slice(at + 1).trim();
  if (!name || !command) return null;
  return { name, command };
}
