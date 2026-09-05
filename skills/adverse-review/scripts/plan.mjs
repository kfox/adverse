#!/usr/bin/env node
// Skill bridge: how much review does this change deserve?
//
// Two modes, like converge.mjs:
//
//   (default)                    plan the review from the diff: which lanes,
//                                how many agents each, rounds, iteration cap
//   --escalate round1-*.json     re-plan rounds and the cap from what round 1
//                                actually found
//
// The plan is advice, not a gate: exit 0 = plan printed, 2 = usage error.
// An unreadable diff fails toward the full shape, same as the scope bridge —
// unreadable is not the same as small. Every lane the plan skips must still be
// declared to the synthesizer (`--skipped`); an undeclared skipped lane reads
// exactly like a lane that looked and found nothing.

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
  if (!positionals.length) {
    process.stderr.write('Usage: plan.mjs --escalate [--json] round1-<persona>*.json …\n');
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

  const result = escalate(payloads);
  emit(result,
    `round 2: ${result.rounds === 2 ? 'run' : 'skip'} — ${result.reasons[0]}\n`
    + `max iterations: ${result.maxIterations}`
    + (result.reasons[1] ? ` — ${result.reasons[1]}` : '')
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

let files, diff;
try {
  files = values.files
    ? readFileSync(values.files, 'utf-8').split('\n').filter(Boolean)
    : execFileSync('git', ['diff', '--name-only', `${base}...HEAD`],
                   { cwd: repo, encoding: 'utf-8' }).split('\n').filter(Boolean);
  diff = execFileSync('git', ['diff', `${base}...HEAD`],
                      { cwd: repo, encoding: 'utf-8', maxBuffer: 256 * 1024 * 1024 });
} catch (e) {
  process.stderr.write(`plan: could not read the diff (${e.message}); planning the full shape\n`);
  files = [];
  diff = '';
}

const plan = planReview({ files, diff, pins: values.pin ?? [] });

const laneLine = (l) => `  ${l.persona.padEnd(11)} ${l.run ? `run   ${l.agents} agent${l.agents === 1 ? ' ' : 's'}` : 'skip          '} — ${l.reason}`;
emit(plan,
  `size: ${plan.size.bucket} (${plan.size.fileCount} files, ${plan.size.addedLines} added lines)\n`
  + (plan.reasons.length ? plan.reasons.map((r) => `note: ${r}\n`).join('') : '')
  + 'lanes:\n'
  + plan.lanes.map(laneLine).join('\n') + '\n'
  + `rounds: ${plan.rounds} (re-decided after round 1: plan.mjs --escalate round1-*.json)\n`
  + `max iterations: ${plan.maxIterations}\n`);
process.exit(0);
