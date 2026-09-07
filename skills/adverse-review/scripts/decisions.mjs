#!/usr/bin/env node
// Skill bridge: turn a batch of fix-agent payloads into the decisions.json
// that `converge.mjs --record` appends to the ledger.
//
//   decisions.mjs --fix run/fix-*.json --out run/decisions.json
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

const { NAMED_NOT_FIXED_DISPOSITION, foldFixPayloads } = await importFromSrc('decisions.mjs');
const { clipReason, isSettled, summarizeDispositions } = await importFromSrc('ledger.mjs');
const { validateFix } = await importFromSrc('prompts.mjs');

// Positionals are fix payloads, so `--fix run/fix-*.json` works — the same
// reason triage.mjs, repair.mjs and verify.mjs take them: strict parsing
// without this throws on the second path the shell expands, and the glob is the
// obvious thing to type.
const USAGE = 'Usage: decisions.mjs --fix a.json [--fix b.json …] --out decisions.json';

const { values, positionals } = parseBridgeArgs({
  prefix: 'decisions',
  usage: USAGE,
  options: {
    fix: { type: 'string', multiple: true },
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

let decisions;
try {
  decisions = foldFixPayloads(payloads);
} catch (e) {
  // Reachable only if a payload passed validateFix and still cannot become a
  // decision, which would be the two disagreeing rather than a bad payload.
  // Exit 1 either way: something was read and it does not describe repair work.
  process.stderr.write(`decisions: ${e.message}\n`);
  process.exit(1);
}

writeFileSync(values.out, JSON.stringify({ decisions }, null, 2), 'utf-8');

// Everything below renders strings read off disk to stdout, which is what the
// Skill tells the orchestrating agent to read and act on. `clipReason` bounds
// length and strips control bytes but keeps newlines, because a reason is
// prose — so flatten too, or a newline ends the line and the next one can look
// like the tool speaking.
const oneLine = (v) => clipReason(String(v ?? '')).replace(/\s+/g, ' ').trim();

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
