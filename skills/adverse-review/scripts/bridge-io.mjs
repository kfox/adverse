// Shared bridge I/O: read a JSON input file, or print a usage message and
// exit — one exit-code contract instead of six independent copies.
//
// The copies had already disagreed on the exit code for the exact same
// failure (an unreadable input file): converge.mjs and plan.mjs already used
// 2, triage.mjs/repair.mjs/combine.mjs/synthesize.mjs used 1. converge.mjs's
// own docs draw the line these follow — "exit 2 is deliberately not exit 1:
// exit 1 is a claim about a review, and this run could not read one" — so a
// script that never got as far as reading its input exits 2, everywhere.

import { readFileSync } from 'node:fs';

export function readJson(file, prefix) {
  try {
    return JSON.parse(readFileSync(file, 'utf-8'));
  } catch (e) {
    process.stderr.write(`${prefix}: ${file}: ${e.message}\n`);
    process.exit(2);
  }
}

export function usage(text) {
  process.stderr.write(text.endsWith('\n') ? text : `${text}\n`);
  process.exit(2);
}
