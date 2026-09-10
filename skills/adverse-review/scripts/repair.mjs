#!/usr/bin/env node
// Skill bridge: round-2 repair. Restores the canonical finding title from the
// finding ID, so the title join downstream cannot silently drop an edge.
//
// Synthesis matches a validate/challenge edge to its finding by normalized
// title (src/synthesis.mjs, `findByTitle`). A reviewer who paraphrases a title —
// or helpfully fixes its typo — drops the edge, and a dropped edge demotes a
// cross-validated finding back to a lone opinion. Round 2 asks for a stable
// `id` next to the title; this step treats the ID as authoritative and rewrites
// the title to the briefing's canonical string.
//
// It reports every repair and every ID it could not resolve on stderr, because
// a silent repair is its own hazard: an unresolvable ID means a reviewer
// invented a finding number, and that edge is about to vanish.
//
// Round 2's rulings on candidate root causes (`groups`) get the same ID check
// and no title repair — a ruling names a group by ID and carries no canonical
// string to restore.
//
// The real fix belongs upstream in src/synthesis.mjs — join on ID, or on
// file/line proximity — at which point this script becomes dead weight.

import { makeWriteQueue, oneLine, parseBridgeArgs, readJson, requireKnownPersona, usage }
  from './bridge-io.mjs';
import { importFromSrc } from './package-root.mjs';

const { briefingEntries } = await importFromSrc('decisions.mjs');
const { DEFAULT_PERSONAS, laneAgentOf } = await importFromSrc('personas.mjs');


// Positionals are round-2 files, so `--round2 run/round2-*.json` works. Same
// reason as triage.mjs: strict parsing without this throws on the second path
// the shell expands, and the glob is the obvious thing to type.
const USAGE = 'Usage: repair.mjs --briefing <briefing.json> --round2 a.json [--round2 b.json …] --outdir <dir>';

const { values, positionals } = parseBridgeArgs({
  prefix: 'repair',
  usage: USAGE,
  options: {
    briefing: { type: 'string' },
    round2:   { type: 'string', multiple: true },
    outdir:   { type: 'string' },
  },
  strict: true,
  allowPositionals: true,
});

values.round2 = [...(values.round2 ?? []), ...positionals];
if (!values.briefing || !values.round2.length || !values.outdir) {
  usage(USAGE);
}

const briefing = readJson(values.briefing, 'repair');

// The third hand-written index over `briefing.findings`, and the last: the two
// in decisions.mjs and verify.mjs go through `briefingEntries`, and this one
// took every entry with no predicate at all. Two costs, and the second is
// worse than an unresolvable id:
//
// - An entry with no title made `canonical` undefined, so a correctly cited
//   edge was reported `unresolvable id "F3"` and lost its `from` repair — the
//   payload blamed for a field triage failed to write.
// - A whitespace title is TRUTHY, so the reviewer's correct `edge.title` was
//   rewritten to whitespace: the join key every downstream edge rides on,
//   corrupted in silence, by the function that exists to repair it.
//
// `briefingEntries` also throws on a `findings` that is missing or is not an
// array, which `.map` used to answer with a raw TypeError at exit 1 — and for
// this bridge exit 1 means a payload failed its schema.
let entries = [];
try {
  entries = briefingEntries(briefing);
} catch (e) {
  process.stderr.write(`repair: ${oneLine(values.briefing)}: ${e.message}\n`);
  process.exit(2);
}
const titleById = new Map(entries.map((f) => [f.id, f.title]));
const reporterById = new Map(entries.map((f) => [f.id, f.reporter]));

// Every id one of this briefing's lists STATES, usable entry or not, so an id
// it does carry is not reported as an id it does not — the same distinction
// decisions.mjs makes. "Unresolvable" sends the reviewer to check their
// citation; for an entry this tool skipped, there is nothing to check it
// against.
//
// One helper for both lists, because the second copy of it was written without
// the `f &&` guard the first has: `[null]` — a triage output one element short
// of its shape — reached `.map((g) => g.id)` as a raw TypeError at exit 1, and
// exit 1 is this bridge's code for a payload that failed its schema.
//
// A list that is not a list is REFUSED here rather than read as empty. Read as
// empty, a malformed `groups` reports every group ruling in every payload as
// unresolvable — which sends the reviewer to check citations that are correct,
// and blames the payloads for the shape of the briefing.
//
// `null` is refused with the rest of them, and only an ABSENT key is read as
// no groups at all. `null` is what a serializer writes for a field it had no
// value for, so it is the likeliest spelling of the malformed list above — and
// `briefingEntries` already refuses a `"findings": null`, so tolerating it here
// made the two lists disagree about the one shape most likely to arrive.
//
// The array check fires for `groups` alone today: `briefingEntries` runs first
// and refuses a non-array `findings` in its own sentence, so this one is the
// guard for the list nothing upstream checks. It is written for both because
// the next list added here gets it for free, and a predicate that is correct
// standalone is one the caller cannot use wrongly.
const statedIdsIn = (list, key) => {
  if (list !== undefined && !Array.isArray(list)) {
    process.stderr.write(`repair: ${oneLine(values.briefing)}: \`${key}\` is not an array\n`);
    process.exit(2);
  }
  return new Set((list ?? [])
    .filter((e) => e && typeof e.id === 'string' && e.id).map((e) => e.id));
};

const statedIds = statedIdsIn(briefing.findings, 'findings');
const groupIds = statedIdsIn(briefing.groups, 'groups');

let repaired = 0, unresolved = 0, checked = 0;

// Nothing reaches disk until every payload has been read and judged — see
// bridge-io.mjs. This loop refuses a payload on four separate grounds, and each
// of them used to publish every earlier payload's repaired file first.
const writes = makeWriteQueue('repair');

for (const src of values.round2) {

  const payload = readJson(src, 'repair');

  // Checked BEFORE the persona is used for anything at all. It used to run
  // just above the write, which left the whole repair loop below printing an
  // unvalidated model-written string to the orchestrator's stderr first — the
  // one surface that reads as the tool's own voice.
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    process.stderr.write(`repair: ${src}: payload is not a JSON object\n`);
    process.exit(1);
  }
  requireKnownPersona(payload.persona, { prefix: 'repair', file: src, personas: DEFAULT_PERSONAS });

  // Every list this payload can carry, checked the same way and in one place:
  // an ABSENT key is none of them, anything else that is not an array is
  // refused — `null` included, which is what a serializer writes for a field
  // it had no value for and which `briefingEntries` refuses on the other side
  // of this bridge —
  // and an element that is not an object is refused. `groups` had neither
  // check and the other two had only the first, so `{"groups": {…}}` was
  // `object is not iterable` and `{"validate": [null]}` was
  // `Cannot read properties of null (reading 'id')` — raw stack traces from a
  // bridge whose exit 1 means "this payload failed its schema", which is what
  // it should have SAID.
  const listOf = (key) => {
    const list = payload[key];
    if (list === undefined) return [];
    if (!Array.isArray(list)) {
      process.stderr.write(`repair: ${src}: \`${key}\` must be an array\n`);
      process.exit(1);
    }
    for (const [i, item] of list.entries()) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        process.stderr.write(`repair: ${src}: \`${key}[${i}]\` is not an object\n`);
        process.exit(1);
      }
    }
    return list;
  };

  for (const key of ['validate', 'challenge']) {
    for (const edge of listOf(key)) {
      checked += 1;
      const canonical = titleById.get(edge.id);
      if (!canonical) {
        unresolved += 1;
        process.stderr.write(`  ! ${payload.persona}/${key}: unresolvable id `
          + `${JSON.stringify(edge.id)} (title: ${JSON.stringify(edge.title)})`
          + (statedIds.has(edge.id)
            ? ' — this briefing states that id, on an entry with no usable title,'
              + ' so there was nothing to repair the title against'
            : '')
          + '\n');
        continue;
      }
      if (edge.title !== canonical) {
        repaired += 1;
        process.stderr.write(`  ~ ${payload.persona}/${key} ${edge.id}: title repaired\n`);
        edge.title = canonical;
      }
      const reporter = reporterById.get(edge.id);
      if (edge.from !== reporter) edge.from = reporter;
    }
  }

  // A group ruling has no title to repair — it names a group by ID and nothing
  // else — so the only thing to check is that the ID exists. It gets checked
  // for the same reason an edge's does: a ruling on an invented group is a
  // ruling on nothing, and dropping it silently means a candidate root cause
  // that a reviewer DID rule on is reported as unruled.
  for (const ruling of listOf('groups')) {
    checked += 1;
    if (!groupIds.has(ruling.id)) {
      unresolved += 1;
      process.stderr.write(`  ! ${payload.persona}/groups: unresolvable id ${JSON.stringify(ruling.id)}`
        + ` (ruling: ${JSON.stringify(ruling.ruling)})\n`);
    }
  }

  // The AGENT names the file this writes, not the lane. A split lane sends two
  // round-2 payloads under one persona now (kfox/adverse#50), and keying the
  // destination on the persona collapsed them onto one path — where the write
  // guard, doing its job, refused the second half as a spoof and took the
  // whole phase down with it. `laneAgentOf` is what makes this safe to
  // interpolate: the id is model-written and it is about to be a filename, so
  // an id that is not this lane's persona plus a letter suffix is a path, and
  // falls back to the persona rather than being trusted. One shared answer
  // rather than a fifth hand-spelled ternary — this was the copy that
  // interpolated its result into a path, and the rule had drifted between the
  // copies twice before it was consolidated.
  //
  // The guard itself stays live and still matters: a repeated agent id would
  // silently replace the half that wrote first, which is the cheapest way to
  // counterfeit the distinct-reviewer count synthesis treats as consensus.
  const agent = laneAgentOf(payload.persona, payload.agent);
  writes.queue(`${values.outdir}/round2-${agent}.repaired.json`, src,
    JSON.stringify(payload, null, 2));
}

writes.flush('repaired');

process.stdout.write(`${checked} edges checked, ${repaired} titles repaired, ${unresolved} unresolved\n`);
if (unresolved) process.exitCode = 1;
