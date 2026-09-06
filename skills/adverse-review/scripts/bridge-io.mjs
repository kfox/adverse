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

// combine.mjs and triage.mjs both take --merge-personas <persona>, typed by
// hand once per lane the plan actually split. plan.mjs already decided that
// roster (kfox/adverse#19 item 4); --plan <plan.json> reads it back instead
// of retyping it, and can be combined with explicit --merge-personas flags —
// the two are unioned, not exclusive.
export function splitPersonasFromPlan(file, prefix) {
  const plan = readJson(file, prefix);
  if (!plan || !Array.isArray(plan.lanes)) {
    process.stderr.write(`${prefix}: ${file}: not a plan.json (missing \`lanes\`)\n`);
    process.exit(2);
  }
  return plan.lanes.filter((l) => l.run && l.agents > 1).map((l) => l.persona);
}
