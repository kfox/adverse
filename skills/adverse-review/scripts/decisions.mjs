#!/usr/bin/env node
// Skill bridge: turn a batch of fix-agent payloads into the decisions.json
// that `converge.mjs --record` appends to the ledger.
//
//   decisions.mjs --fix run/fix-*.json --report run/report.json --out run/decisions.json
//
// Fold every payload of one iteration in ONE call. The ids minted for
// named-but-not-fixed items number within a payload and carry its batch label,
// so a single call cannot collide with itself; two calls in one iteration are
// simply harder to read back.
//
// Exit codes follow the contract every other bridge here uses: 2 means it never
// read a payload, 1 means it read one that failed the schema.
//
// The named-not-fixed block is echoed to stdout on purpose. Those items are
// exactly the ones that get skimmed — they arrive at the end of a long report,
// about work that was NOT done, while the orchestrator is reconciling several
// reports and preparing a commit — and a channel that only writes them to a
// file the orchestrator forwards without reading is the same footnote in a new
// place.
//
// The settling block beside it is echoed for the opposite reason: those lines
// are the ones with a consequence. `--record` tells the next iteration not to
// re-open a settled question, so the operator forwarding this file has to be
// able to see which entries do that. The counts used to be a hand-typed
// `fixed · declined · deferred` that named none of it and went stale the first
// time a disposition was added.

import { writeFileSync } from 'node:fs';

import { parseBridgeArgs, readJson, usage } from './bridge-io.mjs';
import { importFromSrc } from './package-root.mjs';

const {
  NAMED_NOT_FIXED_DISPOSITION, foldFixPayloads, reconciliations,
} = await importFromSrc('decisions.mjs');
const {
  clipReason, isSettled, requireFindings, summarizeDispositions,
} = await importFromSrc('ledger.mjs');
const { validateFix } = await importFromSrc('prompts.mjs');

// Everything this bridge prints renders strings read off disk to stdout, which
// is what the Skill tells the orchestrating agent to read and act on.
// `clipReason` bounds length and strips control bytes but keeps newlines,
// because a reason is prose — so flatten too, or a newline ends the line and
// the next one can look like the tool speaking. Defined up here because the
// refusals below name the file they read, and a path is no more trustworthy
// than a reason.
const oneLine = (v) => clipReason(String(v ?? '')).replace(/\s+/g, ' ').trim();

// Positionals are fix payloads, so `--fix run/fix-*.json` works — the same
// reason triage.mjs, repair.mjs and verify.mjs take them: strict parsing
// without this throws on the second path the shell expands, and the glob is the
// obvious thing to type.
// `--report` is bracketed because omitting it is a warning rather than a usage
// error — a batch folded without one still records, it just carries the
// briefing's identity fields. Printing it as mandatory here and accepting its
// absence three checks down would be two answers to one question.
const USAGE = 'Usage: decisions.mjs --fix a.json [--fix b.json …] [--briefing briefing.json]'
  + ' [--report report.json]'
  + ' --out decisions.json';

const { values, positionals } = parseBridgeArgs({
  prefix: 'decisions',
  usage: USAGE,
  options: {
    fix: { type: 'string', multiple: true },
    briefing: { type: 'string' },
    report: { type: 'string' },
    out: { type: 'string' },
  },
  strict: true,
  allowPositionals: true,
});

values.fix = [...(values.fix ?? []), ...positionals];
if (!values.fix.length || !values.out) {
  usage(USAGE);
}

const payloads = [];
for (const src of values.fix) {
  const payload = readJson(src, 'decisions');
  const err = validateFix(payload);
  if (err) {
    process.stderr.write(`decisions: ${src}: ${err}\n`);
    process.exit(1);
  }
  payloads.push(payload);
}

// The identity a fix agent copied is the BRIEFING's, and the briefing is
// per-lane while the report is merged. Two lanes reporting one title — the
// cross-validated case — give a briefing entry and a report finding that
// disagree on `kind` and `file`, and it is the report's copy the ledger has to
// carry, because a merged report is what every later pass matches against.
// Keyed on the FLAG, never on the parsed value — `readJson` returns null for a
// file containing the literal `null`, and reading that as "no report was given"
// silences the warning below (the flag WAS passed), skips every correction, and
// prints neither block, so an operator who did everything right gets a clean
// exit over a batch that settles nothing. converge.mjs closes the same hole one
// directory over; this is the sibling that had it too.
//
// Exit 2, not 1, and naming the file: references/convergence-loop.md states the
// rule — exit 1 is a claim about a review, and a run that could not read one
// has no claim to make.
const report = values.report ? readJson(values.report, 'decisions') : null;
if (values.report) {
  try {
    requireFindings(report);
  } catch (e) {
    process.stderr.write(`decisions: ${oneLine(values.report)}: ${e.message}\n`);
    process.exit(2);
  }
} else {
  process.stderr.write(
    'decisions: --report not given, so each decision keeps the identity fields its\n'
    + '  fix agent copied out of the briefing. Where a lane merge moved one of them,\n'
    + '  the decision matches no finding, settles nothing, and\n'
    + '  `converge.mjs --record --report` records it and names it at exit 1.\n'
    + '  Pass --report <report.json> to correct them here.\n');
}

// The briefing is what makes a transposed title catchable: a decision's `id`
// names a briefing entry, and nothing else in this flow ever checks that the
// entry it names is the one the title says. Without it the fold still runs and
// still corrects identities — it just cannot tell a swapped pair from an honest
// one, and it says so rather than leaving the operator to assume otherwise.
//
// A supplied briefing with no usable entries is exit 2, not a quiet skip: it
// was read and it does not describe a briefing, which is the same answer
// `--report` gives for a file that is not a synthesis report. Skipping quietly
// would leave the guard off while the command line said it was on.
const briefing = values.briefing ? readJson(values.briefing, 'decisions') : null;
if (values.briefing) {
  const entries = (briefing?.findings ?? []).filter((e) => e && typeof e.id === 'string' && e.id);
  if (!entries.length) {
    process.stderr.write(`decisions: ${oneLine(values.briefing)}: no briefing entry carries `
      + 'an `id`, so no decision can be bound to one; this is not a briefing.json\n');
    process.exit(2);
  }
} else {
  process.stderr.write(
    'decisions: --briefing not given, so no decision\'s `id` is checked against the\n'
    + '  entry it names. A fix payload that transposes two titles binds by title alone,\n'
    + '  which moves the decision onto the other finding and can settle it. Pass\n'
    + '  --briefing <briefing.json> to check them here.\n');
}

let decisions;
try {
  decisions = foldFixPayloads(payloads, { report, briefing });
} catch (e) {
  // Reachable only if a payload passed validateFix and still cannot become a
  // decision, which would be the two disagreeing rather than a bad payload.
  // Exit 1 either way: something was read and it does not describe repair work.
  // A bad --report is not among them; it was refused above, with exit 2.
  process.stderr.write(`decisions: ${e.message}\n`);
  process.exit(1);
}

writeFileSync(values.out, JSON.stringify({ decisions }, null, 2), 'utf-8');

const where = (d) => (d.file
  ? ` (${oneLine(d.file)}${d.line === null || d.line === undefined ? '' : `:${oneLine(d.line)}`})`
  : '');
const bullet = (d) => `    - [${oneLine(d.id)}] ${oneLine(d.title)}${where(d)}`;

// The counts come from `summarizeDispositions` rather than a hand-typed
// `fixed · declined · deferred`, which is the line that went stale here the
// moment a fourth disposition existed. It also marks which dispositions SETTLE,
// because an operator reading this output has to be able to see which lines
// close a question before forwarding them to `converge.mjs --record`.
let out = `${decisions.length} decision(s) from ${payloads.length} fix payload(s)`
  + ` -> ${values.out}\n`
  + `  ${summarizeDispositions(decisions)}\n`;

// A fold that rewrites the fields a fix agent supplied and says nothing is a
// fold whose output cannot be read back against the payload it came from. All
// three outcomes are printed: what was corrected, what could not be bound to
// the report at all — which is what `converge.mjs --record` is about to name at
// exit 1, said here at the earlier of the two moments the operator can act on
// it — and, under its own heading, the unbound `noted` entries, which record
// cleanly and excuse nothing, because the fold looked and no lane had filed
// them.
//
// Computed whenever EITHER document was given, not only when a report was. The
// three report blocks below are empty without one anyway — nothing binds, so
// nothing is corrected and nothing is accused — but the two briefing blocks do
// not need a report to have something to say: an `id` and a `title` naming
// different findings is the payload contradicting itself, which is checkable
// with the briefing alone. Gated on the report, a `--briefing`-only fold
// printed no signal at all about a transposed pair, while the command line said
// the guard was on. That is the same silence the exit-2 branch above refuses
// for a briefing that parses to nothing.
const changes = report || briefing ? reconciliations(payloads, report, briefing) : [];
const isNamed = (c) => c.disposition === NAMED_NOT_FIXED_DISPOSITION;
const corrected = changes.filter((c) => c.bound);
// Split by CAUSE, not just by boundness. `reconciliations` used to answer
// "did not bind" for two different reasons and this block printed the title
// remedy for both, so an operator holding a byte-identical title and a
// disagreeing `file` was sent to correct the only field that was already right.
const unbound = changes.filter((c) => !c.bound && !isNamed(c) && c.cause === 'title');
const misanchored = changes.filter((c) => !c.bound && !isNamed(c) && c.cause === 'anchor');
// Both briefing causes are listed for EVERY disposition, `noted` included —
// unlike the three above, which split `noted` off under its own gentler
// heading. That heading exists because recording a `noted` entry settles
// nothing; the reasoning does not reach a payload whose own two identity claims
// disagree with each other, which is a mis-citation whatever it was recorded as.
const transposed = changes.filter((c) => c.cause === 'briefing');
const staleIds = changes.filter((c) => c.cause === 'briefing-id');
const unreported = changes.filter((c) => !c.bound && isNamed(c));
if (corrected.length) {
  out += `  identity corrected from the report — the briefing's copy predates a lane`
       + ` merge (${corrected.length}):\n`
       + corrected.map((c) => `    - ${oneLine(c.title)}\n`
           + c.fields.map((f) => `        ${oneLine(f.field)}: ${oneLine(f.from ?? 'none')}`
               + ` -> ${oneLine(f.to ?? 'none')}\n`).join('')).join('');
}
if (unbound.length) {
  // "Settles nothing", not "will be refused": `converge.mjs --record` records
  // the batch and exits 1. An operator told the batch was refused re-runs
  // `--record`, appending it twice and advancing the iteration counter twice —
  // spending the cap the whole loop terminates on. And this bridge takes no
  // `--ledger`, so it cannot apply converge's exemption for an item already on
  // record as `noted`; a claim about what converge will do is one this side
  // cannot make.
  out += `  MATCHES NO FINDING IN THE REPORT — these settle nothing, and`
       + ` \`converge.mjs --record --report\` names them at exit 1 (${unbound.length}):\n`
       + unbound.map((c) => `    - ${oneLine(c.title)} [${oneLine(c.agent)}]\n`).join('')
       + '    A title is how a decision finds the finding it answers, and `fix.txt`\n'
       + '    tells the agent to copy it verbatim. Correct it against report.json.\n';
}
if (transposed.length) {
  // First block and the loudest, because it is the only one of these where the
  // payload's own two identity fields contradict each other — every other cause
  // is a disagreement with a document the agent did not write. Measured on
  // `65bc979`: a transposed pair settled a cross-validated `critical` with a
  // sentence about structure, and the loop reported `done` with nothing open.
  out += `  ID AND TITLE NAME DIFFERENT FINDINGS — these settle nothing, and one of`
       + ` the two fields is wrong (${transposed.length}):\n`
       + transposed.map((c) => `    - ${oneLine(c.title)} [${oneLine(c.agent)}]\n`
           + `        ${oneLine(c.gap)}\n`).join('')
       + '    A fix payload copies both out of the same briefing entry, so these cannot\n'
       + '    both be right. Find which finding was actually decided before recording:\n'
       + '    binding on the title alone would move the decision onto the other one.\n';
}
if (staleIds.length) {
  // Distinct from the block above on purpose. `briefing.mjs` re-mints ids
  // positionally on every triage run, so an id copied out of an earlier
  // iteration's briefing names nothing here — a stale citation, not a swapped
  // pair, and the operator looks in a different place for it.
  out += `  ID NAMES NO BRIEFING ENTRY — these settle nothing (${staleIds.length}):\n`
       + staleIds.map((c) => `    - ${oneLine(c.title)} [${oneLine(c.agent)}]\n`).join('')
       + '    Briefing ids are re-minted every triage run, so one copied from an\n'
       + '    earlier iteration names nothing in this briefing. Check the id against\n'
       + '    briefing.json — the title may well be right.\n';
}
if (misanchored.length) {

  // Its own heading, because the remedy is the opposite one: the title is
  // already verbatim and an anchor the payload STATED disagrees. `c.gap` comes
  // from `identityGap` over `ANCHOR_FIELDS` — the same list `anchorsAgree`
  // guards on — so this can only ever name a field that actually decided the
  // refusal, and never `kind`, which this path corrects on purpose.
  out += `  ANCHOR DISAGREES WITH THE REPORT — the title matches a finding, a stated`
       + ` field does not; these settle nothing (${misanchored.length}):\n`
       + misanchored.map((c) => `    - ${oneLine(c.title)} [${oneLine(c.agent)}]\n`
           + `        ${oneLine(c.gap)}\n`).join('')
       + '    The title is already right. Either the decision was taken on a different\n'
       + '    finding than the one it names, or the anchor was copied from a stale\n'
       + '    briefing — check which against report.json before recording.\n';
}
if (unreported.length) {
  // Its own heading, never folded into the block above: an unbound `noted`
  // entry is not the same accusation. It records fine and settles nothing by
  // design, and it vouches for nothing either — a `noted` entry vouches only
  // when the report CARRIED it (`isSelfIdentified`, src/ledger.mjs), and this
  // block is built from the ones it did not. What reaches the ledger is
  // therefore the batch's own claim about a finding no lane reported, on
  // fields nothing corrected, which is a thing only an operator holding the
  // report can check — which is why it is printed here rather than counted
  // somewhere.
  out += `  UNREPORTED IDENTITY — no finding in the report carries these titles`
       + ` (${unreported.length}):\n`
       + unreported.map((c) => `    - ${oneLine(c.title)} [${oneLine(c.agent)}]\n`).join('')
       + `    Recorded ${NAMED_NOT_FIXED_DISPOSITION}, which settles nothing — and excuses nothing`
       + ' either.\n'
       + '    The fold checked each of these against the report and no lane had filed it,\n'
       + '    which is the one fact `--record`\'s SETTLES NOTHING check withholds its\n'
       + '    exemption on: a later decision whose only cover is one of these entries is\n'
       + '    named there anyway (`isSelfIdentified`, src/ledger.mjs). So what reaches the\n'
       + '    ledger is this batch\'s own claim about a finding no lane reported, on fields\n'
       + '    nothing corrected. Read each line against report.json before you record it:\n'
       + '    an item no lane filed is either a finding none of them has reported yet, or\n'
       + '    this title mis-citing one that was.\n';
}

// Named as settling, and listed, because that is the whole of what --record
// does that cannot be undone: a settling entry tells the next iteration not to
// re-open the question. This block exists so the answer to "what did I just
// close?" is on screen rather than in the JSON.
const settling = decisions.filter((d) => isSettled(d.disposition));
if (settling.length) {
  out += `  SETTLES A QUESTION — the next iteration is told not to re-open these`
       + ` (${settling.length}):\n`
       + settling.map((d) => `${bullet(d)} [${oneLine(d.disposition)}]`).join('\n') + '\n';
}

const named = decisions.filter((d) => d.disposition === NAMED_NOT_FIXED_DISPOSITION);
if (named.length) {
  out += `  NAMED, NOT FIXED — recorded ${NAMED_NOT_FIXED_DISPOSITION}, which settles`
       + ` nothing, each with the agent's own reasoning (${named.length}):\n`
       + named.map((d) => `${bullet(d)}\n        ${oneLine(d.reason)}`).join('\n') + '\n'
       + '    These are findings with no ID, and nothing here closes one. Read them\n'
       + '    before you record: an item left unrecorded costs a full review round\n'
       + '    of the next iteration, and one recorded still needs deciding.\n';
}
process.stdout.write(out);
