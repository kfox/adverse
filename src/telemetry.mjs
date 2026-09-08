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
import { appendFileSync, constants, lstatSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { refuseDirectRun } from './entryGuard.mjs';
import { DEFAULT_PERSONAS, isLaneAgent } from './personas.mjs';
import { runLanes } from './scaling.mjs';
import { UNCLASSIFIED, isBlocking } from './synthesis.mjs';
import { KINDS, ROOT_CAUSE_STATUSES, SEVERITIES } from './taxonomy.mjs';

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

// Every key and every value in this record is a number, a timestamp, a sha, or
// a word this tool defined. Nothing else, because a payload writes most of what
// the record is built from and the file is documented as safe to paste into an
// issue about a threshold.
//
// `kind` is the one that proved it: src/synthesis.mjs's `coerceKind` accepts any
// non-empty string, so a 4 KB `kind` carrying paths and secrets reached the file
// verbatim as an object KEY. Two panel lanes found the same class from opposite
// ends — the other through a round-1 payload's persona keys. So the vocabularies
// are imported from the modules that own them and anything outside one is
// COUNTED, never quoted. src/synthesis.mjs bounds a payload-chosen key for the
// same reason (`nameKey`, after a 2.16 MB key reached a stderr message); here
// there is a fixed vocabulary to fall back on, which is better than a clip.
const OFF_VOCABULARY = 'other';
const KNOWN_KINDS = new Set([...KINDS, UNCLASSIFIED]);
const KNOWN_SEVERITIES = new Set(SEVERITIES);
const KNOWN_STATUSES = new Set(ROOT_CAUSE_STATUSES);

const oneOf = (allowed) => (value) => (allowed.has(value) ? value : OFF_VOCABULARY);

// Which LANE a name belongs to — `auditor` and `auditor-a` are both the
// auditor's — or null for a string that is not a persona at all. Asked through
// src/personas.mjs's own predicate rather than by re-deriving the split-lane
// spelling here, which is exactly the duplication that has drifted before.
export function laneOf(name) {
  return DEFAULT_PERSONAS.find((persona) => isLaneAgent(persona, name)) ?? null;
}

// A base is recorded only as a commit sha. `--briefing` carries whatever
// `triage.mjs --base` was given, and that can be a branch name — which is free
// text somebody chose, and the one field here that was copied through rather
// than counted.
const SHA = /^[0-9a-f]{7,64}$/;

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
  // somebody's directory layout rather than a project name. `file://` is that
  // same path wearing a scheme, and without this it took the local branch's
  // exception and published the parent directory as an owner.
  const local = trimmed.replace(/^file:\/\//, '');
  if (local.startsWith('/') || local.startsWith('.')) return path.basename(local);
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
    // How much review the user asked for, which is the confounder for the
    // question the `agents` row below exists to answer: a Pragmatist skip on a
    // `cheap` run and one on a `standard` run are different data points, and
    // without this field they aggregate as the same one. Safe for a file that
    // records no reasons and no paths — it is one of three literals, validated
    // by `parsePlan` before it ever reaches here.
    depth: plan.depth ?? null,
    // Agents per lane, 0 for a lane the plan ruled out. This is the row that
    // answers whether the split lane and the Pragmatist skip earn their keep.
    agents: Object.fromEntries((plan.lanes ?? [])
      .filter((lane) => laneOf(lane.persona))
      .map((lane) => [laneOf(lane.persona), lane.run ? (lane.agents ?? 1) : 0])),
  };
}

// What the run's reproductions cost and bought, in counts. The question this
// row exists to answer is whether the probe channel earns its wall-clock: how
// often a panel attaches one at all, how often re-running it confirms what the
// reporter said, and how often it contradicts them. If `confirmed` stays near
// zero across a hundred runs the channel is theater; if `contradicted` is high
// the reviewers are overstating and the cap should tighten.
//
// Counts only, like everything else in this file — no script paths, no probe
// output, no `why` strings. `enabled` is the operator's own flag and is the
// denominator every other number here needs: zero probes on a run that never
// enabled them is not the same data point as zero on a run that did.
function probeSummary(probes) {
  if (!probes) return null;
  const list = probes.probes ?? [];
  const measured = list.filter((p) => p.source === 'measured');
  return {
    enabled: probes.enabled === true,
    attached: list.length,
    ran: measured.length,
    confirmed: measured.filter((p) => p.confirmed).length,
    contradicted: measured.filter((p) => !p.confirmed).length,
    sandboxed: Boolean(probes.isolation?.sandbox),
  };
}

// A claim the checkout contradicted: the reviewer-hallucination gauge, and the
// one predicate both summaries below count with. It was spelled twice here
// before, which is one copy short of the number it takes to drift.
const isDisproved = (f) => f.claimCheck?.status === 'DISPROVED'
  || f.counterpartCheck?.status === 'DISPROVED';

const isUnderAnchored = (f) => f.kindCheck?.status !== 'ok';

// Per run rather than per lane. Only a briefing can answer any of it, and a run
// synthesized without one records null rather than 0 — "nobody checked" is not
// "nothing was wrong", which is the same distinction the roster keeps for a
// silent lane.
function triageSummary(briefing) {
  if (!briefing) return null;
  const findings = briefing.findings ?? [];
  return {
    findings: findings.length,
    disproved: findings.filter(isDisproved).length,
    underAnchored: findings.filter(isUnderAnchored).length,
    outside: findings.filter((f) => f.claimCheck?.inDiff === 'outside').length,
    clusters: (briefing.clusters ?? []).length,
    crossReferences: (briefing.crossReferences ?? []).length,
    groupsProposed: (briefing.groups ?? []).length,
    settled: (briefing.settled ?? []).length,
    regressed: (briefing.regressed ?? []).length,
  };
}

function laneStatus(lane, { reporting, degraded, skipped, planned }) {
  if (degraded.includes(lane)) return LANE_STATUS.degraded;
  if (skipped.includes(lane)) return LANE_STATUS.skipped;
  if (reporting.includes(lane)) return LANE_STATUS.reported;
  if (planned.includes(lane)) return LANE_STATUS.silent;
  return null;
}

// One row per LANE, never per payload: a split lane handed to synthesize as two
// raw payloads is one lane that was reviewed in halves, and two rows would read
// as two reviewers.
function laneRows({ round1, briefing, degraded, skipped, planned }) {
  const payloads = Object.entries(round1)
    .map(([name, payload]) => [laneOf(name), payload])
    .filter(([lane]) => lane);
  const reporting = payloads.map(([lane]) => lane);
  const briefed = briefing?.findings ?? null;
  const rows = Object.create(null);

  for (const lane of [...new Set([...planned, ...reporting, ...degraded, ...skipped])].sort()) {
    const status = laneStatus(lane, { reporting, degraded, skipped, planned });
    // ONE predicate for all three counts. `null` unless this lane actually
    // looked — and every count also needs a briefing to have been read, since
    // nobody checked the claims otherwise.
    //
    // Written as three separate ternaries first, and two of them were wrong:
    // `mine ? … : null` tested an ARRAY, which `filter` makes truthy when it is
    // empty, so a degraded lane's claim checks came out 0 — "we checked and it
    // was clean" — in any run that had a briefing. A `--degraded auditor`
    // whose payload was still on disk reported its findings as a review, too.
    // Both are the exact collapse the rest of this file argues against.
    const looked = status === LANE_STATUS.reported;
    const mine = looked && briefed
      ? briefed.filter((f) => laneOf(f.reporter) === lane)
      : null;
    rows[lane] = {
      status,
      reported: looked
        ? payloads.filter(([reporter]) => reporter === lane)
          .reduce((n, [, payload]) => n + (payload?.findings ?? []).length, 0)
        : null,
      disproved: mine ? mine.filter(isDisproved).length : null,
      underAnchored: mine ? mine.filter(isUnderAnchored).length : null,
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
  probes = null,
  identity = {},
  base = null,
  iteration = null,
  at = new Date(),
} = {}) {
  // Lane names throughout, so a declaration naming a split lane's half
  // (`--degraded auditor-b`) is the same lane the payloads and the plan name.
  const named = (names) => [...new Set(names.map(laneOf).filter(Boolean))];
  const degraded = named(syn.degraded ?? []);
  const skipped = named((syn.skipped ?? []).map((s) => s.persona));
  // `runLanes`, not a second `filter((l) => l.run)`: which lanes a plan RAN is
  // src/scaling.mjs's question and it already answers it for four other callers.
  const planned = named(runLanes(plan?.lanes ?? []).map((l) => l.persona));
  const findings = syn.findings ?? [];
  // Names that are not personas at all, counted rather than recorded: the
  // round-1 keys come from a file, and one of them was `SENTINEL-LEAK-9f2a1`
  // when the panel went looking.
  const unknown = [...Object.keys(round1), ...Object.keys(round2)]
    .filter((name) => !laneOf(name)).length;

  return {
    schema: TELEMETRY_SCHEMA,
    at: at.toISOString(),
    repo: identity.repo ?? null,
    head: identity.head ?? null,
    base: SHA.test(base ?? '') ? base : null,
    iteration,
    plan: planSummary(plan),
    probes: probeSummary(probes),
    roster: {
      reported: named(Object.keys(round1)).sort(),
      degraded: degraded.sort(),
      skipped: skipped.sort(),
      crossReviewed: named(Object.keys(round2)).sort(),
      round2Skipped: (syn.round2Skipped ?? null) !== null,
      unknown,
    },
    lanes: laneRows({ round1, briefing, degraded, skipped, planned }),
    triage: triageSummary(briefing),
    findings: {
      total: findings.length,
      blocking: findings.filter(isBlocking).length,
      openBlocking: (syn.openBlocking ?? []).length,
      bySeverity: countBy(findings, (f) => oneOf(KNOWN_SEVERITIES)(f.severity)),
      byKind: countBy(findings, (f) => oneOf(KNOWN_KINDS)(f.kind)),
      byConfidence: countBy(findings, (f) => f.confidence ?? OFF_VOCABULARY),
      byProvenance: countBy(findings, (f) => f.provenance ?? OFF_VOCABULARY),
    },
    // Which proposals round 2 collapsed into one disposition and which it
    // dissolved: the measure of whether deterministic grouping is proposing
    // anything a panel agrees with.
    rootCauses: {
      total: (syn.rootCauses ?? []).length,
      byStatus: countBy(syn.rootCauses ?? [], (rc) => oneOf(KNOWN_STATUSES)(rc.status)),
    },
    round2: round2Summary(round2),
    verdict: { label: syn.consensusLabel ?? null, score: syn.consensusScore ?? null },
  };
}

function isSymlink(target) {
  try {
    return lstatSync(target).isSymbolicLink();
  } catch {
    return false;   // it does not exist yet, which mkdir is about to fix
  }
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
    // O_NOFOLLOW below protects the destination FILE. `mkdirSync` reaches it
    // through a directory, and mkdir's own existence check follows a symlink —
    // so `~/.cache/adverse` pointed elsewhere sent the whole write into
    // somebody else's directory with no error, which the panel reproduced. The
    // one component this function creates and writes into is checked; an
    // ancestor the user symlinked themselves is theirs to symlink, and
    // ADVERSE_TELEMETRY_FILE is the supported way to put the file anywhere
    // else on purpose.
    const dir = path.dirname(file);
    if (isSymlink(dir)) {
      return { ok: false, file, error: `${dir} is a symlink, not a directory` };
    }
    mkdirSync(dir, { recursive: true });
    appendFileSync(file, `${JSON.stringify(record)}\n`, {
      encoding: 'utf-8',
      flag: constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW,
    });
    return { ok: true, file };
  } catch (e) {
    return { ok: false, file, error: e.message };
  }
}
