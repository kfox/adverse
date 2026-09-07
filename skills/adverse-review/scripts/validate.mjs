#!/usr/bin/env node
// Skill bridge: validate an agent-written round-1/round-2/verify/fix/regression
// payload.
//
// Phases 2, 4, and 9 used to have the orchestrating model retype or reassemble
// each subagent's JSON reply on the way to disk. That hand was a defect
// source: transcription drift, truncation of long `detail` fields, and (the
// incident that opened issue #17) a fix recorded from memory that had never
// been written to a file at all. Reviewers now write their own payload with
// the Write tool; the orchestrator's remaining job is to run this against
// what actually landed, instead of reading it and judging for itself.
//
// The persona comes from the filename, not a repeated --persona flag — the
// whole point is that the orchestrator stops handling the payload, so it
// should not have to also retype which persona goes with which path.
//
// The filename carries TWO identities and both are read here. The PERSONA is
// the lane: round1-auditor-a.json validates as `auditor`, the name its two
// halves share so that the synthesizer counts one voice for the lane. The
// full basename is the AGENT — `auditor-a`, the half that actually wrote this
// file — and that is the string round 2's self-validation guard keys on
// (src/personas.mjs's isLaneAgent, src/synthesis.mjs's reportedBy).
//
// This header used to call the -a/-b suffix "a filesystem artifact, not part
// of the identity", and the code acted on it: `.replace(/-[ab]$/, '')` threw
// the suffix away before anything could hold the payload against it. That made
// this bridge — the one component holding both the filename and the payload —
// the place where the system's only unforgeable identity was discarded.
// round1-auditor-a.json declaring `"agent": "auditor-b"` validated clean, and
// half A's own round-2 payload then ruled on half A's finding as if it were
// its sibling's: solo -> consensus, openBlocking false -> true, for two
// characters. The orchestrator names these files when it spawns the agents and
// each agent writes only the path it was given, so the NAME is evidence and
// the payload is a claim. Claims are checked against evidence here.

import { parseArgs } from 'node:util';

import { readJson, usage } from './bridge-io.mjs';
import { importFromSrc } from './package-root.mjs';

const { validateFix, validatePhase1, validatePhase2, validateRegression, validateVerify } =
  await importFromSrc('prompts.mjs');
const { DEFAULT_PERSONAS } = await importFromSrc('personas.mjs');

// Null prototype, the same defence combine.mjs already applies to its
// persona-keyed map. A plain object answers `__proto__` and `constructor` with
// something truthy, so `--phase __proto__` satisfied the membership guard
// below and then crashed — violating this bridge's own contract that exit 2
// means "could not read an input" and never a stack trace.
//
// `byPersona` is not a convenience flag. Three of these four phases are written
// by a lane, and this bridge's whole design is that the persona comes from the
// filename rather than a flag the orchestrator has to retype. A FIX payload has
// no persona: a fix agent is a batch of repair work, not a lane, and its
// identity is the `agent` label inside the file. Left to the filename rule,
// `fix-sid-bounds.json` would imply the persona `sid-bounds` and every fix
// payload would be refused as an unknown lane — so the table records which
// phases are lane-scoped instead of letting the naming convention decide by
// accident.
//
// Both identities ride to every lane-scoped validator as `(payload, persona,
// { agent })`. round1 and round2 bind the `agent` id (src/prompts.mjs's
// validateAgent); verify and regression carry no such field — their bridges
// rebuild the payload with explicit keys and drop anything else — so the
// option is inert there rather than needing a second flag per row.
const VALIDATORS = Object.assign(Object.create(null), {
  round1: { validate: validatePhase1, byPersona: true },
  round2: { validate: validatePhase2, byPersona: true },
  verify: { validate: validateVerify, byPersona: true },
  fix:    { validate: validateFix,    byPersona: false },
  // Lane-scoped like the first three: the regression pass is run BY a lane
  // (src/regression.mjs picks which), so `regression-adversary.json` names the
  // persona its payload has to agree with — the check that catches a pass filed
  // under the lane that reported the finding it was run to keep away from.
  regression: { validate: validateRegression, byPersona: true },
});

const { values, positionals } = parseArgs({
  options: { phase: { type: 'string' } },
  strict: true,
  allowPositionals: true,
});

const phase = values.phase && VALIDATORS[values.phase];
if (!phase || !positionals.length) {
  usage('Usage: validate.mjs --phase round1|round2|verify|fix|regression'
    + ' <file.json> [file2.json …]\n'
    + `  --phase must be one of: ${Object.keys(VALIDATORS).join('|')}`);
}

// The lane and the half, read off one name. `agent` is null when the basename
// names no half — the unsplit lane, where the persona is the only id the
// payload may claim.
//
// One letter, not `[ab]`: `agentNames` suffixes a, b, c … up to
// MAX_SPLIT_AGENTS, so the old pattern read `auditor-c` as a persona named
// `auditor-c` and refused it as an unknown lane — the full alphabet
// `agentNames` can emit has to round-trip through here. It does NOT follow that
// a three-way split works end to end: `checkCount` in src/roster.mjs still
// expects exactly 2 payloads for a merged lane, so three honest halves pass
// this bridge and die at combine.mjs with a message about a stale file. That is
// a closed failure, not a wrong answer, but do not read this pattern as the
// capability. `values.phase` is a validated key of VALIDATORS above,
// never arbitrary text, before it becomes part of a pattern.
function identityFromPath(file) {
  const base = file.replace(/^.*\//, '').replace(/\.json$/, '')
    .replace(new RegExp(`^${values.phase}-`), '');
  const half = /^(.+)-[a-z]$/.exec(base);
  return half ? { persona: half[1], agent: base } : { persona: base, agent: null };
}

const KNOWN_PERSONAS = new Set(DEFAULT_PERSONAS);

let failed = 0;
for (const file of positionals) {
  if (!phase.byPersona) {
    const payload = readJson(file, 'validate');
    const err = phase.validate(payload);
    if (err) {
      failed += 1;
      process.stderr.write(`${file}: ${err}\n`);
    } else {
      // The label is the payload's own `agent`, which validateFix constrains to
      // a token — this line is read by the orchestrator, and a newline in an
      // off-disk string is how a payload gets to look like the tool speaking.
      process.stdout.write(`${file}: ok (${payload.agent})\n`);
    }
    continue;
  }

  const { persona, agent } = identityFromPath(file);
  // `validatePhase1` only checks that the payload's `persona` equals the one
  // its FILENAME implies, so `round1-referee.json` claiming to be `referee`
  // agreed with itself and validated clean — this bridge blessing a lane that
  // does not exist, one step before combine.mjs is asked to trust the glob.
  if (!KNOWN_PERSONAS.has(persona)) {
    failed += 1;
    process.stderr.write(`${file}: filename implies persona '${persona}', which is not one of `
      + `${DEFAULT_PERSONAS.join(', ')}\n`);
    continue;
  }
  const err = phase.validate(readJson(file, 'validate'), persona, { agent });
  if (err) {
    failed += 1;
    process.stderr.write(`${file}: ${err}\n`);
  } else {
    // The identity that was PROVEN, which for a split half is the half — the
    // orchestrator reads this line, and `ok (auditor)` on a file named
    // round1-auditor-a.json says less than it looks like it says.
    process.stdout.write(`${file}: ok (${agent ?? persona})\n`);
  }
}

if (failed) process.exitCode = 1;
