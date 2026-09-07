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
// should not have to also retype which persona goes with which path. A
// split-lane file (round1-auditor-a.json) validates as its shared persona;
// the -a/-b suffix is a filesystem artifact, not part of the identity
// `persona` is checked against.

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

function personaFromPath(file) {
  const base = file.replace(/^.*\//, '').replace(/\.json$/, '');
  return base.replace(new RegExp(`^${values.phase}-`), '').replace(/-[ab]$/, '');
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

  const persona = personaFromPath(file);
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
  const err = phase.validate(readJson(file, 'validate'), persona);
  if (err) {
    failed += 1;
    process.stderr.write(`${file}: ${err}\n`);
  } else {
    process.stdout.write(`${file}: ok (${persona})\n`);
  }
}

if (failed) process.exitCode = 1;
