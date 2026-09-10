#!/usr/bin/env node
// Skill bridge: Phase 0. Runs this repository's own checks, records what they
// actually said, and binds the record to the commit they ran against.
//
// Why this exists. The gate suppresses findings — round 2 tells every lane not
// to report what the gate proves — and until this script it was a sentence the
// orchestrator typed. A suppression channel with no provenance silently narrows
// what four reviewers are willing to say, and the resulting report is
// indistinguishable from one where nobody found anything. src/gate.mjs carries
// the full argument.
//
// This script only measures. It never decides whether the review may proceed:
// that reads `status` out of the file it writes, so the decision is made from
// the record rather than from this process's memory of it.
//
// Exit codes follow the bridge contract (bridge-io.mjs):
//   0  green, or partial — the checks that ran did not object
//   1  red — a check ran and said no. A claim about the change.
//   2  usage, or the record could not be written. Nothing was established.

import path from 'node:path';

import { parseBridgeArgs, usage, writeOutput } from './bridge-io.mjs';
import { importFromSrc } from './package-root.mjs';

const { DEFAULT_CHECK_TIMEOUT_MS, parseCheckSpec, runGate, worktreeDigest } = await importFromSrc('gate.mjs');
const { resolveRef } = await importFromSrc('trace.mjs');

const USAGE = "Usage: gate.mjs --repo <dir> --check 'name=command' [--check 'name=command' …] "
  + '[--timeout <ms>] --out <gate.json>';

const { values } = parseBridgeArgs({
  prefix: 'gate',
  usage: USAGE,
  options: {
    repo:    { type: 'string' },
    check:   { type: 'string', multiple: true },
    timeout: { type: 'string' },
    out:     { type: 'string' },
  },
  strict: true,
});

if (!values.repo || !values.out) usage(USAGE);

// No checks is a usage error, never an empty green and never a quiet
// `unknown`. Which commands constitute this repository's gate is not
// discoverable without guessing, and a guess that exits 0 is a fabricated pass
// — the precise failure this bridge was written to remove.
const specs = values.check ?? [];
if (!specs.length) {
  usage('gate: at least one --check is required — name the commands this repo calls its gate\n' + USAGE);
}

const checks = specs.map((s) => {
  const parsed = parseCheckSpec(s);
  if (!parsed) usage(`gate: --check must be 'name=command', got: ${s}\n${USAGE}`);
  return parsed;
});

const timeoutMs = values.timeout === undefined ? DEFAULT_CHECK_TIMEOUT_MS : Number(values.timeout);
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
  usage(`gate: --timeout must be a positive number of milliseconds, got: ${values.timeout}\n${USAGE}`);
}

const repo = path.resolve(values.repo);
const head = resolveRef(repo, 'HEAD');
if (head === null) {
  process.stderr.write(`gate: ${repo}: cannot resolve HEAD — the record could not be bound to a commit\n`);
  process.exit(2);
}

// Captured BEFORE the checks run. A check that writes into the tree — a
// formatter, a snapshot update, a build artifact — would otherwise change the
// digest it is being measured against and make every gate look moved.
const worktree = worktreeDigest(repo);

const gate = runGate(checks, { cwd: repo, head, worktree, timeoutMs });

// Exit 2, not 1, which `writeOutput` is where the reason for now lives: a run
// that could not write its record established nothing, and exit 1 here would
// read as "the gate is red".
writeOutput('gate', values.out, `${JSON.stringify(gate, null, 2)}\n`);

process.stdout.write(`gate: ${gate.status} (${gate.summary})`
  + `${gate.verified ? ' — verified' : ` — not verified: ${gate.why}`}\n`);

for (const c of gate.checks) {
  if (c.exitCode === 0) continue;
  process.stderr.write(`gate: ${c.name}: ${c.result || `exit ${c.exitCode}`}\n`);
}

process.exit(gate.status === 'red' ? 1 : 0);
