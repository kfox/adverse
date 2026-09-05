#!/usr/bin/env node
// Regenerates the prompt text files under prompts/ from the canonical
// definitions in src/personas.mjs and src/prompts.mjs. Run it after editing
// either, and `tests/prompts.test.mjs` fails the build if you forget.
//
// The CLI reads the canonical definitions directly; only the Skill needs file
// copies, because a Skill's reviewers are spawned by an orchestrator that hands
// them a file path rather than importing a module.
//
// round2.txt is NOT the CLI's PHASE2_INSTRUCTIONS. The Skill withholds the
// source block in round 2 and sends a triaged briefing instead, so it gets
// PHASE2_BRIEFING_INSTRUCTIONS. Those two prompts diverged once before, as a
// hand-edit to round2.txt that this script would have silently clobbered;
// keeping both in src/prompts.mjs is what makes running it safe.

import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { importFromSrc } from './package-root.mjs';

const { PERSONAS } = await importFromSrc('personas.mjs');
const { PHASE1_INSTRUCTIONS, PHASE2_BRIEFING_INSTRUCTIONS } = await importFromSrc('prompts.mjs');

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, 'prompts');
mkdirSync(outDir, { recursive: true });

for (const p of Object.values(PERSONAS)) {
  writeFileSync(path.join(outDir, `${p.name}.txt`), p.system + '\n', 'utf-8');
}
writeFileSync(path.join(outDir, 'round1.txt'), PHASE1_INSTRUCTIONS, 'utf-8');
writeFileSync(path.join(outDir, 'round2.txt'), PHASE2_BRIEFING_INSTRUCTIONS, 'utf-8');

process.stdout.write(`wrote ${Object.keys(PERSONAS).length + 2} prompt files to ${outDir}\n`);
