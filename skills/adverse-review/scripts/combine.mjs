#!/usr/bin/env node
// Skill bridge: combine N per-persona JSON files into a single keyed-by-persona
// JSON object that the synthesizer accepts.
//
// A duplicate persona across inputs is an error by default — it usually means
// the same file was passed twice. `--merge-personas <persona>` is the
// deliberate case: a lane split across two agents (a large diff, partitioned
// by file) produces two payloads under one persona name, and merging unions
// their findings, keeps the worse verdict, and joins both summaries
// (src/synthesis.mjs's mergeSplitReviews, so the combined payload and triage's
// briefing cannot disagree). The flag names the persona so the duplicate
// guard stays live for every lane that was NOT split — and a named persona
// must arrive in exactly two payloads: one half missing means half the diff
// got no reviewer, which is a degraded lane, not a quiet success.
//
// Every persona is checked against the registry before it is used as a key.
// The persona string is model-written and untrusted: a prototype key
// (`__proto__`) used to vanish a whole review into Object.prototype, and a
// re-cased name (`Auditor`) used to mint a phantom fifth reviewer whose
// agreement with its own other half read as cross-lane consensus.

import { parseArgs } from 'node:util';
import { writeFileSync } from 'node:fs';

import { readJson, readPlanLanes, splitPersonas, usage } from './bridge-io.mjs';

import { importFromSrc } from './package-root.mjs';

const { DEFAULT_PERSONAS } = await importFromSrc('personas.mjs');
const { mergeSplitReviews, normalizeVerdict } = await importFromSrc('synthesis.mjs');

const { values, positionals } = parseArgs({
  options: {
    round1: { type: 'string', multiple: true },
    round2: { type: 'string', multiple: true },
    out:    { type: 'string' },
    'merge-personas': { type: 'string', multiple: true },
    plan:   { type: 'string' },
  },
  allowPositionals: true,
  strict: true,
});

if (!values.out) {
  usage('Usage: combine.mjs (--round1 a.json b.json … [--merge-personas <persona>]… [--plan plan.json]) | (--round2 a.json b.json …) --out <combined.json>');
}

const hasRound1 = values.round1 !== undefined;
const hasRound2 = values.round2 !== undefined;
if (hasRound1 === hasRound2) {
  process.stderr.write('combine: provide exactly one of --round1 or --round2\n');
  process.exit(2);
}

const KNOWN_PERSONAS = new Set(DEFAULT_PERSONAS);

// The plan carries two answers and this only ever read one. `agents > 1` says
// which lanes were split; `run` says which lanes EXIST — and discarding that
// half meant membership in DEFAULT_PERSONAS was the only gate, so a payload
// from a lane the plan never ran was accepted as a reviewer and counted toward
// consensus. Both halves come off one read now.
const planLanes = values.plan ? readPlanLanes(values.plan, 'combine') : null;
// Keyed on lanes the plan explicitly RULED OUT rather than on lanes it named,
// because a plan need not be exhaustive: a hand-written one that mentions only
// the split lane is legitimate, and rejecting every persona it happens not to
// list would refuse real reviewers. A lane recorded `run: false` is the case
// the plan is actually making a claim about.
const notRun = planLanes
  ? new Set(planLanes.filter((l) => !l.run).map((l) => l.persona)) : null;
const ranPersonas = planLanes
  ? planLanes.filter((l) => l.run).map((l) => l.persona) : null;


// A split lane exists only in round 1; round 2 spawns one agent per persona
// from the briefing. Round-2 payloads carry validates/challenges, not
// findings, so a merge would silently drop the second payload's work. The
// ROSTER half of --plan still applies to round 2 — the lanes round 2 runs are
// a subset of the lanes the plan ran, so the gate is sound either way.
const mergePersonas = new Set([
  ...(values['merge-personas'] ?? []),
  ...(planLanes && hasRound1 ? splitPersonas(planLanes) : []),
]);
if (values['merge-personas']?.length && hasRound2) {
  process.stderr.write('combine: --merge-personas applies only to --round1\n');
  process.exit(2);
}

for (const p of mergePersonas) {
  if (!KNOWN_PERSONAS.has(p)) {
    process.stderr.write(`combine: ${p}: not a persona (${DEFAULT_PERSONAS.join(', ')})\n`);
    process.exit(2);
  }
}

const inputs = [...(values.round1 ?? values.round2), ...positionals];

// Null prototype: the persona string indexes this map, and a plain object
// would answer `__proto__` with something truthy.
const combined = Object.create(null);
const payloadCount = Object.create(null);
for (const path of inputs) {
  const payload = readJson(path, 'combine');
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || typeof payload.persona !== 'string') {
    process.stderr.write(`combine: ${path}: missing or invalid \`persona\` field\n`);
    process.exit(1);
  }
  if (!KNOWN_PERSONAS.has(payload.persona)) {
    process.stderr.write(`combine: ${path}: unknown persona '${payload.persona}'`
      + ` (expected one of ${DEFAULT_PERSONAS.join(', ')})\n`);
    process.exit(1);
  }
  if (notRun?.has(payload.persona)) {
    process.stderr.write(`combine: ${path}: the plan recorded '${payload.persona}' as not run,`
      + ' so a payload from it is a stale file or a spoof, not a reviewer.\n'
      + '  If you deliberately ran this lane anyway (SKILL.md Phase 1 allows overriding the'
      + ' plan for a thorough pass), the plan is the thing that is out of date: regenerate'
      + ' plan.json, or drop --plan and pass --merge-personas for any split lane.\n');
    process.exit(1);
  }


  if (hasRound1) {
    // Off-contract verdicts degrade to `reject`, loudly: synthesis scores an
    // unknown string as neutral and counts only the literal `reject` as a
    // block, so passing garbage through is the direction that erases a real
    // rejection.
    const norm = normalizeVerdict(payload.verdict);
    if (norm !== payload.verdict) {
      process.stderr.write(`combine: ${path}: verdict ${JSON.stringify(payload.verdict)} is off-contract; recorded as 'reject'\n`);
      payload.verdict = norm;
    }
  }
  const existing = combined[payload.persona];
  payloadCount[payload.persona] = (payloadCount[payload.persona] ?? 0) + 1;
  if (existing && !mergePersonas.has(payload.persona)) {
    process.stderr.write(`combine: duplicate persona '${payload.persona}' across inputs`
      + ' (a deliberately split lane needs --merge-personas <persona>)\n');
    process.exit(1);
  }
  combined[payload.persona] = existing ? mergeSplitReviews(existing, payload) : payload;
}

// A lane named in --merge-personas was split in two. One payload is not a
// merged lane, it is a lane whose other half was never reviewed — refuse, so
// the orchestrator must re-run the missing half or declare the lane degraded.
for (const p of mergePersonas) {
  const got = payloadCount[p] ?? 0;
  if (got !== 2) {
    process.stderr.write(`combine: --merge-personas ${p}: expected exactly 2 payloads for the split lane, got ${got}.`
      + (got < 2
        ? ' What is missing reviewed nothing — re-run it, or pass --degraded to synthesize.\n'
        : ' Extra payloads mean a stale file or a double glob — clean the run directory.\n'));
    process.exit(1);
  }
}

// A lane the plan ran that produced no payload reviewed nothing, and "reviewed
// and found nothing" is the same input downstream as "never looked". Warned
// rather than refused: the Pragmatist legitimately runs in round 1 and not in
// round 2, so silence is not always a failure — but it is never something the
// run should discover by noticing a missing row.
// Round 2 spawns one agent per persona EXCEPT the Pragmatist, whose findings
// are advisory and which never cross-reviews — so its absence from a round-2
// combine is the design working, not a lane that failed. Warning about it on
// every single run is how a real warning gets skimmed past.
const CROSS_REVIEWS = (p) => !(hasRound2 && p === 'pragmatist');

if (ranPersonas) {
  const silent = ranPersonas.filter((p) => CROSS_REVIEWS(p) && !(p in combined));

  if (silent.length) {
    process.stderr.write(`combine: the plan ran ${silent.join(', ')} but no payload arrived.`
      + ' If that lane failed, declare it: `synthesize --degraded <persona>`.\n');
  }
}

writeFileSync(values.out, JSON.stringify(combined, null, 2), 'utf-8');

process.stdout.write(`combined ${inputs.length} reviews -> ${values.out}\n`);
