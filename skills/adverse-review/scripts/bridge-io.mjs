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

import { importFromSrc } from './package-root.mjs';

const { parsePlan, splitLanes } = await importFromSrc('scaling.mjs');

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

// The persona string keys the output filename of three bridges, and the
// synthesizer counts DISTINCT personas — so a re-cased or invented name mints
// a phantom reviewer, and a repeated one silently overwrites the lane that
// wrote first. Consensus is this tool's entire product and this is the
// cheapest way to counterfeit it.
//
// The reasoning was written down in verify.mjs's header and then applied to
// neither of the bridges beside it, which is what these two functions are for:
// one implementation each, not one copy per bridge. bridge-io.mjs took
// `readJson` and left exactly these guards duplicated, which is how they
// drifted in the first place.
export function requireKnownPersona(persona, { prefix, file, personas }) {
  if (typeof persona !== 'string' || !personas.includes(persona)) {
    process.stderr.write(`${prefix}: ${file}: unknown persona ${JSON.stringify(persona)}`
      + ` (expected one of ${personas.join(', ')})\n`);
    process.exit(1);
  }
  return persona;
}

// Refuses to write a destination this process has already written. Two
// payloads naming one persona is a stale file or a spoof, never a legitimate
// state — but only WITHIN a run: Phase 9 loops back through the same outdir on
// purpose, so a file left by an earlier iteration is expected and is not
// checked for.
export function makeWriteGuard(prefix) {
  const written = new Map();
  return function claimDest(dest, src) {
    if (written.has(dest)) {
      process.stderr.write(`${prefix}: ${src}: refuses to overwrite ${dest}, already written`
        + ` this run from ${written.get(dest)} — two payloads claim one persona\n`);
      process.exit(1);
    }
    written.set(dest, src);
    return dest;
  };
}

// Every lane the plan mentions, as parsed lanes — the WHOLE roster, including
// the lanes it decided not to run. Callers need both halves: which lanes were
// split (agents > 1) and which lanes the plan ruled out. Filtering to the split
// ones here threw the second half away before any caller could ask, so a
// payload from a lane the plan marked `run: false` was accepted as a reviewer
// and counted toward consensus.
//
// The shape rules themselves live in src/scaling.mjs beside `planReview`, the
// function that writes this file — three readers had each validated a
// different half of it. This is the bridge half: turn the thrown message into
// this contract's exit 2, since a script that could not read its input never
// got as far as judging a review.
export function readPlanLanes(file, prefix) {
  try {
    return parsePlan(readJson(file, prefix)).lanes;
  } catch (e) {
    process.stderr.write(`${prefix}: ${file}: ${e.message}\n`);
    process.exit(2);
  }
}

export const splitPersonas = (lanes) => splitLanes(lanes).map((l) => l.persona);
