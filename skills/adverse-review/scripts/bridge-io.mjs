// Shared bridge I/O: read a JSON input file, or print a usage message and
// exit — one exit-code contract instead of six independent copies.
//
// The copies had already disagreed on the exit code for the exact same
// failure (an unreadable input file): converge.mjs and plan.mjs already used
// 2, triage.mjs/repair.mjs/combine.mjs/synthesize.mjs used 1. converge.mjs's
// own docs draw the line these follow — "exit 2 is deliberately not exit 1:
// exit 1 is a claim about a review, and this run could not read one" — so a
// script that never got as far as reading its input exits 2, everywhere.

import { constants, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { importFromSrc } from './package-root.mjs';

const { parsePlan, splitLanes } = await importFromSrc('scaling.mjs');
const { refuseDirectRun } = await importFromSrc('entryGuard.mjs');

// A library in a directory of executables, so `node …/scripts/bridge-io.mjs` is
// the same silent no-op every module under src/ now refuses (kfox/adverse#71).
// Unlike package-root.mjs beside it, this file has already located src/ and can
// use the shared guard.
refuseDirectRun(import.meta.url);

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

// Every bridge parses with `strict: true`, so `--help`, an unknown flag, and
// `=value` on a boolean all THROW — an uncaught Node stack trace at exit 1,
// which under this contract claims a payload failed its schema. `--help`
// answers with the usage text at exit 0; any other parse refusal is exit 2
// with its one-line reason above the usage text, because a process that never
// parsed its arguments never read an input.
export function parseBridgeArgs({ prefix, usage: usageText, ...config }) {
  let parsed;
  try {
    parsed = parseArgs({
      ...config,
      options: { ...config.options, help: { type: 'boolean' } },
    });
  } catch (e) {
    if (typeof e.code !== 'string' || !e.code.startsWith('ERR_PARSE_ARGS')) throw e;
    usage(`${prefix}: ${e.message.split('\n')[0]}\n${usageText}`);
  }
  if (parsed.values.help) {
    process.stdout.write(usageText.endsWith('\n') ? usageText : `${usageText}\n`);
    process.exit(0);
  }
  return parsed;
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

// A destination this run has claimed: create it, truncate what is there, and
// never follow a symlink. Every run directory in this flow is writable by every
// agent in the run, so a symlink can be planted at any output path after any
// pre-write check has looked at it; O_NOFOLLOW fails the open itself (ELOOP)
// instead of narrowing that window to something smaller than a scheduler tick.
//
// Exported because two bridges write output outside the queue below, and the
// flag set is the whole of what makes such a write safe. Stated once: a second
// copy of it is a copy that can be one flag short, which is what this
// repository keeps finding wherever a rule was restated instead of shared.
export const CLAIMED_PATH_FLAGS = constants.O_WRONLY | constants.O_CREAT
  | constants.O_TRUNC | constants.O_NOFOLLOW;

// Refuses to write a destination this process has already written. Two
// payloads naming one persona is a stale file or a spoof, never a legitimate
// state — but only WITHIN a run: Phase 9 loops back through the same outdir on
// purpose, so a file left by an earlier iteration is expected and is not
// checked for.
//
// Not exported: reached only through `makeWriteQueue` below, because a bridge
// that claims a destination without queuing the write has claimed it at the
// wrong moment — see there.
function makeWriteGuard(prefix) {
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

// Every output file of one run, written only after every payload has been read
// and judged. A bridge that writes one file per payload inside the loop that
// validates them has already published 1..N-1 when it refuses payload N: an
// outdir holding a partial set of `round1-<persona>.verified.json` files from a
// run that exited 1, which is indistinguishable from a complete set to the glob
// that reads them next. Measured on verify.mjs before this existed: an honest
// auditor payload beside a steward payload that pre-stamped `provenance` exited
// 1 with `round1-auditor.verified.json` on disk.
//
// regression.mjs's fold states the rule — "before anything is written, and for
// EVERY lane" — and states it as a comment over a hand-ordered pre-check, which
// is how the two bridges beside it came to disagree with it. Ordering is a
// property of a structure, so it lives in one.
//
// `queue` carries makeWriteGuard's collision refusal, which now fires before the
// first byte is written rather than after the colliding file's sibling is
// already on disk.
export function makeWriteQueue(prefix) {
  const claim = makeWriteGuard(prefix);
  const queued = [];

  return {
    queue(dest, src, body) {
      queued.push({ dest: claim(dest, src), src, body });
    },
    // A write that fails is exit 2 and a sentence, not a stack trace under exit
    // 1: exit 1 is a claim about a review, and a run that could not write its
    // output made none. The files already flushed are named, because the outdir
    // is now partial and only the operator can decide whether to clear it —
    // there is no atomic multi-file write in the stdlib, so saying so is the
    // whole remedy.
    flush(verb) {
      const done = [];
      for (const { dest, src, body } of queued) {
        try {
          writeFileSync(dest, body, { encoding: 'utf-8', flag: CLAIMED_PATH_FLAGS });
        } catch (e) {
          process.stderr.write(`${prefix}: ${dest}: cannot be written (${e.message.trim()})\n`
            + (done.length
              ? `    ${done.join(', ')} ${done.length === 1 ? 'was' : 'were'} already written,`
                + ' so this outdir is partial: clear it or fold into a fresh one\n'
              : '    nothing was written\n'));
          process.exit(2);
        }
        done.push(dest);
        process.stdout.write(`${verb} ${src} -> ${dest}\n`);
      }
    },
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

// One place the roster's problems become this process's exit code. The first
// problem decides it, and src/roster.mjs orders them so a run that could not
// read its configuration (exit 2) is reported before a payload that does not
// describe a review (exit 1). Warnings are reached only when nothing refused
// the run — a warning printed beside a fatal error is a warning nobody reads.
export function reportRoster({ problems, warnings }, prefix) {
  if (problems.length) {
    for (const p of problems) process.stderr.write(`${prefix}: ${p.message}\n`);
    process.exit(problems[0].exit);
  }
  for (const w of warnings) process.stderr.write(`${prefix}: ${w}\n`);
}
