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
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { importFromSrc } from './package-root.mjs';

const {
  checkBinding, convergenceStatus, emptyLedger, loadLedger, recordDecisions, saveLedger,
} = await importFromSrc('ledger.mjs');
const { resolveRef, traceAnchor } = await importFromSrc('trace.mjs');

const { values } = parseArgs({
  options: {
    report:  { type: 'string' },
    ledger:  { type: 'string' },
    record:  { type: 'string' },
    repo:    { type: 'string' },
    head:    { type: 'string' },
    at:      { type: 'string' },
    'max-iterations': { type: 'string' },
  },
  strict: true,
});

if (!values.ledger) {
  process.stderr.write(
    'Usage:\n'
    + '  converge.mjs --ledger L.json --record decisions.json --report report.json --repo DIR --at REVIEWED_REF\n'
    + '  converge.mjs --ledger L.json --report report.json --repo DIR [--head REF] [--max-iterations N]\n');
  process.exit(2);
}

// Identifies a report so a decision can say which observation it answered.
// A finding recorded FIXED against report R has not been re-observed when R is
// what the next convergence check reads, and calling that REGRESSED would make
// the loud signal noise on every first check after a fix batch.
function digest(file) {
  try {
    return createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 16);
  } catch {
    return null;
  }
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

// A ledger naming another repository used to load and adjudicate findings it
// had never seen — loadLedger checks only `version`. Commits cannot be faked
// across repositories, so they are the binding.
const bindingProblems = checkBinding(ledger, (ref) => resolveRef(repo, ref));
if (bindingProblems.length) {
  process.stderr.write(`converge: this ledger does not belong to this repository:\n`
    + bindingProblems.map((p) => `  - ${p}\n`).join(''));
  process.exit(2);
}

// --- record mode -------------------------------------------------------------

if (values.record) {
  const payload = readJson(values.record);
  const decisions = Array.isArray(payload) ? payload : payload.decisions ?? [];
  const iteration = (ledger.iterations ?? []).length + 1;

  // `atCommit` means "the commit these line numbers are valid at", and that is
  // the tree the panel READ — not the tree that exists after the fixes. Passing
  // the post-fix HEAD stores post-fix commit + pre-fix lines, and since the
  // next pass traces from atCommit to HEAD, from === to: the trace degrades to
  // the identity and the whole re-projection layer silently does nothing.
  const atCommit = values.at ?? head;
  if (!values.at) {
    process.stderr.write(
      'converge: --at not given, so decisions are anchored at ' + head + '.\n'
      + '  If fixes are already committed, these line numbers refer to the tree\n'
      + '  BEFORE them and tracing to HEAD will be a no-op. Pass --at <the commit\n'
      + '  the review read> to make re-projection work.\n');
  }

  const reportDigest = values.report ? digest(values.report) : null;
  if (!values.report) {
    process.stderr.write(
      'converge: --record without --report. These decisions will not name the\n'
      + '  report they answered, so the next check cannot tell "not yet verified"\n'
      + '  from "the fix did not take" and will report them REGRESSED.\n');
  }

  let next;
  try {
    next = recordDecisions(ledger, decisions, { iteration, atCommit, reportDigest });
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

// Validate AFTER coercion, and pass the option only when it is real.
//
// Two failures meet here. `Number('lots')` is NaN, and `iteration > NaN` is
// false forever, so a typo silently removes the cap the loop is bounded by —
// exit 3 becomes unreachable and the run cannot stop. The obvious repair, to
// drop the `?? 3` and let the module's own default stand, is worse: this call
// passes the option object unconditionally, `Number(undefined)` is also NaN,
// and a destructuring default fires only on `undefined` — so the cap would die
// on EVERY run instead of only on a typo.
const rawMax = values['max-iterations'];
let capOption = {};
if (rawMax !== undefined) {
  const n = Number(rawMax);
  if (!Number.isInteger(n) || n < 1) {
    process.stderr.write(`converge: --max-iterations must be a positive integer, got ${JSON.stringify(rawMax)}\n`);
    process.exit(2);
  }
  capOption = { maxIterations: n };
}
const status = convergenceStatus(report, ledger ?? emptyLedger(), traceFor,
  { ...capOption, reportDigest: digest(values.report) });

const list = (fs) => fs.map((f) => `    - [${f.severity}·${f.kind}] ${f.title}`
  + (f.file ? ` (${f.file}${f.line !== null && f.line !== undefined ? `:${f.line}` : ''})` : '')).join('\n');

let out = `iteration ${status.iteration} of at most ${status.maxIterations}: ${status.reason}\n`;
if (status.open.length)      out += `  still open (${status.open.length}):\n${list(status.open)}\n`;
if (status.unexamined.length) {
  out += `  NOT CROSS-EXAMINED — blocking, and no round 2 adjudicated them (${status.unexamined.length}):\n`
       + `${list(status.unexamined)}\n`
       + '    These do not count as credible, but they do not count as absent either.\n'
       + '    Cross-examine them (round 2) or record a decision on each.\n';
}
if (status.disputed.length) {
  out += `  DISPUTED — reported and challenged, still blocking (${status.disputed.length}):\n`
       + `${list(status.disputed)}\n`
       + '    One challenger labels a finding disputed however many reported it.\n'
       + '    Decide it — record `declined` with the challenger\'s reasoning, or fix it.\n';
}
if (status.other.length) {
  out += `  UNCLASSIFIED — blocking and unsettled, matching no bucket (${status.other.length}):\n`
       + `${list(status.other)}\n`
       + '    This should be unreachable. Treat it as a bug in the stop condition,\n'
       + '    and decide the findings on their merits meanwhile.\n';
}
if (status.regressed.length) out += `  REGRESSED — recorded fixed, reported again (${status.regressed.length}):\n${list(status.regressed)}\n`;
if (status.unverified.length) {
  out += `  recorded fixed against THIS report, not yet re-observed (${status.unverified.length}):\n`
       + `${list(status.unverified)}\n`
       + '    Verify these (Phase 9) and re-synthesize. They are not regressions.\n';
}
if (status.settled.length)   out += `  settled in an earlier iteration, not counted (${status.settled.length}):\n${list(status.settled)}\n`;
process.stdout.write(out);

if (status.done) process.exit(0);
process.exit(status.capped ? 3 : 1);
