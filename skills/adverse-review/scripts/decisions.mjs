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
// Exit codes follow the contract every other bridge here uses: 1 means it read
// a payload it cannot fold, and 2 means it never got that far — or, at the very
// end, that it could not write what it folded. The two ends of 2 have the same
// consequence, which is what the code means here: nothing was recorded. The
// schema is one way to earn a 1; a payload whose `id` and `title` name different
// briefing entries is the other, and that one leaves no output file behind.
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

import { rmSync, statSync } from 'node:fs';

import { oneLine, parseBridgeArgs, readJson, usage, writeOutput } from './bridge-io.mjs';
import { importFromSrc } from './package-root.mjs';

const {
  NAMED_NOT_FIXED_DISPOSITION, briefingEntries, foldFixPayloads, reconciliations,
  transpositionCause,
} = await importFromSrc('decisions.mjs');
const {
  isSettled, requireFindings, summarizeDispositions,
} = await importFromSrc('ledger.mjs');
const { validateFix } = await importFromSrc('prompts.mjs');

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

// Every exit in this file below this line leaves `--out` unwritten, and the
// loop folds each iteration to ONE fixed path
// (references/convergence-loop.md), so a run that refuses without touching that
// path leaves the PREVIOUS iteration's complete batch sitting exactly where
// stdout says nothing was written. `converge.mjs --record` has no dedup against
// a batch it already recorded, so an operator following the output appends
// iteration N-1 a second time: the counter the cap terminates on advances, its
// findings are re-settled, and this iteration's payloads are never recorded.
//
// Claimed HERE, in one place, rather than in each refusal — the first draft of
// this fix wrapped the refusals it knew about and left the three `readJson`
// exits, which are in bridge-io.mjs and exit before any of this file's code
// runs. A truncated fix payload is a likelier refusal than a transposed pair,
// so the fix that covers only the paths this file spells out covers the
// unlikely half. The parse is the last thing that can refuse before `--out` is
// known, and everything after it is this bridge's, so this is the earliest
// point where one claim covers every exit — including one added later.
//
// Refusing when the file cannot be removed, rather than warning: this bridge
// writes that path on every run that finishes, so a path it cannot clear is one
// it could not have written either, and the alternative is a run that reports a
// fold nobody can read back.
//
// The removal is announced on the way out rather than here — see the notice
// below, which says why the moment of removal is the one place it cannot be
// said from.
//
// And it refuses an `--out` that IS one of this run's own inputs before
// removing anything. Unconditionally clearing a caller-supplied path makes the
// first effect of the process a delete, so `--report r.json --out r.json`
// destroyed the report and then failed to read it: an operator left with
// neither a fold nor their input, from a typo that used to complete.
//
// Identity, not spelling. `path.resolve` normalizes `.`, `..` and separators
// and resolves neither symlinks nor case, so three ordinary shapes of that same
// typo walked past a string comparison and deleted the input anyway: a
// case-different `--out` on a case-insensitive filesystem, a path through a
// symlinked directory, and `/tmp` against `/private/tmp` — which is not exotic,
// it is where the loop's own run directory lives on macOS. Two names for one
// file is the whole question here, and `dev`/`ino` is what answers it.
//
// `bigint: true` because Node documents the Number form of `ino` as inaccurate
// above 2^53, and a filesystem that issues inode numbers that large would make
// two distinct files compare equal — refusing a legitimate fold, which stalls
// the loop rather than losing a file, but for no reason a flag does not remove.
function identity(file) {
  try {
    const s = statSync(file, { bigint: true });
    return `${s.dev}:${s.ino}`;
  } catch (e) {
    // A path that is not there has no identity to share — `--out` usually does
    // not exist on the first fold, and an input that is missing is `readJson`'s
    // refusal a moment later, with a better sentence than this one.
    if (e.code === 'ENOENT') return null;
    // Anything else is "cannot tell", and this function does not get to spell
    // that the same way as "a different file": the next thing the bridge does is
    // delete `--out`. It throws rather than returning a benign default, because
    // the benign default here is the deletion this whole claim guards.
    throw e;
  }
}

// `--out` gets no sentence of its own when it cannot be stat-ed. `rmSync` below
// is about to hit the same wall and says so as "cannot be claimed for this run",
// which names the flag the operator typed; a message from here instead asked
// whether `--out` was `--out` — `--out blocker/decisions.json` against a regular
// file named `blocker` reported ENOTDIR as a question about aliasing.
function outIdentity() {
  try {
    return identity(values.out);
  } catch {
    return null;
  }
}

function claimOut(inputs) {
  const target = outIdentity();
  const alias = target === null ? undefined : inputs.find((f) => {
    try {
      return identity(f) === target;
    } catch (e) {
      refuse(2, `decisions: ${oneLine(f)}: cannot be identified (${oneLine(e.code)}), so this`
        + ` run cannot tell whether it is the file --out names (${oneLine(values.out)}) — which`
        + ' it is about to remove\n');
    }
    return false;
  });
  if (alias) {
    process.stderr.write(`decisions: --out ${oneLine(values.out)} is an input of this run`
      + ` (${oneLine(alias)}). This bridge claims --out before reading anything, so folding`
      + ' there would destroy the file it is folding from\n');
    process.exit(2);
  }
  try {
    rmSync(values.out);
  } catch (e) {
    if (e.code === 'ENOENT') return false;
    process.stderr.write(`decisions: ${oneLine(values.out)}: cannot be claimed for this run`
      + ` (${oneLine(e.code)}). A batch a previous fold left there would still be on disk`
      + ' after a refusal, and `converge.mjs --record` would append it a second time\n');
    process.exit(2);
  }
  return true;
}

const clearedOut = claimOut([...values.fix, values.report, values.briefing].filter(Boolean));

let wrote = false;

// Gated on whether the fold WROTE, not on the exit code. The two are not the
// same question and reading the second one inverts the notice: every exit after
// the write is nonzero for its own reasons — an EPIPE on stdout when the caller
// closed the pipe is enough — and at that point a complete batch is on disk and
// the operator is being told nothing was recorded. That is the exact claim this
// notice exists to prevent, printed by the notice.
function announceUnrecorded() {
  if (!clearedOut || wrote) return;
  process.stderr.write(`decisions: a file already at ${oneLine(values.out)} was removed when`
    + ' this run started, and this run wrote nothing: nothing it refused has been recorded\n');
}

// Said on the way out, and only when this run is leaving without writing.
//
// The notice belongs to the REFUSAL, not to the removal: every fold after the
// first overwrites a file that was already there, so announced at the moment of
// removal it printed "removed, nothing recorded" on stderr in front of every
// successful run's own report of the batch it had just written — on the channel
// the Skill tells the orchestrating agent to read and act on. But it cannot be
// printed from `refuse` either: three of the exits it exists to cover are
// `readJson`'s, in bridge-io.mjs, which never reach anything in this file.
//
// It says a FILE was removed rather than a batch, because that is all this
// bridge checked. `--out` pointed at something else entirely is the operator's
// own mistake and gets the truth about it, not a sentence inventing a previous
// fold.
// A signal gets no notice, and deliberately not: Node runs no `exit` handler
// for one, and a `SIGTERM` listener added to say this cannot run either — every
// blocking moment of this bridge is a synchronous `readFileSync`, and libuv
// delivers a signal to JS on an event loop turn that a blocking read is not
// taking. Measured: a run blocked reading a FIFO ignores SIGTERM with such a
// listener installed and needs SIGKILL (137), where the same run without one
// dies on the signal (143). The listener does not add the notice; it takes away
// the operator's ability to stop the bridge, and this loop's ordinary killers
// are timeouts. #119 is the version of this that leaves the previous batch
// itself behind instead of a sentence about it.
process.on('exit', announceUnrecorded);

function refuse(code, message) {
  process.stderr.write(message);
  process.exit(code);
}

const payloads = [];
for (const src of values.fix) {
  const payload = readJson(src, 'decisions');
  const err = validateFix(payload);
  if (err) {
    refuse(1, `decisions: ${src}: ${err}\n`);
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
    refuse(2, `decisions: ${oneLine(values.report)}: ${e.message}\n`);
  }
} else {
  process.stderr.write(
    'decisions: --report not given, so each decision keeps the identity fields its\n'
    + '  fix agent copied out of the briefing. Where a lane merge moved one of them,\n'
    + '  the decision matches no finding, settles nothing, and\n'
    + '  `converge.mjs --record --report` records it and names it at exit 1.\n'
    + `  And every ${NAMED_NOT_FIXED_DISPOSITION} entry this fold mints records\n`
    + '  `reconciled: null`, which the ledger still lets EXCUSE the next decision that\n'
    + '  matches it: the exemption is withheld only where the fold checked the identity\n'
    + '  against a report and no lane had filed it. Folding without one leaves this\n'
    + '  batch able to excuse its own next decision, and nothing downstream can tell.\n'
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
//
// `briefingEntries` is the same list `briefingIndex` binds against, imported
// rather than spelled again here. Hand-copied, this predicate assumed an array
// where its `--report` sibling ten lines up does not: a briefing whose
// `findings` is an OBJECT reached the fold and died on a raw `TypeError` at
// exit 1 — a claim about a review, made by a run that never read one.
const briefing = values.briefing ? readJson(values.briefing, 'decisions') : null;
if (values.briefing) {
  let entries = [];
  try {
    entries = briefingEntries(briefing);
  } catch (e) {
    refuse(2, `decisions: ${oneLine(values.briefing)}: ${e.message}\n`);
  }
  if (!entries.length) {
    refuse(2, `decisions: ${oneLine(values.briefing)}: no briefing entry carries `
      + 'both an `id` and a `title`, so no decision can be bound to one and checked'
      + ' against it; this is not a briefing.json\n');
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
  refuse(1, `decisions: ${e.message}\n`);
}

// Reconciled BEFORE the output file exists, because one of the answers it
// returns is that there must not be one.
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
// Both briefing causes are read for every disposition whose schema ASKS for an
// id — `fixed` and `declined` — unlike the report causes below, which split
// `noted` off under its own gentler heading. That heading exists because
// recording a `noted` entry settles nothing; the reasoning does not reach a
// payload whose own two identity claims disagree with each other, which is a
// mis-citation whatever it was recorded as.
//
// `named_not_fixed` makes only one identity claim, because its schema has no
// `id` field to make the other with, so it has nothing to contradict itself
// about. An `id` on one of those items is an extra key `validateFix` tolerates,
// and reading it as a claim put a stray key one keystroke from refusing a whole
// batch — see `bindingFor`'s `statesId` (src/decisions.mjs).
const transposed = changes.filter((c) => c.cause === 'briefing');

// The extra paragraph for a batch where EVERY citation disagrees, keyed on what
// `transpositionCause` could establish. Neither answer contradicts the refusal
// above; they say which file to open first, which is the whole cost of getting
// this wrong.
const TRANSPOSITION_CAUSE = {
  briefing:
    '    EVERY id here disagrees, and not one of these titles is in this briefing\n'
    + '    at all — so this is more likely to be one wrong --briefing than one wrong\n'
    + '    payload per citation. Triage re-mints ids positionally on every run and\n'
    + '    writes them to the same path. Check that this briefing.json is the one\n'
    + '    these payloads were authored against before correcting anything in them.\n',
  either:
    '    EVERY id here disagrees, and every one of these titles IS in this briefing,\n'
    + '    under another id. Two inputs look exactly like this and nothing here tells\n'
    + '    them apart: a briefing from another iteration, whose ids triage re-mints\n'
    + '    positionally on every run, and a payload that paired two entries with each\n'
    + '    other\'s ids. Check first whether this briefing.json is the one these\n'
    + '    payloads were authored against — if it is, the pairs in the payload are\n'
    + '    swapped; if it is not, its ids are.\n',
  null: '',
};

// A transposed pair is the one answer this bridge REFUSES on, and the refusal
// is why the check exists rather than being the check's report of itself.
//
// It used to print the block and exit 0 over a written decisions.json, on the
// grounds that the decision binds to nothing and so settles nothing. That is
// true of THIS fold and not of the file it leaves behind: `converge.mjs`
// takes no `--briefing`, so `--record` binds the entry by title — and the
// title is one of the two fields that is wrong. Measured both directions on
// `1eb767f`: a `declined` carrying a critical's `id` and an advisory's title
// settled the advisory, and the same pair the other way round settles the
// critical with a sentence about structure. Neither is a fold anyone asked
// for, and there is no third field to break the tie, so there is no correct
// output here — only an operator who has to find out which finding was
// actually decided.
if (transposed.length) {
  process.stdout.write(`${payloads.length} fix payload(s) NOT folded — nothing written to`
    + ` ${oneLine(values.out)}\n`
    + `  ID AND TITLE NAME DIFFERENT FINDINGS — one of the two fields is wrong`
    + ` (${transposed.length}):\n`
    + transposed.map((c) => `    - ${oneLine(c.title)} [${oneLine(c.agent)}]\n`
        + `        ${oneLine(c.gap)}\n`).join('')
    + '    A fix payload copies both out of the same briefing entry, so these cannot\n'
    + '    both be right. Find which finding was actually decided and correct the\n'
    + '    payload: `converge.mjs --record` takes no --briefing, so it would bind\n'
    + '    each of these by its title and settle whichever finding that names.\n'
    + TRANSPOSITION_CAUSE[transpositionCause(changes, payloads, briefing)]);
  refuse(1, 'decisions: a payload contradicts its own identity claims; refusing to fold it\n');
}

// Through the shared write, for the same reason every other bridge's output
// goes through it: this bridge claimed `--out` before reading anything, and a
// symlink planted at it in the meantime would otherwise be followed — the class
// this run's own claim is about, one step further along the same path. It
// refuses at exit 2 rather than returning, so `wrote` stays false and the notice
// above still tells the truth.
writeOutput('decisions', values.out, JSON.stringify({ decisions }, null, 2));
wrote = true;

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
const corrected = changes.filter((c) => c.bound && c.fields.length);
// Split by CAUSE, not just by boundness. `reconciliations` used to answer
// "did not bind" for two different reasons and this block printed the title
// remedy for both, so an operator holding a byte-identical title and a
// disagreeing `file` was sent to correct the only field that was already right.
const unbound = changes.filter((c) => !c.bound && !isNamed(c) && c.cause === 'title');
// `noted` is split off under its own heading for the TITLE cause only, where
// the two accusations really are different: an unbound `fixed` or `declined`
// failed to settle a question, and an unbound `noted` was never going to settle
// one. An anchor disagreement is the same accusation whatever the disposition —
// the report carries this title and a field the entry states contradicts it —
// and the remedy printed below is the same one, so a `noted` belongs here
// rather than under a heading whose prose says no lane filed it.
const misanchored = changes.filter((c) => !c.bound && c.cause === 'anchor');
// Not a cause: a stale id no longer stops the fold binding by title, so it
// travels beside whatever the report path decided and is reported on bound
// entries too. Keyed on the cause it once was, this block went silent in the
// case an operator most needs it — an id from an earlier iteration whose title
// still binds cleanly — and silence there reads as an id that resolved.
const staleIds = changes.filter((c) => c.staleId !== null && c.staleId !== undefined);
// One answer per CAUSE, because `bindingFor` has four and boundness has two.
// Keyed on boundness this said "the title bound nothing either" for both of the
// unbound report causes: over a `--briefing`-only fold, where nothing was
// looked up at all, and over an anchor disagreement, where the title DID match
// a finding and the block below says so two lines later. Same
// boundness-vs-cause confusion the report blocks were split by cause to fix,
// one heading up and then again inside one line of it.
//
// The default is a sentence rather than a fall-through to one of the four: a
// cause added later reads as its own oddity here instead of borrowing the
// wording of whichever answer happened to be last.
const STALE_ID_OUTCOME = {
  unchecked: 'and no report was given to bind the title against',
  title: 'and the title matched no finding either',
  anchor: 'and the title matched a finding whose anchor it contradicts',
};

function staleIdOutcome(c) {
  if (c.bound) return 'bound by title';
  return STALE_ID_OUTCOME[c.cause]
    ?? `unbound, for a reason this block has no wording for (${oneLine(c.cause)})`;
}

// Why the id resolved to nothing, which is two different things and only one of
// them is the payload's. An id this briefing does STATE, on an entry the tool
// skipped as unusable, was reported as a stale citation — sending the operator
// to check an id against a file that plainly carries it.
function staleIdCause(c) {
  return c.unusableId
    ? ' — this briefing states that id, on an entry with no usable title'
    : '';
}

// Gated on the CAUSE its prose describes, not on boundness. `changes` is
// computed whenever either document was given, so on a `--briefing`-only fold
// every named entry arrives unbound carrying `cause: 'unchecked'` — and this
// block would then tell the operator the fold checked each of these against
// the report and no lane had filed it, when no report was consulted and the
// entry records `reconciled: null`, which `uncoveredDecisions` treats as
// vouching. Its whole stated consequence inverts in that mode: the block would
// promise an exemption is withheld in the one fold where it is granted.
const unreported = changes.filter((c) => !c.bound && isNamed(c) && c.cause === 'title');
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
if (staleIds.length) {
  // Distinct from the transposition refusal above on purpose, and it is not a
  // refusal: `briefing.mjs` re-mints ids positionally on every triage run, so
  // an id copied out of an earlier iteration's briefing names nothing here.
  // The title is what binds, so the fold proceeds exactly as it does with no
  // briefing at all — what is lost is the transposition check, which has
  // nothing to compare an unresolvable id against. Said out loud because a
  // guard that is off for one entry reads like a guard that passed it.
  out += `  ID NAMES NO BRIEFING ENTRY — the id/title check could not run on these`
       + ` (${staleIds.length}):\n`
       + staleIds.map((c) => `    - ${oneLine(c.title)} [${oneLine(c.agent)}] states id`
           + ` ${oneLine(c.staleId)}, ${staleIdOutcome(c)}${staleIdCause(c)}\n`).join('')
       + '    Briefing ids are re-minted every triage run, so one copied from an\n'
       + '    earlier iteration names nothing in this briefing. Check the id against\n'
       + '    briefing.json — the title may well be right, and the title is what binds\n'
       + '    a decision here. Each line above says what the title did.\n'
       + (staleIds.some((c) => c.unusableId)
         ? '    A line saying this briefing states the id is not a payload problem: the\n'
           + '    entry it names carries no usable title, so there was nothing to check\n'
           + '    the citation against. That is a triage output to look at, not a\n'
           + '    citation to correct.\n'
         : '');
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
       + '    briefing — check which against report.json before recording.\n'
       + '    The fold looked each of these up and would not bind it, so each records\n'
       + '    `reconciled: false`, the same value as an unfiled title. For a\n'
       + `    ${NAMED_NOT_FIXED_DISPOSITION} entry that is what stops it covering anything: a`
       + ' later decision\n'
       + '    leaning on one of these is named at `--record` anyway.\n';
}
if (unreported.length) {
  // Its own heading, never folded into the blocks above: an unbound `noted`
  // entry is not the same accusation. It records fine and settles nothing by
  // design, and it vouches for nothing either — `isSelfIdentified`
  // (src/ledger.mjs) reads `reconciled === false`, which is the fold saying it
  // looked this identity up in a report and no lane had filed it. This block is
  // built from the TITLE half of those, not all of them: cause `anchor` records
  // `false` too, and prints under its own heading above, which carries the same
  // consequence. It is NOT the wider claim that only an identity the report
  // carried can vouch: an entry from a fold given no report records `null` and
  // still vouches, which is why this block is gated on a report cause and not
  // on boundness. What reaches the ledger is
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
