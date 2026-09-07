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

import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { readJson, usage } from './bridge-io.mjs';
import { importFromSrc } from './package-root.mjs';

const { foldFixPayloads } = await importFromSrc('decisions.mjs');
const { clipReason } = await importFromSrc('ledger.mjs');
const { validateFix } = await importFromSrc('prompts.mjs');

// Positionals are fix payloads, so `--fix run/fix-*.json` works — the same
// reason triage.mjs, repair.mjs and verify.mjs take them: strict parsing
// without this throws on the second path the shell expands, and the glob is the
// obvious thing to type.
const { values, positionals } = parseArgs({
  options: {
    fix: { type: 'string', multiple: true },
    out: { type: 'string' },
  },
  strict: true,
  allowPositionals: true,
});

values.fix = [...(values.fix ?? []), ...positionals];
if (!values.fix.length || !values.out) {
  usage('Usage: decisions.mjs --fix a.json [--fix b.json …] --out decisions.json');
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

const by = (d) => decisions.filter((x) => x.disposition === d).length;
let out = `${decisions.length} decision(s) from ${payloads.length} fix payload(s)`
  + ` -> ${values.out}\n`
  + `  fixed: ${by('fixed')} · declined: ${by('declined')} · deferred: ${by('deferred')}\n`;

const named = decisions.filter((d) => d.disposition === 'deferred');
if (named.length) {
  out += `  NAMED, NOT FIXED — recorded deferred, each with the agent's own reasoning`
       + ` (${named.length}):\n`
       + named.map((d) => `    - [${oneLine(d.id)}] ${oneLine(d.title)}`
         + (d.file ? ` (${oneLine(d.file)}${d.line === null || d.line === undefined ? '' : `:${oneLine(d.line)}`})` : '')
         + `\n        ${oneLine(d.reason)}`).join('\n') + '\n'
       + '    These are findings with no ID. Read them before you record: an item\n'
       + '    left unrecorded costs a full review round of the next iteration.\n';
}
process.stdout.write(out);
