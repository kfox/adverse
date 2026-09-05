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
//  - Only advisory lanes are skippable on size. Dropping a blocking-kind lane
//    leaves a kind unowned; dropping the Pragmatist on a small diff forgoes a
//    backlog item and nothing else, because `design` never blocks. The
//    Adversary's skip is not size-based at all — it is assessScope's
//    trust-boundary gate, unchanged.
//  - Round 2 is never skipped up front. Without it a solo finding can never
//    block, so a pre-flight skip would make small diffs structurally unable to
//    produce a blocking finding. It is skipped only after round 1, when it is
//    provably a no-op: nothing of a blocking kind was reported, so there is
//    nothing to validate or challenge.
//  - The iteration cap scales UP only. Lowering it can only manufacture false
//    exit-3 stops; raising it only costs model calls. Same one-directional
//    bias as assessScope, for the same reason.
//
// Size is a bad proxy for risk — a one-line change to credential handling is
// tiny and is exactly the diff that must not get the cheap pass — so `pins`
// (path substrings the consuming repo supplies) force the full shape
// regardless of size. This module is a budget policy, never a judgment: the
// orchestrator must still declare every skipped lane to the synthesizer.

import { ADVISORY_KINDS } from './prompts.mjs';
import { addedLines, assessScope } from './scope.mjs';

// small = a diff one reviewer reads comfortably; large = one that exhausts a
// reviewer's attention budget, the documented cause of deterministic lane
// failures. Checked large-first so a 2-file 700-line diff is large.
export const SMALL_MAX_FILES = 3;
export const SMALL_MAX_ADDED_LINES = 80;
export const LARGE_MIN_FILES = 15;
export const LARGE_MIN_ADDED_LINES = 600;

export const SPLIT_AGENTS = 2;
// The default must match convergenceStatus's own default in ledger.mjs, or the
// plan would claim a cap the loop does not enforce.
export const DEFAULT_MAX_ITERATIONS = 3;
export const ESCALATED_MAX_ITERATIONS = 5;

const PER_FILE_LANES = new Set(['auditor', 'adversary']);

export function diffSize({ files = [], diff = '' } = {}) {
  const fileCount = files.length;
  const added = addedLines(diff).length;

  let bucket = 'medium';
  if (fileCount >= LARGE_MIN_FILES || added >= LARGE_MIN_ADDED_LINES) bucket = 'large';
  else if (fileCount <= SMALL_MAX_FILES && added <= SMALL_MAX_ADDED_LINES) bucket = 'small';

  return { fileCount, addedLines: added, bucket };
}

function matchedPins(files, pins) {
  const hits = [];
  for (const pin of pins) {
    const file = files.find((f) => String(f).includes(pin));
    if (file !== undefined) hits.push({ pin, file });
  }
  return hits;
}

function agentsFor(persona, run, bucket) {
  if (!run) return 0;
  return bucket === 'large' && PER_FILE_LANES.has(persona) ? SPLIT_AGENTS : 1;
}

export function planReview({ files = [], diff = '', pins = [] } = {}) {
  const size = diffSize({ files, diff });
  const pinned = matchedPins(files, pins);
  const forced = pinned.length > 0;
  const reasons = [];

  // No file list means we were handed nothing to reason about, which is not
  // the same as having looked and found nothing — full treatment.
  const blind = files.length === 0;
  if (blind) reasons.push('no file list to assess; defaulting to the full shape');
  if (forced) {
    reasons.push(`pinned path present (${pinned.map((p) => `"${p.pin}" -> ${p.file}`).join(', ')}); size-based skips overridden`);
  }

  // assessScope already treats an empty file list as "run".
  const adversary = assessScope({ files, diff });
  const runAdversary = forced || adversary.recommend === 'run';
  const runPragmatist = forced || blind || size.bucket !== 'small';

  const lanes = [
    {
      persona: 'auditor',
      run: true,
      agents: agentsFor('auditor', true, size.bucket),
      reason: size.bucket === 'large'
        ? 'always runs; split across two agents because a large diff exhausts one reviewer\'s budget'
        : 'always runs — correctness has no skippable case',
    },
    {
      persona: 'adversary',
      run: runAdversary,
      agents: agentsFor('adversary', runAdversary, size.bucket),
      reason: forced && adversary.recommend !== 'run'
        ? 'pinned path forces the lane'
        : adversary.reason,
    },
    {
      persona: 'steward',
      run: true,
      agents: 1,
      reason: 'always runs, one agent — its unit of work is a claim, and partitioning files does not partition claims',
    },
    {
      persona: 'pragmatist',
      run: runPragmatist,
      agents: runPragmatist ? 1 : 0,
      reason: runPragmatist
        ? 'one agent — structure findings are cross-file, so partitioning harms them'
        : 'small diff; design findings are advisory and cannot change the gate, so this skip costs a backlog item at most',
    },
  ];

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
// A finding with a missing or unrecognized `kind` counts as blocking here for
// the same reason coerceKind sends it to UNCLASSIFIED in synthesis: a finding
// must not escape scrutiny by being mislabeled. The cap, by contrast, escalates
// only on a literal `critical` — escalation buys iterations, not safety, so
// there is no fail-closed case to serve by escalating on garbage.
export function escalate(round1) {
  const payloads = Array.isArray(round1) ? round1 : Object.values(round1 ?? {});
  const findings = payloads.flatMap((p) => (Array.isArray(p?.findings) ? p.findings : []));
  const blocking = findings.filter((f) => f && !ADVISORY_KINDS.has(f.kind));
  const criticals = blocking.filter((f) => f.severity === 'critical');

  const rounds = blocking.length === 0 ? 1 : 2;
  const maxIterations = criticals.length > 0 ? ESCALATED_MAX_ITERATIONS : DEFAULT_MAX_ITERATIONS;

  const reasons = [];
  reasons.push(rounds === 1
    ? `round 2 is provably a no-op: ${findings.length} finding(s), none of a blocking kind — nothing to validate or challenge`
    : `${blocking.length} blocking-kind finding(s) need cross-examination`);
  if (criticals.length > 0) {
    reasons.push(`${criticals.length} critical blocking-kind finding(s): cap raised to ${ESCALATED_MAX_ITERATIONS} — stopping on the cap with a critical open is the worst place to stop`);
  }

  return { rounds, maxIterations, blockingCount: blocking.length, criticalCount: criticals.length, reasons };
}
