#!/usr/bin/env node
// Skill bridge: how much review does this change deserve?
//
// Two modes, like converge.mjs:
//
//   (default)                    plan the review from the diff: which lanes,
//                                how many agents each, rounds, iteration cap
//   --escalate round1-*.json     re-plan rounds and the cap from what round 1
//                                actually found (--expect names the lanes the
//                                plan ran, so a missing payload fails closed)
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

import { importFromSrc } from './package-root.mjs';

const { escalate, planReview } = await importFromSrc('scaling.mjs');

const { values, positionals } = parseArgs({
  options: {
    repo:     { type: 'string' },
    base:     { type: 'string' },
    files:    { type: 'string' },
    pin:      { type: 'string', multiple: true },
    escalate: { type: 'boolean' },
    expect:   { type: 'string' },
    json:     { type: 'boolean' },
  },
  allowPositionals: true,
  strict: true,
});

function emit(payload, human) {
  process.stdout.write(values.json ? JSON.stringify(payload, null, 2) + '\n' : human);
}

// --- escalate mode -----------------------------------------------------------

if (values.escalate) {
  const expectList = (values.expect ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!positionals.length || !expectList.length) {
    // --expect is required, not optional: without a roster, a lane whose file
    // never arrived is indistinguishable from a lane that found nothing, and
    // blind escalation reproduces the exact fail-open this mode was built to
    // close.
    process.stderr.write('Usage: plan.mjs --escalate --expect auditor,steward,… [--json] round1-<persona>*.json …\n');
    process.exit(2);
  }
  const payloads = positionals.map((path) => {
    try {
      return JSON.parse(readFileSync(path, 'utf-8'));
    } catch (e) {
      // Exit 2, not default advice: a typo'd path that silently yielded the
      // default plan would hide the error behind a plausible answer.
      process.stderr.write(`plan: ${path}: ${e.message}\n`);
      process.exit(2);
    }
  });
  const result = escalate(payloads, { expected: expectList });
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
