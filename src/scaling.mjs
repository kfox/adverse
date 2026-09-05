// How much review does this change deserve?
//
// One shape for every diff over-reviews the small ones and under-reviews the
// large ones, but most of the obvious dials here are traps, so this module is
// mostly the record of which ones are safe to turn (kfox/adverse#12):
//
//  - Lanes cannot be merged into one agent. Blocking requires `cross-validated`
//    or `consensus` (isOpenBlocking in synthesis.mjs), both of which count
//    DISTINCT personas — one agent wearing four hats reports only `solo`
//    findings, which structurally cannot block, or counterfeits consensus by
//    reporting one finding under two names.
//  - A lane CAN be split across two agents. synthesize() dedupes `reporters`
//    by persona name, so two Auditors union their findings without inflating
//    confidence. Only per-file work splits usefully: the Auditor and the
//    Adversary read file by file; the Steward's unit is a claim and the
//    Pragmatist's is the whole shape, so partitioning their files does not
//    partition their work.
//  - Only a lane whose every kind is advisory is skippable on size. The
//    predicate is computed from the persona registry, not from a name, so
//    re-aiming a persona at a blocking kind revokes its skip automatically.
//    Skipping such a lane costs a backlog item and one potential second
//    round-1 reporter (a duplicate report is what promotes a solo finding to
//    cross-validated) — never a finding that could block on its own, and not
//    a round-2 validator: this lane never cross-reviews. The
//    Adversary's skip is not size-based at all — it is assessScope's
//    trust-boundary gate, unchanged.
//  - Round 2 is never skipped up front. Without it a solo finding can never
//    block, so a pre-flight skip would make small diffs structurally unable to
//    produce a blocking finding. After round 1 it is skipped only when no
//    finding blocks under the synthesizer's own `isBlocking` — and even then
//    the skip forgoes round 2's additive channel (findings a reviewer only
//    sees with the other lanes in view), so it must be declared to the
//    synthesizer (`--round2-skipped`), never taken silently.
//  - The iteration cap scales UP only. Lowering it can only manufacture false
//    exit-3 stops; raising it only costs model calls. Same one-directional
//    bias as assessScope, for the same reason.
//
// Size is measured from `git diff --numstat`, never from the diff text: diff
// text is written by the author of the change, and `.gitattributes -diff`, a
// binary blob, or a pure deletion can hide any amount of content from it —
// every measurement error a diff-text metric admits shrinks the bucket, and
// shrinking is the direction that buys a hostile change the cheapest review.
// A numstat row git reports as `-\t-\t<path>` is content nobody measured or
// signal-scanned: it sizes the diff LARGE (out of small was not enough — a
// hidden 2,000-line file still shrank large to medium and halved the split
// lanes' budget) and forces the Adversary lane.
//
// Size is still a bad proxy for risk — a one-line change to credential
// handling is tiny and is exactly the diff that must not get the cheap pass —
// so `pins` (path substrings the consuming repo supplies, matched
// case-insensitively) force the full shape regardless of size. This module is
// a budget policy, never a judgment: the orchestrator must still declare
// every skipped lane to the synthesizer. The policy is consumed by the Skill
// flow only; the standalone CLI's `--personas` flag remains an explicit,
// unscaled choice (see kfox/adverse#12).

import { DEFAULT_PERSONAS, PERSONAS } from './personas.mjs';
import { ADVISORY_KINDS } from './prompts.mjs';
import { assessScope } from './scope.mjs';
import { isBlocking } from './synthesis.mjs';

// small = a diff one reviewer reads comfortably; large = one that exhausts a
// reviewer's attention budget, the documented cause of deterministic lane
// failures. Checked large-first so a 2-file 700-line diff is large.
export const SMALL_MAX_FILES = 3;
export const SMALL_MAX_CHANGED_LINES = 80;
export const LARGE_MIN_FILES = 15;
export const LARGE_MIN_CHANGED_LINES = 600;

// assessScope scans removed lines, but its signal lists are static and no
// list survives a determined author — so past this many deleted lines the
// Adversary runs regardless of what the signals say.
export const DELETED_LINES_ADVERSARY_FLOOR = 80;

export const SPLIT_AGENTS = 2;
// The default must match convergenceStatus's own default in ledger.mjs, or the
// plan would claim a cap the loop does not enforce.
export const DEFAULT_MAX_ITERATIONS = 3;
export const ESCALATED_MAX_ITERATIONS = 5;

const PER_FILE_LANES = new Set(['auditor', 'adversary']);
const GATED_LANES = new Set(['adversary']);

// A lane is size-skippable only when nothing it reports can block. Computed
// from the registry so the invariant survives a persona being re-aimed.
function sizeSkippable(name) {
  return PERSONAS[name].kinds.every((kind) => ADVISORY_KINDS.has(kind));
}

// Parse `git diff --numstat` output. A `-` in either column is a file git
// could not (or was told not to) line-count — binary, or diff-suppressed.
export function parseNumstat(text) {
  let changed = 0;
  let deleted = 0;
  const unscannable = [];
  for (const line of String(text ?? '').split('\n')) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (!m) continue;
    if (m[1] === '-' || m[2] === '-') {
      unscannable.push(m[3]);
      continue;
    }
    changed += Number(m[1]) + Number(m[2]);
    deleted += Number(m[2]);
  }
  return { changed, deleted, unscannable };
}

// `numstat` is raw `git diff --numstat` text. Without it the size was never
// measured, and unmeasured must not qualify for the cheap bucket — the same
// rule that keeps an unscannable file out of `small`. `numstatMatchesFiles:
// false` says the numstat measures a different change set than `files` (a
// caller-supplied list): its counts can still FORCE (large, deletions,
// unscannable rows — all of which only add review), but they can never
// qualify the list as small, because an empty measurement of the wrong range
// reads as small for arbitrarily large files.
export function diffSize({ files = [], numstat = null, numstatMatchesFiles = true } = {}) {
  const fileCount = files.length;
  const readable = numstat !== null && numstat !== undefined;
  const measured = readable && numstatMatchesFiles;
  const { changed, deleted, unscannable } = parseNumstat(readable ? numstat : '');

  let bucket = 'medium';
  if (fileCount >= LARGE_MIN_FILES || changed >= LARGE_MIN_CHANGED_LINES
      || unscannable.length > 0) {
    // Unmeasurable content could be any size, and the attacker picks which —
    // so it takes the bucket where the reviewer budget is largest, never a
    // smaller one.
    bucket = 'large';
  } else if (measured
           && fileCount <= SMALL_MAX_FILES && changed <= SMALL_MAX_CHANGED_LINES) {
    bucket = 'small';
  }

  return { fileCount, changedLines: changed, deletedLines: deleted, bucket, measured, unscannable };
}

function matchedPins(files, pins) {
  const hits = [];
  for (const pin of pins) {
    const needle = String(pin).toLowerCase();
    const file = files.find((f) => String(f).toLowerCase().includes(needle));
    if (file !== undefined) hits.push({ pin, file });
  }
  return hits;
}

// A lane is never split more ways than it has files to partition: a one-file
// large diff (a single binary asset, one huge module) split in two hands one
// agent nothing, and combine.mjs then refuses the lane for having only one
// real payload.
function agentsFor(persona, run, bucket, fileCount) {
  if (!run) return 0;
  return bucket === 'large' && PER_FILE_LANES.has(persona) && fileCount >= SPLIT_AGENTS
    ? SPLIT_AGENTS : 1;
}

// `diff: null` means the diff could not be read — distinct from '', an empty
// diff — and an unread diff forces the Adversary: assessScope saw nothing, so
// "no trust-boundary signal" would be an assertion of absence about lines
// nobody scanned.
export function planReview({ files = [], diff = '', numstat = null, numstatMatchesFiles = true, pins = [] } = {}) {
  const size = diffSize({ files, numstat, numstatMatchesFiles });
  const pinned = matchedPins(files, pins);
  const forced = pinned.length > 0;
  const reasons = [];

  // No file list means we were handed nothing to reason about, which is not
  // the same as having looked and found nothing — full treatment.
  const blind = files.length === 0;
  if (blind) reasons.push('no file list to assess; defaulting to the full shape');
  if (!size.measured && !blind) {
    reasons.push(numstat === null || numstat === undefined
      ? 'size not measured (no numstat); the small bucket is unreachable'
      : 'size not measured (the numstat measures a different range than the supplied file list); '
        + 'the small bucket is unreachable, but the measurement\'s forcing signals still apply');
  }
  if (size.unscannable.length) {
    reasons.push(`${size.unscannable.length} file(s) unmeasurable (binary or diff-suppressed); `
      + 'unmeasured content could be any size, so the diff is sized large and the Adversary runs');
  }
  if (forced) {
    reasons.push(`pinned path present (${pinned.map((p) => `"${p.pin}" -> ${p.file}`).join(', ')}); size-based skips overridden`);
  }

  // assessScope already treats an empty file list as "run". Its signals scan
  // added AND removed lines, so what remains unscanned is content it never
  // saw at all — suppressed/binary files, or a bulk deletion whose guard
  // removal matches no pattern — and that must force the lane rather than
  // count as evidence of absence.
  const diffUnread = diff === null;
  const adversary = assessScope({ files, diff: diffUnread ? '' : diff });
  const adversaryForced = forced
    || diffUnread
    || size.unscannable.length > 0
    || size.deletedLines >= DELETED_LINES_ADVERSARY_FLOOR;
  const adversaryForcedReason = forced ? 'pinned path forces the lane'
    : diffUnread ? 'the diff could not be read; content signals saw nothing, which is not evidence of absence'
    : size.unscannable.length > 0 ? 'unmeasurable file content cannot prove the absence of a boundary'
    : `${size.deletedLines} deleted lines; a bulk deletion can remove a guard without matching any signal`;

  const lanes = DEFAULT_PERSONAS.map((persona) => {
    if (GATED_LANES.has(persona)) {
      const run = adversaryForced || adversary.recommend === 'run';
      return {
        persona,
        run,
        agents: agentsFor(persona, run, size.bucket, size.fileCount),
        reason: adversaryForced && adversary.recommend !== 'run'
          ? adversaryForcedReason
          : adversary.reason,
      };
    }
    if (sizeSkippable(persona)) {
      const run = forced || blind || size.bucket !== 'small';
      return {
        persona,
        run,
        agents: agentsFor(persona, run, size.bucket, size.fileCount),
        reason: run
          ? 'one agent — structure findings are cross-file, so partitioning harms them'
          : 'small diff; every kind this lane reports is advisory, so the skip costs a backlog item '
            + 'and a potential second reporter, never a finding that could block on its own',
      };
    }
    // The reason branches on the COMPUTED agent count, not on the bucket, so
    // the prose can never contradict the `agents` field: a one-file large
    // diff caps the split at one agent, and a reason still claiming two
    // invites the orchestrator to partition a file list that cannot be.
    const agents = agentsFor(persona, true, size.bucket, size.fileCount);
    return {
      persona,
      run: true,
      agents,
      reason: agents === SPLIT_AGENTS
        ? 'always runs; split across two agents because a large diff exhausts one reviewer\'s budget'
        : persona === 'steward'
          ? 'always runs, one agent — its unit of work is a claim, and partitioning files does not partition claims'
          : size.bucket === 'large' && PER_FILE_LANES.has(persona)
            ? 'always runs; one agent — a single changed file cannot be partitioned'
            : 'always runs — correctness has no skippable case',
    };
  });

  return {
    size,
    pinned,
    lanes,
    rounds: 2,
    maxIterations: DEFAULT_MAX_ITERATIONS,
    reasons,
  };
}

// Re-plan after round 1, the earliest moment finding criticality is knowable.
// Accepts the keyed-by-persona object combine.mjs produces or an array of
// per-persona payloads ({persona, findings}).
//
// Fail closed, in both directions the panel found open. `expected` is the
// roster of lanes the plan ran: a lane whose payload is missing or off-shape
// is a lane nobody heard from, which is not a lane that found nothing — so
// any problem keeps round 2. The blocking predicate is the synthesizer's own
// `isBlocking` (an info-severity finding does not block, a missing or
// unrecognized kind does), so this decision and the report it feeds cannot
// disagree. The cap, by contrast, escalates only on a literal `critical` —
// escalation buys iterations, not safety, so there is no fail-closed case to
// serve by escalating on garbage.
export function escalate(round1, { expected = [] } = {}) {
  const raw = Array.isArray(round1) ? round1 : Object.values(round1 ?? {});
  const problems = [];

  const payloads = [];
  for (const p of raw) {
    if (p && typeof p === 'object' && !Array.isArray(p)
        && typeof p.persona === 'string' && Array.isArray(p.findings)) {
      payloads.push(p);
    } else {
      problems.push('an input is not a per-persona payload ({persona, findings: []})');
    }
  }
  const heard = new Set(payloads.map((p) => p.persona));
  for (const persona of expected) {
    if (!heard.has(persona)) problems.push(`expected lane "${persona}" has no readable round-1 payload`);
  }

  const findings = payloads.flatMap((p) => p.findings.filter((f) => f && typeof f === 'object'));
  const blocking = findings.filter(isBlocking);
  const criticals = blocking.filter((f) => f.severity === 'critical');

  const rounds = problems.length === 0 && blocking.length === 0 ? 1 : 2;
  const maxIterations = criticals.length > 0 ? ESCALATED_MAX_ITERATIONS : DEFAULT_MAX_ITERATIONS;

  const roundsReason = rounds === 1
    ? `no blocking finding in round 1 (${findings.length} finding(s), all advisory or info). `
      + 'Skipping round 2 forgoes its additive channel — declare it with --round2-skipped, never silently'
    : problems.length > 0
      ? `fail closed — ${problems.join('; ')}`
      : `${blocking.length} blocking finding(s) need cross-examination`;
  const capReason = criticals.length > 0
    ? `${criticals.length} critical blocking finding(s): cap raised to ${ESCALATED_MAX_ITERATIONS} — `
      + 'stopping on the cap with a critical open is the worst place to stop'
    : null;

  return {
    rounds,
    maxIterations,
    roundsReason,
    capReason,
    problems,
    blockingCount: blocking.length,
    criticalCount: criticals.length,
  };
}
