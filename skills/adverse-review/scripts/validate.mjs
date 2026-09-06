#!/usr/bin/env node
// Skill bridge: validate a reviewer-written round-1/round-2/verify payload.
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

const { validatePhase1, validatePhase2, validateVerify } = await importFromSrc('prompts.mjs');

const VALIDATORS = { round1: validatePhase1, round2: validatePhase2, verify: validateVerify };

const { values, positionals } = parseArgs({
  options: { phase: { type: 'string' } },
  strict: true,
  allowPositionals: true,
});

const validate = values.phase && VALIDATORS[values.phase];
if (!validate || !positionals.length) {
  usage('Usage: validate.mjs --phase round1|round2|verify <file.json> [file2.json …]\n'
    + `  --phase must be one of: ${Object.keys(VALIDATORS).join('|')}`);
}

function personaFromPath(file) {
  const base = file.replace(/^.*\//, '').replace(/\.json$/, '');
  return base.replace(new RegExp(`^${values.phase}-`), '').replace(/-[ab]$/, '');
}

let failed = 0;
for (const file of positionals) {
  const persona = personaFromPath(file);
  const err = validate(readJson(file, 'validate'), persona);
  if (err) {
    failed += 1;
    process.stderr.write(`${file}: ${err}\n`);
  } else {
    process.stdout.write(`${file}: ok (${persona})\n`);
  }
}

if (failed) process.exitCode = 1;
