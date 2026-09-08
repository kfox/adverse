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

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { parseBridgeArgs, readJson, usage } from './bridge-io.mjs';
import { importFromSrc } from './package-root.mjs';

const {
  checkBinding, clipReason, convergenceStatus, emptyLedger, loadLedger, recordDecisions,
  saveLedger, summarizeDispositions,
} = await importFromSrc('ledger.mjs');
const { resolveRef, makeAnchorTracer } = await importFromSrc('trace.mjs');

const USAGE = 'Usage:\n'
  + '  converge.mjs --ledger L.json --record decisions.json --report report.json --repo DIR --at REVIEWED_REF [--base REF]\n'
  + '  converge.mjs --ledger L.json --report report.json --repo DIR [--head REF] [--max-iterations N]\n';

const { values } = parseBridgeArgs({
  prefix: 'converge',
  usage: USAGE,
  options: {
    report:  { type: 'string' },
    ledger:  { type: 'string' },
    record:  { type: 'string' },
    repo:    { type: 'string' },
    head:    { type: 'string' },
    at:      { type: 'string' },
    base:    { type: 'string' },
    'max-iterations': { type: 'string' },
  },
  strict: true,
});

if (!values.ledger) {
  usage(USAGE);
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
  const payload = readJson(values.record, 'converge');
  const decisions = Array.isArray(payload) ? payload : payload.decisions ?? [];

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
  // The report is now READ, not only hashed. Its findings carry `reporters`,
  // the review lanes that filed each one, and that is the one place those
  // lanes are on record: `recordDecisions` derives each entry's `reporters`
  // from it so a regression pass can look up the lanes that must not review a
  // fix commit, instead of the orchestrator that wrote the commit typing them
  // (kfox/adverse#58, item 6).
  const report = values.report ? readJson(values.report, 'converge') : null;
  if (!values.report) {
    process.stderr.write(
      'converge: --record without --report. These decisions will not name the\n'
      + '  report they answered, so the next check cannot tell "not yet verified"\n'
      + '  from "the fix did not take" and will report them REGRESSED. They will\n'
      + '  also name no reporting lane, so a regression pass on these fix commits\n'
      + '  cannot derive who must not run it.\n');
  }

  let next;
  try {
    next = recordDecisions(ledger, decisions, { atCommit, reportDigest, report });
  } catch (e) {
    process.stderr.write(`converge: ${e.message}\n`);
    process.exit(2);
  }
  // decisions.json carries no `base` field (SKILL.md Phase 7) — the repo's
  // pinned base comes from the CLI, the same way triage.mjs already takes it.
  next.base ??= values.base ?? null;
  saveLedger(values.ledger, next);
  // recordDecisions derived the iteration number itself; read back what it
  // used rather than computing (ledger.iterations ?? []).length + 1 a second
  // time — the two copies had already drifted once.
  const iteration = next.iterations.at(-1).n;
  // Derived from DISPOSITIONS, not retyped: this was a hand-typed
  // `fixed · declined · deferred` in two bridges, and both stopped counting
  // everything the moment a fourth disposition existed. It also marks which
  // dispositions settle, since that is what this write just did to the loop.
  process.stdout.write(
    `iteration ${iteration}: recorded ${decisions.length} decision(s) -> ${values.ledger}\n`
    + `  ${summarizeDispositions(decisions)}\n`);
  process.exit(0);
}

// --- status mode -------------------------------------------------------------

if (!values.report) {
  process.stderr.write('converge: --report is required unless --record is given\n');
  process.exit(2);
}

const report = readJson(values.report, 'converge');

// Positions in the ledger were recorded against the commit the decision was
// made at; re-project each one to `head` before matching, or a fix that shifted
// the file makes every past decision look like a different finding.
const traceFor = makeAnchorTracer({ repo, to: head });

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
let status;
try {
  status = convergenceStatus(report, ledger ?? emptyLedger(), traceFor,
    { ...capOption, reportDigest: digest(values.report) });
} catch (e) {
  // Exit 2, not a stack trace on exit 1: exit 1 means "findings still open",
  // which is a claim about a review this run could not read.
  process.stderr.write(`converge: ${e.message}\n`);
  process.exit(2);
}

// Everything below renders strings out of report.json — an untrusted file read
// off disk — as PLAIN TEXT to stdout, which is what the Skill tells the
// orchestrating agent to read and act on. `clipReason` bounds length and strips
// control bytes but deliberately keeps newlines, because a `reason` is prose
// and JSON-escaping contains it in briefing.json. Here there is no JSON to
// escape it: a newline ends the line and the next one can look like the tool
// speaking. So every interpolated value is also flattened to one line.
const oneLine = (v) => clipReason(String(v ?? '')).replace(/\s+/g, ' ').trim();

const list = (fs) => fs.map((f) => `    - [${oneLine(f.severity)}·${oneLine(f.kind)}] ${oneLine(f.title)}`
  + (f.file ? ` (${oneLine(f.file)}${f.line !== null && f.line !== undefined ? `:${oneLine(f.line)}` : ''})` : '')).join('\n');

let out = `iteration ${status.iteration} of at most ${status.maxIterations}: ${status.reason}\n`;
// Both lists come out of report.json, which is read off disk under the same
// threat model as the ledger — and this output is what the Skill tells the
// orchestrating agent to read and act on. Rendering them raw put an unbounded,
// newline-carrying channel directly above the real findings; every other
// disk-read string in this tool goes through `clipReason`, and these are no
// different. A lane name that needs 500 characters is not a lane name.
// A lane name is a persona token — `adversary`, `steward`. Bounded tightly so
// a long string cannot dominate the block it is listed in.
const MAX_LANE_NAME = 40;
const lane = (l) => {
  const name = oneLine(l?.persona ?? l);
  return name.length > MAX_LANE_NAME ? `${name.slice(0, MAX_LANE_NAME)}…` : name;
};
const MAX_LANES_LISTED = 8;
const laneList = (ls) => ls.slice(0, MAX_LANES_LISTED).map((l) => `    - ${lane(l)}`
  + (l?.reason ? ` — ${oneLine(l.reason)}` : '')).join('\n')
  + (ls.length > MAX_LANES_LISTED ? `\n    … and ${ls.length - MAX_LANES_LISTED} more` : '');

if (status.degraded.length) {
  out += `  LANES THAT FAILED — they reviewed nothing (${status.degraded.length}):\n`
       + `${laneList(status.degraded)}\n`
       + '    A lane that failed did not find nothing; it did not look. Re-run it.\n'
       + '    If it fails again, record the iteration anyway (--record with the\n'
       + '    decisions you have — an empty list is valid) so the cap can fire. Only\n'
       + '    --record advances the counter, and "re-run it" alone never terminates.\n';
}
if (status.skipped.length) {
  out += `  lanes not run (${status.skipped.length}):\n${laneList(status.skipped)}\n`;
}
if (status.open.length)      out += `  still open (${status.open.length}):\n${list(status.open)}\n`;
if (status.unexamined.length) {
  out += `  NOT CROSS-EXAMINED — blocking, and no round 2 adjudicated them (${status.unexamined.length}):\n`
       + `${list(status.unexamined)}\n`
       + '    These do not count as credible, but they do not count as absent either.\n'
       + '    Record a decision on each (Phase 7). A round 2 can inform that decision,\n'
       + '    but it cannot settle one — only --record advances the iteration counter.\n';
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
       + '    Either a bug in the stop condition, or a report whose confidence and\n'
       + '    cross_examined fields are off-contract. Decide them on their merits.\n';
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
