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
//
// In --record mode the same three codes mean the record's own outcome: 0 =
// recorded, 2 = nothing was written, 1 = recorded, and something about it does
// not hold up — a decision that settles nothing (kfox/adverse#58, item 1), or
// a `fixed` whose commit does not support the claim (item 2). Exit 1 is NOT a
// refusal — the ledger has the batch and the iteration counter has advanced,
// because a branch that does not record makes the cap unreachable and the loop
// non-terminating. Each check prints its own named block, so "which one" is
// read off stderr rather than guessed from the code.
//
// One check on this path does refuse, at exit 2 with nothing written: the
// prospective ledger is put through `checkBinding` before it is saved, because
// a ledger this tool will not read back is the one write it cannot take back.
// See "Never write a ledger this tool will refuse to read" below.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { oneLine, parseBridgeArgs, readJson, usage } from './bridge-io.mjs';
import { importFromSrc } from './package-root.mjs';

const {
  FIX_SUPPORT, UNREPORTED_DISPOSITION, checkBinding, convergenceStatus,
  emptyLedger, loadLedger, recordDecisions, requireFindings, saveLedger,
  summarizeDispositions, uncoveredDecisions, unsupportedFixes,
} = await importFromSrc('ledger.mjs');
const { filesChangedIn, makeAnchorTracer, resolveRef } = await importFromSrc('trace.mjs');

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

// The decisions a `--record` payload carries, in either documented shape — the
// `{ decisions: [...] }` object decisions.mjs writes, or the bare array
// references/convergence-loop.md teaches an operator to hand-write — or null
// for a document that is neither.
//
// Null rather than an empty list, and the caller refuses on it, because this is
// `requireFindings`' rule applied to the file beside the report: "I could not
// find the decisions" must not be spelled the same way as "there were none".
// An empty batch IS legitimate and stays so — the loop reference instructs one
// when every lane failed — which is exactly why the two must be told apart
// here. Both halves of the confusion were live: a document holding the literal
// `null` died on `payload.decisions` with an uncaught TypeError at exit 1 —
// the record-mode code that means the batch IS in the ledger — while nothing
// had been written; and `{}`, `5`, `"hello"` and a report.json passed by
// mistake each recorded a whole empty iteration at exit 0 and said nothing.
function decisionsIn(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.decisions)) return payload.decisions;
  return null;
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

const resolveHere = (ref) => resolveRef(repo, ref);

// One rendering of a `checkBinding` refusal, for the two places that make one:
// the ledger read at startup, and the ledger about to be written below. Every
// problem is flattened and clipped like every other disk-read string this tool
// prints — `checkBinding` interpolates an entry's `atCommit` and `fixCommit`
// verbatim, and those come off the same untrusted JSON as a `reason`, so a ref
// carrying a newline could otherwise forge a line of this tool's own output.
function refuseBinding(problems, lead, tail = '') {
  process.stderr.write(`converge: ${lead}\n`
    + problems.map((p) => `  - ${oneLine(p)}\n`).join('')
    + tail);
  process.exit(2);
}

// A ledger naming another repository used to load and adjudicate findings it
// had never seen — loadLedger checks only `version`. Commits cannot be faked
// across repositories, so they are the binding.
const bindingProblems = checkBinding(ledger, resolveHere);
if (bindingProblems.length) {
  refuseBinding(bindingProblems, 'this ledger does not belong to this repository:');
}

// --- record mode -------------------------------------------------------------

if (values.record) {
  const decisions = decisionsIn(readJson(values.record, 'converge'));
  if (decisions === null) {
    process.stderr.write(`converge: ${oneLine(values.record)}: this is not a decisions `
      + 'document — it carries no `decisions` array and is not one itself. Pass the file\n'
      + '  `decisions.mjs --out` wrote, or a bare array. An empty batch is spelled\n'
      + '  `{"decisions": []}` and is recorded like any other.\n');
    process.exit(2);
  }

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
      + '  cannot derive who must not run it. And an entry recorded\n'
      + `  ${UNREPORTED_DISPOSITION} keeps its exemption: this ledger withholds that only\n`
      + '  where the fold checked the identity against a report and no lane had filed\n'
      + '  it, so a batch folded without one can excuse its own next decision.\n');
  }

  // Computed BEFORE the write, because it is the report these decisions answer
  // that says whether they can settle anything, and reported AFTER it, because
  // the batch is recorded either way (kfox/adverse#58, item 1).
  //
  // Keyed on the FLAG, not on the parsed value: a report.json containing the
  // literal `null` parses to null, which `report ?` and `recordDecisions`'
  // `report !== null` both read as "no report was given" — so the run recorded
  // a whole iteration with `reporters: []` on every entry, a real
  // `reportDigest` beside them, and exit 0. That is the failure both of those
  // guards exist to stop, spelled with a file instead of an argument.
  let uncovered = [];
  try {
    if (values.report) uncovered = uncoveredDecisions(decisions, report, { ledger });
  } catch (e) {
    process.stderr.write(`converge: ${oneLine(values.report)}: ${e.message}\n`);
    process.exit(2);
  }

  // Needs no report — it asks git what a commit changed, not what a panel
  // filed — so unlike the check above it runs on every `--record`, including
  // the ones that pass no `--report` at all.
  //
  // Wrapped, and at exit 2. This became the FIRST pass over `decisions`, and
  // it sat outside the guard that had covered every other one: a decisions.json
  // holding `[null]` used to reach `recordDecisions` and get the clean "nothing
  // was written" refusal, and instead died here with an uncaught TypeError at
  // exit 1 — the record-mode code that means the batch IS in the ledger. The
  // stack said otherwise and nothing was written, which is precisely the pair
  // of claims the exit codes exist to keep apart.
  let unsupported = [];
  try {
    unsupported = unsupportedFixes(decisions, (ref) => filesChangedIn(repo, ref));
  } catch (e) {
    process.stderr.write(`converge: ${oneLine(values.record)}: ${e.message}\n`);
    process.exit(2);
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

  // Never write a ledger this tool will refuse to read.
  //
  // `checkBinding` gates BOTH modes at startup, above, and `--record` used to
  // validate none of its predicates against the ledger it was about to write.
  // Four ways in, none needing an attacker: a `fixCommit` that resolves nowhere
  // (`git commit --amend`, a squash before merge, an abbreviated sha that
  // stopped being unique), an `--at` or a `--base` that is not a commit here —
  // neither is resolved anywhere else on this path — and a batch that carries
  // the ledger past the entry cap. The ledger is append-only and this tool has
  // no repair mode, so such a write is permanent: every later invocation, status
  // and `--record` alike, exits 2 before doing anything, the iteration counter
  // freezes where it stands, and the cap can never fire. Checked against `next`
  // rather than a special case per predicate, because the predicates belong to
  // `checkBinding` and a copy here would drift from them.
  //
  // This REFUSES where every other check on this path records anyway, and the
  // inversion is deliberate — assume it was, rather than that it was written
  // backwards. The standing doctrine is right for the others: only `--record`
  // advances the counter, so a check that stopped the write would make the cap
  // unreachable. It is inverted here because RECORDING is the action that stops
  // the counter forever. Refusing writes nothing, so the operator corrects one
  // sha in decisions.json — a per-iteration input references/convergence-loop.md
  // already tells them to correct by hand — or one argument, records again, and
  // THAT advances the counter.
  //
  // A reviewer proposed recording the batch with the offending entry's
  // `fixCommit` nulled and its reason kept, so the counter advances. Weighed and
  // declined: it writes a permanently unverifiable `fixed` claim into an
  // append-only file, which is the exact silence the `fixed`-claim check exists
  // to break, and it closes one of the four ways in. Its real point stands —
  // refusing trades a permanent brick for a recoverable livelock — and the trade
  // is worth it only because a livelock needs an operator or agent that keeps
  // supplying the same bad ref and is loud at exit 2 every time, while the brick
  // arrives by accident, once, in silence.
  const wouldRefuse = checkBinding(next, resolveHere);
  if (wouldRefuse.length) {
    // Selected on the branch `unsupportedFixes` reports, not on the wording of
    // its message: the remedy for this one names a file to edit, and the others
    // name an argument.
    const unresolvedFixes = unsupported.filter((u) => u.status === FIX_SUPPORT.UNRESOLVED);
    refuseBinding(wouldRefuse,
      'REFUSING TO RECORD — this ledger would be unreadable from the next run on:',
      (unresolvedFixes.length
        ? `  ${unresolvedFixes.length} \`fixed\` decision(s) name a commit that resolves `
          + `nowhere: ${unresolvedFixes.map((u) => oneLine(u.commit)).join(', ')}.\n`
        : '')
      + '  NOTHING was written and the iteration counter did not advance. This is the\n'
      + '  one check here that refuses instead of recording: the ledger is append-only\n'
      + '  and this tool has no repair mode, so a ledger that fails this check is\n'
      + '  refused by every later run, at exit 2, with no way back. Correct the input —\n'
      + `  ${oneLine(values.record)} is a per-iteration file meant to be corrected by\n`
      + '  hand, and --at and --base are arguments — then record again. That record\n'
      + '  advances the counter.\n');
  }

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

  // Its own block with its own heading, in the shape the other unskippable
  // blocks in this tool use, because the whole point is that a decision
  // settling nothing looks exactly like one that settled something.
  if (uncovered.length) {
    process.stderr.write(
      // No `of ${decisions.length}`: the check skips `noted` decisions and
      // ones already on record, so that denominator counts entries this line
      // never examined and reads as a pass rate over the wrong batch.
      `converge: SETTLES NOTHING — ${uncovered.length} decision(s) match no `
      + `finding in ${oneLine(values.report)}, and none already recorded as `
      + `${UNREPORTED_DISPOSITION}:\n`
      + uncovered.map((u) => `  - [${oneLine(u.disposition)}] ${oneLine(u.title)}\n`
                           + `      ${oneLine(u.why)}\n`).join('')
      + '  Recorded anyway — only --record advances the iteration counter, and a\n'
      + '  branch that does not record makes the cap unreachable. But each of these\n'
      + '  decides nothing: the finding it answers is re-raised next iteration, or\n'
      + '  holds the loop open until the cap. A decision settles a finding when its\n'
      + '  title, kind and file are the report\'s — and for a contract finding, its\n'
      + '  counterpart too. `decisions.mjs --report` corrects those off report.json\n'
      + '  for a folded batch; a hand-written decision has to be corrected by hand,\n'
      + '  and re-recorded as a second entry.\n');
  }

  // Its own block beside that one, never folded into it. The two are different
  // accusations about different halves of a decision — one says it answers no
  // finding, the other says it made no change — and a batch can trip both, on
  // different entries or on the same one.
  if (unsupported.length) {
    process.stderr.write(
      `converge: FIX NOT SUPPORTED BY ITS COMMIT — ${unsupported.length} `
      + `\`fixed\` decision(s):\n`
      + unsupported.map((u) => `  - ${oneLine(u.title)}`
                             + `${u.commit ? ` [${oneLine(u.commit)}]` : ''}\n`
                             + `      ${oneLine(u.why)}\n`).join('')
      + '  Recorded anyway, and a fix in another file is often the right one — a\n'
      + '  root cause rarely sits where the symptom was reported. But `fixed` is\n'
      + '  the one disposition that asserts a code change, and next iteration one\n'
      + '  of these coming back is announced as REGRESSED: whoever reads that goes\n'
      + '  looking for a fix that broke, not for a fix that was never made. If the\n'
      + '  change is real and lives elsewhere, say where in the reason. If it is\n'
      + '  not, this is `declined` or `deferred`.\n');
  }

  process.exit(uncovered.length || unsupported.length ? 1 : 0);
}

// --- status mode -------------------------------------------------------------

if (!values.report) {
  process.stderr.write('converge: --report is required unless --record is given\n');
  process.exit(2);
}

const report = readJson(values.report, 'converge');

// Same refusal record mode makes, in the same words. Without it a `report.json`
// holding the literal `null` reached `convergenceStatus` and came back out as
// `Cannot read properties of null (reading 'findings')` — the right exit code
// attached to a sentence that names neither the file nor what is wrong with it.
try {
  requireFindings(report);
} catch (e) {
  process.stderr.write(`converge: ${oneLine(values.report)}: ${e.message}\n`);
  process.exit(2);
}

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

const list = (fs) => fs.map((f) => `    - [${oneLine(f.severity)}·${oneLine(f.kind)}] ${oneLine(f.title)}`
  + (f.file ? ` (${oneLine(f.file)}${f.line !== null && f.line !== undefined ? `:${oneLine(f.line)}` : ''})` : '')).join('\n');

let out = `iteration ${status.iteration} of at most ${status.maxIterations}: ${status.reason}\n`;
// Both lists come out of report.json, which is read off disk under the same
// threat model as the ledger — and this output is what the Skill tells the
// orchestrating agent to read and act on. Rendering them raw put an unbounded,
// newline-carrying channel directly above the real findings; every other
// disk-read string in this tool goes through `clipReason`, and these are no
// different. A lane name that needs `MAX_REASON_CHARS` (src/limits.mjs) worth
// of characters is not a lane name — named as the constant rather than typed
// as its value, because this file has no generated-copy drift test behind it,
// so a number spelled here goes silently false the day the cap moves.
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
