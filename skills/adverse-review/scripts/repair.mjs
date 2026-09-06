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

import { readJson, usage } from './bridge-io.mjs';

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

for (const src of values.round2) {
  const payload = readJson(src, 'repair');

  for (const key of ['validate', 'challenge']) {
    for (const edge of payload[key] ?? []) {
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

  const dest = `${values.outdir}/round2-${payload.persona}.repaired.json`;
  writeFileSync(dest, JSON.stringify(payload, null, 2), 'utf-8');
  process.stdout.write(`repaired ${src} -> ${dest}\n`);
}

process.stdout.write(`${checked} edges checked, ${repaired} titles repaired, ${unresolved} unresolved\n`);
if (unresolved) process.exitCode = 1;
