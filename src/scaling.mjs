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
//  - `depth` is the one input that comes from the USER rather than the diff,
//    and it is deliberately the weakest dial here. It may add lanes and it may
//    drop a lane whose every kind is advisory one bucket earlier; it may not
//    touch `rounds` or `maxIterations`, because both of those reductions are
//    already ruled out above on grounds that an appetite for speed does not
//    answer. What it mostly buys is that the answer is a FIELD: recorded in
//    plan.json, read back by the report, and therefore legible a month later
//    when the only question is whether an absent finding means the panel
//    looked (kfox/adverse#77).
//  - Probes are a policy this module states and never a capability it grants.
//    A reproduction runs code from the diff under review, so turning them ON
//    takes two independent yeses: this plan saying the run is one where they
//    are worth their wall-clock, and Phase 0's operator passing
//    `--allow-execute` after confirming a worktree can actually run things.
//    The dial here is on/off by depth and nothing more — the per-lane cap does
//    NOT scale with depth, because it is a bound on reviewer ATTENTION rather
//    than on run cost, and a lane that spends a deeper pass writing more shell
//    scripts has read less of the diff, not more.
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

import { refuseDirectRun } from './entryGuard.mjs';
import { DEFAULT_PERSONAS, PERSONAS, advisoryOnlyLane } from './personas.mjs';
import { MAX_PROBES_PER_LANE } from './probe.mjs';
import { assessScope } from './scope.mjs';
import { isBlocking } from './synthesis.mjs';

refuseDirectRun(import.meta.url);

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

// The a-z suffix in `agentNames` is the real ceiling on how many ways a lane
// can split, so it is named rather than left implicit in a charCode sum.
export const MAX_SPLIT_AGENTS = 26;
// The default must match convergenceStatus's own default in ledger.mjs, or the
// plan would claim a cap the loop does not enforce.
export const DEFAULT_MAX_ITERATIONS = 3;
export const ESCALATED_MAX_ITERATIONS = 5;

// How much review the user ASKED for, as opposed to how much the diff earns.
// `standard` is a real name rather than the word "default" so the field reads
// the same whether it was chosen or defaulted — a report saying `depth:
// default` cannot be told from one whose depth was never recorded.
export const DEPTHS = Object.freeze(['cheap', 'standard', 'thorough']);
export const DEFAULT_DEPTH = 'standard';

// The buckets a lane whose every kind is advisory may skip. This is the whole
// of `cheap`'s lane reduction, and it is bounded on purpose: the skip costs a
// backlog item and one potential second reporter, never a finding that could
// block on its own, so it is the only economy available that cannot cost the
// run a verdict.
const ADVISORY_SKIP_BUCKETS = Object.freeze({
  cheap:    new Set(['small', 'medium']),
  standard: new Set(['small']),
  thorough: new Set(),
});

// `undefined` is the legitimate absent case — planReview called without the
// option, or a plan.json written before this field existed — and reads as the
// default. Anything else present is a depth someone wrote down wrong, and
// defaulting it would plan and then RENDER a run at a depth nobody chose,
// which is the silence this field exists to remove. Same `=== undefined` split
// as `agents` in parseLane below, for the same reason.
export function parseDepth(depth) {
  if (depth === undefined) return DEFAULT_DEPTH;
  if (typeof depth !== 'string' || !DEPTHS.includes(depth)) {
    throw new Error(`unknown depth ${JSON.stringify(depth)}`
      + ` (expected one of ${DEPTHS.join(', ')})`);
  }
  return depth;
}

const PER_FILE_LANES = new Set(['auditor', 'adversary']);
const GATED_LANES = new Set(['adversary']);

// A lane is size-skippable only when nothing it reports can block — which is
// `advisoryOnlyLane`'s question, not a second one, so it is that function's
// answer rather than a third copy of its body. The copy this replaced had
// already drifted from it: written inline as `kinds.every(...)` with no
// `kinds.length` guard, it answered TRUE for a persona registered with
// `kinds: []`, where `advisoryOnlyLane` deliberately answers false. `[].every`
// is vacuously true, and `coerceKind` treats an unclassified kind as blocking,
// so a lane whose findings CAN block would have been dropped from the plan
// entirely on a small diff.
//
// `personas` is injectable for the reason `advisoryOnlyLane`'s own comment
// gives: the Pragmatist is the only advisory-only lane in the real registry, so
// a test over that registry agrees with a hard-coded `persona !== 'pragmatist'`
// and cannot tell the two implementations apart. `planReview` passes nothing
// and reads `DEFAULT_PERSONAS`, so the divergence was unreachable through the
// public API and is pinned here instead.
export function sizeSkippable(name, { personas = PERSONAS } = {}) {
  return advisoryOnlyLane(name, { personas });
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
export function planReview({ files = [], diff = '', numstat = null,
  numstatMatchesFiles = true, pins = [], depth: requestedDepth } = {}) {
  const depth = parseDepth(requestedDepth);
  const size = diffSize({ files, numstat, numstatMatchesFiles });
  const pinned = matchedPins(files, pins);
  const forced = pinned.length > 0;
  // Pins and a thorough pass force the same thing for different reasons, and
  // the reason is what the operator reads — so they are two names, not one.
  const forceAllLanes = forced || depth === 'thorough';
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
  if (depth === 'thorough') {
    reasons.push('depth thorough; every lane runs whatever the size and the trust-boundary gate say');
  }
  // Said out loud, and said here, because the two economies a hurried operator
  // reaches for first are the two this plan refuses to make. Left unsaid, the
  // refusal reads as an oversight and gets "fixed" by hand at Phase 4.
  if (depth === 'cheap') {
    reasons.push('depth cheap; a lane whose every kind is advisory also skips a medium diff. '
      + 'Rounds and the iteration cap are unchanged: skipping round 2 up front would leave this diff '
      + 'structurally unable to produce a blocking finding, and lowering the cap can only manufacture '
      + 'false stops. Round 2 is still dropped after round 1 when nothing blocks (escalate)');
  }

  // assessScope already treats an empty file list as "run". Its signals scan
  // added AND removed lines, so what remains unscanned is content it never
  // saw at all — suppressed/binary files, or a bulk deletion whose guard
  // removal matches no pattern — and that must force the lane rather than
  // count as evidence of absence.
  const diffUnread = diff === null;
  const adversary = assessScope({ files, diff: diffUnread ? '' : diff });
  const adversaryForced = forceAllLanes
    || diffUnread
    || size.unscannable.length > 0
    || size.deletedLines >= DELETED_LINES_ADVERSARY_FLOOR;
  const adversaryForcedReason = forced ? 'pinned path forces the lane'
    : depth === 'thorough' ? 'a thorough pass runs every lane'
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
      const run = forceAllLanes || blind || !ADVISORY_SKIP_BUCKETS[depth].has(size.bucket);
      return {
        persona,
        run,
        agents: agentsFor(persona, run, size.bucket, size.fileCount),
        reason: run
          ? `one agent — ${PERSONAS[persona].soloReason}`
          : `${size.bucket} diff at depth ${depth}; every kind this lane reports is advisory, so the `
            + 'skip costs a backlog item and a potential second reporter, never a finding that could '
            + 'block on its own',
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
        : PERSONAS[persona].soloReason
          ? `always runs, one agent — ${PERSONAS[persona].soloReason}`
          : size.bucket === 'large' && PER_FILE_LANES.has(persona)
            ? 'always runs; one agent — a single changed file cannot be partitioned'
            : 'always runs — correctness has no skippable case',
    };
  });

  return {
    size,
    depth,
    // The third place depth used to be applied from memory. Three-state on
    // purpose: `null` is "depth makes no claim here", which leaves the
    // orchestrator's own judgment exactly where it already is, and is not the
    // same answer as `false`. Named as an escalation decision rather than a
    // model, because no model name belongs in a module that plans reviews for
    // whatever agent is running one.
    tier: depth === 'thorough'
      ? { escalate: true, reason: 'a thorough pass; the panel is the point of the run' }
      : depth === 'cheap'
        ? { escalate: false, reason: 'a cheap pass; the default tier stands' }
        : { escalate: null, reason: 'depth makes no tier claim; judge it from the diff' },
    // Whether the panel may attach reproductions, and how many per lane. Never
    // a requirement: a lane that attaches none is not degraded and a finding
    // without one is judged exactly as it always was (src/probe.mjs). The
    // `cheap` refusal is the only depth interaction, and it is the honest one —
    // a probe is wall-clock, and wall-clock is the thing a cheap pass was
    // chosen to spend less of.
    probes: depth === 'cheap'
      ? { allowed: false, perLane: 0,
          reason: 'a cheap pass; a reproduction costs wall-clock this depth was chosen to save' }
      : { allowed: true, perLane: MAX_PROBES_PER_LANE,
          reason: `each lane may attach up to ${MAX_PROBES_PER_LANE} reproduction(s);`
            + ' whether any of them RUN is Phase 0\'s call, not this plan\'s' },
    pinned,
    lanes,
    rounds: 2,
    maxIterations: DEFAULT_MAX_ITERATIONS,
    reasons,
  };
}

// --- Reading a plan back -----------------------------------------------------
//
// `planReview` above writes plan.json; four readers each grew their own idea of
// what one is, and each checked a different half. bridge-io's `readPlanLanes`
// validated the lane SHAPE and not the persona registry; plan.mjs's
// `readPlanFile` validated the REGISTRY and not the shape; only the `--agents`
// projection ever validated an `agents` count, so every other reader's
// `agents > 1` test read whatever the field happened to hold. One reader, in
// the module that writes the file it parses.
//
// Throws rather than exiting: `src/` describes a review, the bridges own the
// process. Same split as `loadLedger`.

// `agents` is OPTIONAL, and its default follows `run` — `agentsFor` above
// records 0 for a lane that does not run, so 0 is a legitimate count and not a
// malformed one. A hand-written plan naming only the lane it cares about is
// legitimate too (combine.mjs's `--plan` contract rests on it), so absence is
// never an error. Present-but-malformed is: `Array.from({ length: undefined })`
// silently yields an EMPTY array, so a bad count drops a lane's worktrees
// instead of failing, and `undefined > 1` quietly un-splits a split lane.
function parseLane(lane, personas) {
  if (!lane || typeof lane !== 'object' || Array.isArray(lane)) {
    throw new Error(`a lane is not an object: ${JSON.stringify(lane)}`);
  }
  if (!personas.includes(lane.persona)) {
    throw new Error(`lane persona ${JSON.stringify(lane.persona)} is not a persona`
      + ` (expected one of ${personas.join(', ')})`);
  }
  // A boolean, and required. plan.mjs's `--agents` projection used to filter
  // on a TRUTHY `run` while bridge-io tested `=== true`, so a lane recorded
  // `run: 1` got a worktree from one reader and was refused as "not run" by
  // the next. Unifying on `=== true` alone would have made that lane silently
  // vanish from the agent list — a lane nobody notices is missing is the
  // failure this whole module is written against, so it is an error instead.
  if (typeof lane.run !== 'boolean') {
    throw new Error(`lane '${lane.persona}' must say whether it ran`
      + ` (\`run\` is ${JSON.stringify(lane.run)}, expected true or false)`);
  }
  const run = lane.run;
  // `=== undefined`, not `??`: a key absent from the JSON parses as undefined
  // and is the legitimate hand-written case, while an explicit `null` is a
  // count someone wrote down wrong. `??` collapses the two and defaults the
  // malformed one to a working value.
  const agents = lane.agents === undefined ? (run ? 1 : 0) : lane.agents;
  const floor = run ? 1 : 0;
  // `agentNames` suffixes agents a, b, c … off `String.fromCharCode(97 + i)`,
  // which runs past 'z' into '{' and '|'. SKILL.md Phase 1 word-splits that
  // list into `git worktree add "$WORKTREES/$agent"`, so the ceiling is where
  // the naming scheme stops being one, not where it stops being tidy.
  if (Number.isInteger(agents) && agents > MAX_SPLIT_AGENTS) {
    throw new Error(`lane '${lane.persona}' asks for ${agents} agents;`
      + ` the a-z suffix scheme tops out at ${MAX_SPLIT_AGENTS}`);
  }
  if (!Number.isInteger(agents) || agents < floor) {
    throw new Error(`lane '${lane.persona}' has an invalid \`agents\` count`
      + ` (${JSON.stringify(lane.agents)})`);
  }
  return { ...lane, agents, run };
}

// A plan that predates this field, or one written by hand, gets the answer
// that grants nothing. Absent is not "the default policy" here the way it is
// for `depth`: the field authorizes running code out of the diff under review,
// and a missing authorization has to read as no, never as a default yes.
//
// The cap is clamped rather than refused, and downward only. A plan asking for
// more probes per lane than this build's own bound is a plan written against a
// different build or by hand, and lowering it costs a reviewer one script while
// honoring it costs the run whatever that reviewer decided to spend.
export function parseProbePolicy(probes) {
  if (!probes || typeof probes !== 'object' || Array.isArray(probes)) {
    return { allowed: false, perLane: 0, reason: 'this plan records no probe policy' };
  }
  const allowed = probes.allowed === true;
  const asked = Number.isInteger(probes.perLane) && probes.perLane >= 0
    ? probes.perLane : MAX_PROBES_PER_LANE;
  return {
    allowed,
    perLane: allowed ? Math.min(asked, MAX_PROBES_PER_LANE) : 0,
    reason: typeof probes.reason === 'string' ? probes.reason : '',
  };
}

export function parsePlan(plan, { personas = DEFAULT_PERSONAS } = {}) {
  if (!plan || typeof plan !== 'object' || !Array.isArray(plan.lanes)) {
    throw new Error('not a plan.json (missing `lanes`)');
  }
  // Normalized here rather than at each reader: the report prints this field,
  // and a reader that defaults an unknown depth renders a run at a depth
  // nobody planned. Absent is fine and means the default; present-and-wrong
  // is an error, exactly as for `agents`.
  return {
    ...plan,
    depth: parseDepth(plan.depth),
    probes: parseProbePolicy(plan.probes),
    lanes: plan.lanes.map((l) => parseLane(l, personas)),
  };
}

export const runLanes = (lanes) => lanes.filter((l) => l.run);

// The lanes a caller must expect two payloads from. Round 2 spawns one agent
// per persona regardless, so this is a round-1 question only.
export const splitLanes = (lanes) => runLanes(lanes).filter((l) => l.agents > 1);

// Keyed on lanes the plan explicitly RULED OUT rather than on lanes it named,
// because a plan need not be exhaustive: rejecting every persona a hand-written
// plan happens not to list would refuse real reviewers. A lane recorded
// `run: false` is the case the plan is actually making a claim about.
export const skippedLanes = (lanes) => lanes.filter((l) => !l.run);

// One name per running lane, or one per agent (`persona-a`, `persona-b`, …)
// for a lane split across more than one — read from that lane's own `agents`
// count, never a repeated literal 2, so raising SPLIT_AGENTS still gets the
// right worktrees. Up to MAX_SPLIT_AGENTS of them: past 'z' the suffix walks
// into '{' and '|', so parseLane refuses that count rather than letting this
// function invent a name for it.
export function agentNames(lanes) {
  return runLanes(lanes).flatMap((l) => (l.agents === 1
    ? [l.persona]
    : Array.from({ length: l.agents }, (_, i) => `${l.persona}-${String.fromCharCode(97 + i)}`)));
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
