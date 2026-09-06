#!/usr/bin/env node
// Skill bridge: how much review does this change deserve?
//
// Four modes:
//
//   (default)                    plan the review from the diff: which lanes,
//                                how many agents each, rounds, iteration cap
//   --escalate round1-*.json     re-plan rounds and the cap from what round 1
//                                actually found (--expect names the lanes the
//                                plan ran, so a missing payload fails closed);
//                                add --sh to print ROUNDS/CAP/R2_REASON as
//                                shell assignments instead of --json/prose
//   --agents plan.json           print a plan.json's worktree agent list —
//                                persona, or persona-a/persona-b/… for a lane
//                                split across more than one agent
//   --expect plan.json           print a plan.json's run-lane roster, comma-
//                                joined — the exact string --escalate
//                                --expect wants, so it is read back rather
//                                than retyped from the plan's `lanes`
//
// These print modes exist so the SKILL's own prose never hand-computes a
// value plan.json already holds: five separate `node -p`/inline-JS snippets
// (the worktree loop, the round-2 roster, and the ROUNDS/CAP/R2_REASON
// triple) used to do that, and one of them hardcoded the split width as the
// literal 2 — silently wrong the day SPLIT_AGENTS in scaling.mjs changes
// (kfox/adverse#19, items 1 and 2).
//
// The plan is advice, not a gate: exit 0 = plan printed, 2 = usage error.
// Size comes from `git diff --numstat`, never from the diff text — see
// src/scaling.mjs for why the diff text cannot be trusted to measure itself.
// An unreadable inventory fails toward the full shape (unreadable is not the
// same as small), and the reads are separate so a supplied --files list
// survives a failed diff read. Every lane the plan skips must still be
// declared to the synthesizer (`--skipped`), and a skipped round 2 declared
// with `--round2-skipped`; an undeclared gap reads exactly like a clean pass.

import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { readJson, usage } from './bridge-io.mjs';
import { importFromSrc } from './package-root.mjs';

const { agentNames, escalate, parsePlan, planReview, runLanes } = await importFromSrc('scaling.mjs');

const { values, positionals } = parseArgs({
  options: {
    repo:     { type: 'string' },
    base:     { type: 'string' },
    files:    { type: 'string' },
    pin:      { type: 'string', multiple: true },
    escalate: { type: 'boolean' },
    expect:   { type: 'string' },
    agents:   { type: 'string' },
    sh:       { type: 'boolean' },
    json:     { type: 'boolean' },
  },
  allowPositionals: true,
  strict: true,
});

function emit(payload, human) {
  process.stdout.write(values.json ? JSON.stringify(payload, null, 2) + '\n' : human);
}

// A single quoted, `eval`-safe shell literal: wrap in single quotes and
// escape any embedded one by closing the quote, emitting an escaped quote,
// and reopening it — the standard POSIX trick, since a shell string has no
// in-quote escape of its own.
function shQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

// The lane shape, the persona registry and the `agents` count are all
// src/scaling.mjs's rules now — `planReview` writes this file, so it owns what
// counts as one. This bridge only turns a thrown message into its exit code.
function readPlanFile(file) {
  try {
    return parsePlan(readJson(file, 'plan'));
  } catch (e) {
    process.stderr.write(`plan: ${file}: ${e.message}\n`);
    process.exit(2);
  }
}

// --- --agents <plan.json>: the worktree loop's agent list --------------------

if (values.agents !== undefined) {
  if (values.escalate || positionals.length) {
    usage('Usage: plan.mjs --agents <plan.json>');
  }
  const names = agentNames(readPlanFile(values.agents).lanes);
  process.stdout.write(`${names.join(' ')}\n`);
  process.exit(0);
}

// --- --expect <plan.json> (outside --escalate): the run-lane roster ---------
//
// Prints the same comma-joined persona string --escalate --expect takes as
// input, read back out of a plan.json's `lanes` instead of retyped by hand.

if (values.expect !== undefined && !values.escalate) {
  if (positionals.length) {
    usage('Usage: plan.mjs --expect <plan.json>');
  }
  const lanes = runLanes(readPlanFile(values.expect).lanes);
  process.stdout.write(`${lanes.map((l) => l.persona).join(',')}\n`);
  process.exit(0);
}

// --- escalate mode -----------------------------------------------------------

if (values.escalate) {
  if (values.sh && values.json) {
    usage('Usage: plan.mjs --escalate --expect auditor,steward,… (--json | --sh) round1-<persona>*.json …');
  }
  const expectList = (values.expect ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!positionals.length || !expectList.length) {
    // --expect is required, not optional: without a roster, a lane whose file
    // never arrived is indistinguishable from a lane that found nothing, and
    // blind escalation reproduces the exact fail-open this mode was built to
    // close.
    usage('Usage: plan.mjs --escalate --expect auditor,steward,… [--json] round1-<persona>*.json …');
  }
  // Exit 2, not default advice: a typo'd path that silently yielded the
  // default plan would hide the error behind a plausible answer.
  const payloads = positionals.map((path) => readJson(path, 'plan'));
  const result = escalate(payloads, { expected: expectList });
  if (values.sh) {
    process.stdout.write(`ROUNDS=${result.rounds}\n`);
    process.stdout.write(`CAP=${result.maxIterations}\n`);
    process.stdout.write(`R2_REASON=${shQuote(result.roundsReason)}\n`);
    process.exit(0);
  }
  emit(result,
    `round 2: ${result.rounds === 2 ? 'run' : 'skip'} — ${result.roundsReason}\n`
    + `max iterations: ${result.maxIterations}`
    + (result.capReason ? ` — ${result.capReason}` : '')
    + '\n');
  process.exit(0);
}

// --- plan mode ---------------------------------------------------------------

if (positionals.length) {
  process.stderr.write('plan: unexpected arguments (round-1 files go with --escalate): '
    + positionals.join(' ') + '\n');
  process.exit(2);
}

const repo = values.repo ?? process.cwd();
const base = values.base ?? 'main';
// A base in git's option position would be parsed as a git option — a
// workflow-doc-supplied ref must not become `--output=…`.
if (base.startsWith('-')) {
  process.stderr.write(`plan: --base ${JSON.stringify(base)} looks like an option, not a ref\n`);
  process.exit(2);
}

const git = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf-8', maxBuffer: 256 * 1024 * 1024 });

// Three separate reads with separate failure policies. A --files list the
// caller supplied must never be discarded because an unrelated git call
// failed; a missing numstat only means "unmeasured", which excludes the small
// bucket; a missing diff only blinds the content signals, which fail toward
// running the Adversary.
let files = [];
if (values.files) {
  try {
    files = readFileSync(values.files, 'utf-8').split('\n').filter(Boolean);
  } catch (e) {
    process.stderr.write(`plan: --files ${values.files}: ${e.message}\n`);
    process.exit(2);
  }
} else {
  try {
    files = git(['diff', '--name-only', `${base}...HEAD`]).split('\n').filter(Boolean);
  } catch (e) {
    process.stderr.write(`plan: could not list changed files (${e.message}); planning the full shape\n`);
  }
}

// The numstat is read even when the caller supplied --files, because its
// forcing signals (unscannable rows, deleted lines) only ever ADD review —
// the same reason the diff read below survives a --files run. What a
// mismatched range must NOT do is size the list: an empty measurement of the
// wrong range would read as `small` for arbitrarily large files, so
// `numstatMatchesFiles: false` keeps the small bucket unreachable while the
// forces stay live. Suppressing the read entirely re-opened both forces on
// exactly the documented flow, where files.txt is written from the same range
// two lines earlier.
let numstat = null;
try {
  numstat = git(['diff', '--numstat', `${base}...HEAD`]);
} catch (e) {
  process.stderr.write(`plan: could not measure the diff (${e.message}); the small bucket is unreachable\n`);
}

// null, not '': planReview treats null as "could not be read" and forces the
// Adversary — an empty string would read as an empty diff and let the lane
// skip on signals nobody scanned.
let diff = null;
try {
  diff = git(['diff', `${base}...HEAD`]);
} catch (e) {
  process.stderr.write(`plan: could not read the diff (${e.message}); the Adversary lane is forced\n`);
}

const plan = planReview({
  files,
  diff,
  numstat,
  numstatMatchesFiles: !values.files,
  pins: values.pin ?? [],
});

const sizeLine = files.length === 0
  ? 'size: unknown (no file list)'
  : plan.size.measured
    ? `size: ${plan.size.bucket} (${plan.size.fileCount} files, ${plan.size.changedLines} changed lines`
      + (plan.size.unscannable.length ? `, ${plan.size.unscannable.length} unmeasurable` : '') + ')'
    : `size: ${plan.size.bucket} (${plan.size.fileCount} files, unmeasured`
      + (plan.size.unscannable.length ? `, ${plan.size.unscannable.length} unmeasurable` : '') + ')';
const laneLine = (l) => `  ${l.persona.padEnd(11)} ${l.run ? `run   ${l.agents} agent${l.agents === 1 ? ' ' : 's'}` : 'skip          '} — ${l.reason}`;
emit(plan,
  sizeLine + '\n'
  + (plan.reasons.length ? plan.reasons.map((r) => `note: ${r}\n`).join('') : '')
  + 'lanes:\n'
  + plan.lanes.map(laneLine).join('\n') + '\n'
  + `rounds: ${plan.rounds} (re-decided after round 1: plan.mjs --escalate --expect <lanes> round1-*.json)\n`
  + `max iterations: ${plan.maxIterations}\n`);
process.exit(0);
