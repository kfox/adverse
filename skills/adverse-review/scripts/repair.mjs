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

import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { makeWriteGuard, readJson, requireKnownPersona, usage } from './bridge-io.mjs';
import { importFromSrc } from './package-root.mjs';

const { DEFAULT_PERSONAS, laneAgentOf } = await importFromSrc('personas.mjs');


// Positionals are round-2 files, so `--round2 run/round2-*.json` works. Same
// reason as triage.mjs: strict parsing without this throws on the second path
// the shell expands, and the glob is the obvious thing to type.
const { values, positionals } = parseArgs({
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
  usage('Usage: repair.mjs --briefing <briefing.json> --round2 a.json [--round2 b.json …] --outdir <dir>');
}

const briefing = readJson(values.briefing, 'repair');
const titleById = new Map(briefing.findings.map((f) => [f.id, f.title]));
const reporterById = new Map(briefing.findings.map((f) => [f.id, f.reporter]));
const groupIds = new Set((briefing.groups ?? []).map((g) => g.id));

let repaired = 0, unresolved = 0, checked = 0;

const claimDest = makeWriteGuard('repair');

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

  for (const key of ['validate', 'challenge']) {
    const edges = payload[key];
    if (edges !== undefined && !Array.isArray(edges)) {
      process.stderr.write(`repair: ${src}: \`${key}\` must be an array\n`);
      process.exit(1);
    }
    for (const edge of edges ?? []) {
      checked += 1;
      const canonical = titleById.get(edge.id);
      if (!canonical) {
        unresolved += 1;
        process.stderr.write(`  ! ${payload.persona}/${key}: unresolvable id ${JSON.stringify(edge.id)} (title: ${JSON.stringify(edge.title)})\n`);
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
  for (const ruling of payload.groups ?? []) {
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
  const dest = claimDest(`${values.outdir}/round2-${agent}.repaired.json`, src);
  writeFileSync(dest, JSON.stringify(payload, null, 2), 'utf-8');

  process.stdout.write(`repaired ${src} -> ${dest}\n`);
}

process.stdout.write(`${checked} edges checked, ${repaired} titles repaired, ${unresolved} unresolved\n`);
if (unresolved) process.exitCode = 1;
