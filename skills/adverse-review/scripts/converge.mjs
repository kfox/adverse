#!/usr/bin/env node
// Skill bridge: the stop condition, and the ledger write that makes the next
// iteration start from this one's conclusions.
//
// Two modes:
//
//   --record decisions.json   append this iteration's adjudications
//   (default)                 read report.json + ledger, print status, set exit code
//
// Exit codes are the loop's control flow: 0 = converged, 1 = iterate again,
// 2 = usage error, 3 = iteration cap reached with findings still open. 3 is
// deliberately not 0 — a capped run is a stop, not a pass, and a loop that
// exits clean on the cap would be lying about what it found.

import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';

import { importFromSrc } from './package-root.mjs';

const {
  convergenceStatus, emptyLedger, loadLedger, recordDecisions, saveLedger,
} = await importFromSrc('ledger.mjs');
const { traceAnchor } = await importFromSrc('trace.mjs');

const { values } = parseArgs({
  options: {
    report:  { type: 'string' },
    ledger:  { type: 'string' },
    record:  { type: 'string' },
    repo:    { type: 'string' },
    head:    { type: 'string' },
    'max-iterations': { type: 'string' },
  },
  strict: true,
});

if (!values.ledger) {
  process.stderr.write(
    'Usage:\n'
    + '  converge.mjs --ledger L.json --record decisions.json --repo DIR [--head REF]\n'
    + '  converge.mjs --ledger L.json --report report.json --repo DIR [--head REF] [--max-iterations N]\n');
  process.exit(2);
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf-8'));
  } catch (e) {
    process.stderr.write(`converge: ${file}: ${e.message}\n`);
    process.exit(2);
  }
}

const repo = values.repo ?? process.cwd();
const head = values.head ?? 'HEAD';

let ledger;
try {
  ledger = loadLedger(values.ledger);
} catch (e) {
  process.stderr.write(`converge: ${e.message}\n`);
  process.exit(2);
}

// --- record mode -------------------------------------------------------------

if (values.record) {
  const payload = readJson(values.record);
  const decisions = Array.isArray(payload) ? payload : payload.decisions ?? [];
  const iteration = (ledger.iterations ?? []).length + 1;
  let next;
  try {
    next = recordDecisions(ledger, decisions, { iteration, atCommit: head });
  } catch (e) {
    process.stderr.write(`converge: ${e.message}\n`);
    process.exit(2);
  }
  next.base ??= payload.base ?? null;
  saveLedger(values.ledger, next);
  const by = (d) => decisions.filter((x) => x.disposition === d).length;
  process.stdout.write(
    `iteration ${iteration}: recorded ${decisions.length} decision(s) -> ${values.ledger}\n`
    + `  fixed: ${by('fixed')} · declined: ${by('declined')} · deferred: ${by('deferred')}\n`);
  process.exit(0);
}

// --- status mode -------------------------------------------------------------

if (!values.report) {
  process.stderr.write('converge: --report is required unless --record is given\n');
  process.exit(2);
}

const report = readJson(values.report);

// Positions in the ledger were recorded against the commit the decision was
// made at; re-project each one to `head` before matching, or a fix that shifted
// the file makes every past decision look like a different finding.
const traceFor = (entry) => {
  if (!entry.file || !entry.atCommit) return null;
  try {
    return traceAnchor({
      repo, from: entry.atCommit, to: head,
      file: entry.file, line: entry.line, citedLine: entry.citedLine,
    });
  } catch {
    return null;
  }
};

const maxIterations = Number(values['max-iterations'] ?? 3);
const status = convergenceStatus(report, ledger ?? emptyLedger(), traceFor, { maxIterations });

const list = (fs) => fs.map((f) => `    - [${f.severity}·${f.kind}] ${f.title}`
  + (f.file ? ` (${f.file}${f.line !== null && f.line !== undefined ? `:${f.line}` : ''})` : '')).join('\n');

let out = `iteration ${status.iteration} of at most ${status.maxIterations}: ${status.reason}\n`;
if (status.open.length)      out += `  still open (${status.open.length}):\n${list(status.open)}\n`;
if (status.regressed.length) out += `  REGRESSED — recorded fixed, reported again (${status.regressed.length}):\n${list(status.regressed)}\n`;
if (status.settled.length)   out += `  settled in an earlier iteration, not counted (${status.settled.length}):\n${list(status.settled)}\n`;
process.stdout.write(out);

if (status.done) process.exit(0);
process.exit(status.capped ? 3 : 1);
