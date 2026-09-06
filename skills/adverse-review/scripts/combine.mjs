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

import { readJson, readPlanLanes, reportRoster, usage } from './bridge-io.mjs';

import { importFromSrc } from './package-root.mjs';

const { mergeSplitReviews, normalizeVerdict } = await importFromSrc('synthesis.mjs');
const { checkRoster } = await importFromSrc('roster.mjs');

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

// A split lane exists only in round 1; round 2 spawns one agent per persona
// from the briefing, and its payloads carry validates/challenges rather than
// findings, so a merge would silently drop the second payload's work. The
// ROSTER half of --plan still applies to round 2 — the lanes round 2 runs are
// a subset of the lanes the plan ran, so the gate is sound either way.
if (values['merge-personas']?.length && hasRound2) {
  process.stderr.write('combine: --merge-personas applies only to --round1\n');
  process.exit(2);
}

const inputs = [...(values.round1 ?? values.round2), ...positionals];
const planLanes = values.plan ? readPlanLanes(values.plan, 'combine') : null;
const payloads = inputs.map((src) => ({ src, payload: readJson(src, 'combine') }));

// Who counts as a reviewer — src/roster.mjs, the same rules triage.mjs applies
// to the same payloads one phase earlier.
reportRoster(checkRoster(
  payloads.map(({ src, payload }) => ({ persona: payload?.persona, src })),
  {
    lanes: planLanes,
    explicitMerges: values['merge-personas'] ?? [],
    round: hasRound2 ? 2 : 1,
  },
), 'combine');

// Null prototype: the persona string indexes this map, and a plain object
// would answer `__proto__` with something truthy.
const combined = Object.create(null);
for (const { src, payload } of payloads) {
  if (hasRound1) {
    // Off-contract verdicts degrade to `reject`, loudly: synthesis scores an
    // unknown string as neutral and counts only the literal `reject` as a
    // block, so passing garbage through is the direction that erases a real
    // rejection.
    const norm = normalizeVerdict(payload.verdict);
    if (norm !== payload.verdict) {
      process.stderr.write(`combine: ${src}: verdict ${JSON.stringify(payload.verdict)} is off-contract; recorded as 'reject'\n`);
      payload.verdict = norm;
    }
  }
  // Duplicates that are not a declared split lane were refused above, so a
  // second payload here is a half of one.
  const existing = combined[payload.persona];
  combined[payload.persona] = existing ? mergeSplitReviews(existing, payload) : payload;
}

writeFileSync(values.out, JSON.stringify(combined, null, 2), 'utf-8');

process.stdout.write(`combined ${inputs.length} reviews -> ${values.out}\n`);
