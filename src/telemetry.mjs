// One line per run, appended to a file that outlives the run directory.
//
// The ledger persists DECISIONS — per finding, per branch. Nothing persisted a
// run's arithmetic, so every rule in src/scaling.mjs (the Pragmatist skip, the
// two-agent split, the escalated cap) rests on one remembered incident each,
// and the questions those rules answer are all questions about many runs
// (kfox/adverse#72).
//
// ONE FILE PER MACHINE, not one per repository. The questions worth asking
// span repositories — at what diff size does a lane actually start failing? is
// one persona's anchor quality consistently worse? — and a file inside each
// checkout answers them only for the repo someone happens to be standing in,
// and disappears with the clone. `repo` is a field instead, taken from the
// remote's owner/name so that two checkouts of one project agree and no local
// path is recorded. Same directory as the ledgers, for the same reason.
//
// COUNTS ONLY, never prose: no finding titles, no details, no summaries, no
// skip reasons, no file paths, no plan `reason` strings. The file has to stay
// something a maintainer can paste into an issue while arguing about a
// threshold, and a record carrying reviewer sentences about someone's private
// code is not that. The rule is a test rather than a promise — the suite builds
// a record from payloads whose every string field is a sentinel and asserts
// that none of them survives.
//
// A telemetry failure never fails a run. Everywhere else this codebase fails
// closed, because everywhere else the thing that could not be established is a
// claim ABOUT a review. This is an observation OF one: refusing to publish the
// report because the note could not be filed would let bookkeeping gate a merge
// decision, which is the worse of the two outcomes by a wide margin.

import { execFileSync } from 'node:child_process';
import { appendFileSync, constants, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { refuseDirectRun } from './entryGuard.mjs';
import { isBlocking } from './synthesis.mjs';

refuseDirectRun(import.meta.url);

// Bumped when a field changes meaning, never when one is added: a reader that
// mixes schemas has to be able to tell which questions a line can answer.
export const TELEMETRY_SCHEMA = 1;

const GIT_TIMEOUT_MS = 5_000;

// A lane's four states, which are four different facts and have been collapsed
// into "no findings" by every tool that did not keep them apart.
export const LANE_STATUS = Object.freeze({
  reported: 'reported',   // it looked, and here is what it found (0 is a result)
  degraded: 'degraded',   // it was tried and it failed: it did not look
  skipped: 'skipped',     // it was deliberately not run
  silent: 'silent',       // the plan ran it and nothing arrived, undeclared
});

// Null prototype: the keys are payload-derived, and on a plain object
// `counts['__proto__'] = 1` sets the prototype instead of storing a count while
// `counts.constructor` answers with a function. Same reason SEVERITY_RANK in
// src/taxonomy.mjs has one.
function countBy(items, pick) {
  const counts = Object.create(null);
  for (const item of items) {
    const key = pick(item);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd, encoding: 'utf-8', timeout: GIT_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

// `owner/name` from any remote spelling, and nothing else from it. Splitting on
// both separators and keeping the last two segments drops the scheme, the host,
// and — the reason it is written this way — a `user:token@` netloc that some
// CI checkouts leave in the origin URL.
export function repoFromRemote(url) {
  const trimmed = url.trim().replace(/\.git$/, '');
  if (!trimmed) return null;
  // A local-path remote is a filesystem path, and its parent segment is
  // somebody's directory layout rather than a project name.
  if (trimmed.startsWith('/') || trimmed.startsWith('.')) return path.basename(trimmed);
  const segments = trimmed.split(/[/:]/).filter(Boolean);
  if (segments.length < 2) return null;
  return segments.slice(-2).join('/');
}

// Identity, or nulls. A run outside a repository, or with git unavailable, is
// still worth recording — the roster and finding counts do not depend on it.
export function repoIdentity(cwd = process.cwd()) {
  let repo = null;
  let head = null;
  try {
    repo = repoFromRemote(git(['remote', 'get-url', 'origin'], cwd));
  } catch {
    try {
      repo = path.basename(git(['rev-parse', '--show-toplevel'], cwd));
    } catch { /* not a repository */ }
  }
  try {
    head = git(['rev-parse', 'HEAD'], cwd);
  } catch { /* no commits, or not a repository */ }
  return { repo, head };
}

function planSummary(plan) {
  if (!plan) return null;
  const size = plan.size ?? {};
  return {
    bucket: size.bucket ?? null,
    files: size.fileCount ?? null,
    changedLines: size.changedLines ?? null,
    deletedLines: size.deletedLines ?? null,
    measured: size.measured ?? null,
    pinned: Array.isArray(plan.pinned) ? plan.pinned.length : 0,
    rounds: plan.rounds ?? null,
    maxIterations: plan.maxIterations ?? null,
    // Agents per lane, 0 for a lane the plan ruled out. This is the row that
    // answers whether the split lane and the Pragmatist skip earn their keep.
    agents: Object.fromEntries(
      (plan.lanes ?? []).map((lane) => [lane.persona, lane.run ? (lane.agents ?? 1) : 0])),
  };
}

// The reviewer-hallucination gauge, per lane: a claim whose own file or line
// the checkout disproved. Only a briefing can answer it, and a run synthesized
// without one records null rather than 0 — "nobody checked" is not "nothing was
// wrong", which is the same distinction the roster keeps for a silent lane.
function triageSummary(briefing) {
  if (!briefing) return null;
  const findings = briefing.findings ?? [];
  const disproved = (f) => f.claimCheck?.status === 'DISPROVED'
    || f.counterpartCheck?.status === 'DISPROVED';
  return {
    findings: findings.length,
    disproved: findings.filter(disproved).length,
    underAnchored: findings.filter((f) => f.kindCheck?.status !== 'ok').length,
    outside: findings.filter((f) => f.claimCheck?.inDiff === 'outside').length,
    clusters: (briefing.clusters ?? []).length,
    crossReferences: (briefing.crossReferences ?? []).length,
    groupsProposed: (briefing.groups ?? []).length,
    settled: (briefing.settled ?? []).length,
    regressed: (briefing.regressed ?? []).length,
  };
}

function laneStatus(persona, { round1, degraded, skipped, planned }) {
  if (degraded.includes(persona)) return LANE_STATUS.degraded;
  if (skipped.includes(persona)) return LANE_STATUS.skipped;
  if (persona in round1) return LANE_STATUS.reported;
  if (planned.includes(persona)) return LANE_STATUS.silent;
  return null;
}

function laneRows({ round1, briefing, degraded, skipped, planned }) {
  const personas = [...new Set([...planned, ...Object.keys(round1), ...degraded, ...skipped])];
  const briefed = briefing?.findings ?? null;
  const rows = Object.create(null);
  for (const persona of personas.sort()) {
    const mine = briefed?.filter((f) => f.reporter === persona) ?? null;
    rows[persona] = {
      status: laneStatus(persona, { round1, degraded, skipped, planned }),
      // null, not 0: a lane that did not look found nothing in a different
      // sense than a lane that looked.
      reported: round1[persona] ? (round1[persona].findings ?? []).length : null,
      disproved: mine
        ? mine.filter((f) => f.claimCheck?.status === 'DISPROVED'
          || f.counterpartCheck?.status === 'DISPROVED').length
        : null,
      underAnchored: mine ? mine.filter((f) => f.kindCheck?.status !== 'ok').length : null,
    };
  }
  return rows;
}

// What round 2 actually produced. `added` is the channel the whole second round
// exists for — a finding round 1 missed — and it is the one number nobody has
// ever been able to quote.
function round2Summary(round2) {
  const payloads = Object.values(round2 ?? {});
  if (!payloads.length) return null;
  const total = (key) => payloads.reduce((n, p) => n + (p?.[key] ?? []).length, 0);
  return {
    personas: Object.keys(round2).length,
    validated: total('validate'),
    challenged: total('challenge'),
    added: total('added'),
  };
}

export function buildRunRecord({
  syn,
  round1 = {},
  round2 = {},
  briefing = null,
  plan = null,
  identity = {},
  base = null,
  iteration = null,
  at = new Date(),
} = {}) {
  const degraded = [...(syn.degraded ?? [])];
  const skipped = (syn.skipped ?? []).map((s) => s.persona);
  const planned = (plan?.lanes ?? []).filter((l) => l.run).map((l) => l.persona);
  const findings = syn.findings ?? [];

  return {
    schema: TELEMETRY_SCHEMA,
    at: at.toISOString(),
    repo: identity.repo ?? null,
    head: identity.head ?? null,
    base,
    iteration,
    plan: planSummary(plan),
    roster: {
      reported: Object.keys(round1).sort(),
      degraded: degraded.sort(),
      skipped: skipped.sort(),
      crossReviewed: Object.keys(round2).sort(),
      round2Skipped: (syn.round2Skipped ?? null) !== null,
    },
    lanes: laneRows({ round1, briefing, degraded, skipped, planned }),
    triage: triageSummary(briefing),
    findings: {
      total: findings.length,
      blocking: findings.filter(isBlocking).length,
      openBlocking: (syn.openBlocking ?? []).length,
      bySeverity: countBy(findings, (f) => f.severity ?? 'unknown'),
      byKind: countBy(findings, (f) => f.kind ?? 'unknown'),
      byConfidence: countBy(findings, (f) => f.confidence ?? 'unknown'),
      byProvenance: countBy(findings, (f) => f.provenance ?? 'unknown'),
    },
    // Which proposals round 2 collapsed into one disposition and which it
    // dissolved: the measure of whether deterministic grouping is proposing
    // anything a panel agrees with.
    rootCauses: {
      total: (syn.rootCauses ?? []).length,
      byStatus: countBy(syn.rootCauses ?? [], (rc) => rc.status ?? 'unknown'),
    },
    round2: round2Summary(round2),
    verdict: { label: syn.consensusLabel ?? null, score: syn.consensusScore ?? null },
  };
}

export function telemetryDisabled(env = process.env) {
  return !!env.ADVERSE_NO_TELEMETRY;
}

export function telemetryPath(env = process.env) {
  if (env.ADVERSE_TELEMETRY_FILE) return env.ADVERSE_TELEMETRY_FILE;
  const cache = env.XDG_CACHE_HOME || path.join(homedir(), '.cache');
  return path.join(cache, 'adverse', 'runs.jsonl');
}

// One line, one `write(2)` under O_APPEND, so two runs finishing together
// interleave whole records rather than halves of them.
//
// O_NOFOLLOW for the same reason bridge-io.mjs uses it: anything that can write
// in this directory can point the destination somewhere else, and appending
// attacker-chosen JSON to a file named by a symlink is a worse outcome than
// losing telemetry. A deliberate symlink is served by ADVERSE_TELEMETRY_FILE.
//
// Returns the failure rather than throwing it — the caller is finishing a
// review and must not be interrupted by bookkeeping.
export function appendRunRecord(record, file) {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(record)}\n`, {
      encoding: 'utf-8',
      flag: constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW,
    });
    return { ok: true, file };
  } catch (e) {
    return { ok: false, file, error: e.message };
  }
}
