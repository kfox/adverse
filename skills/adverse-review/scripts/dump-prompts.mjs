#!/usr/bin/env node
// Regenerates the prompt text files under prompts/ from the canonical
// definitions in src/personas.mjs and src/prompts.mjs. Run it after editing
// either, and `tests/prompts.test.mjs` fails the build if you forget.
//
// The CLI reads the canonical definitions directly; only the Skill needs file
// copies, because a Skill's reviewers are spawned by an orchestrator that hands
// them a file path rather than importing a module.
//
// It also writes ../agents/<persona>.md, the Claude Code subagent definitions.
// Those exist for one reason that is not cosmetic: the agent list shows the
// subagent_type, so four reviewers spawned as `general-purpose` are four
// indistinguishable rows, and an orchestrator watching a run cannot tell which
// lane is still working or which one died. Generating them here rather than
// hand-writing them keeps the persona text in exactly one place — it has
// already drifted once between the CLI and the Skill.
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
const { PHASE1_INSTRUCTIONS, PHASE2_BRIEFING_INSTRUCTIONS, VERIFY_INSTRUCTIONS } =
  await importFromSrc('prompts.mjs');

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, 'prompts');
mkdirSync(outDir, { recursive: true });

for (const p of Object.values(PERSONAS)) {
  writeFileSync(path.join(outDir, `${p.name}.txt`), p.system + '\n', 'utf-8');
}
writeFileSync(path.join(outDir, 'round1.txt'), PHASE1_INSTRUCTIONS, 'utf-8');
writeFileSync(path.join(outDir, 'round2.txt'), PHASE2_BRIEFING_INSTRUCTIONS, 'utf-8');
writeFileSync(path.join(outDir, 'verify.txt'), VERIFY_INSTRUCTIONS, 'utf-8');

// --- subagent definitions ----------------------------------------------------
// Deliberately no `model:` in the frontmatter. The Agent tool's own `model`
// argument overrides it, and leaving it unset is what lets a run assign a
// different model per lane — the decorrelation experiment the README's
// single-model caveat calls for.

function yamlString(text) {
  return `"${String(text).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function agentDefinition(persona) {
  return [
    '---',
    `name: ${persona.name}`,
    // Quoted: several lenses contain a colon-space, which YAML would otherwise
    // read as a mapping and reject.
    `description: ${yamlString(`${persona.lens} — the ${persona.title} lane of an `
      + `adversarial code review. Owns: ${persona.kinds.join(', ')}.`)}`,
    'tools: Bash, Read, Edit, Write',
    '---',
    '',
    persona.system,
    '',
  ].join('\n');
}

const agentsDir = path.join(here, '..', 'agents');
mkdirSync(agentsDir, { recursive: true });
for (const p of Object.values(PERSONAS)) {
  writeFileSync(path.join(agentsDir, `${p.name}.md`), agentDefinition(p), 'utf-8');
}

process.stdout.write(`wrote ${Object.keys(PERSONAS).length + 3} prompt files to ${outDir}\n`);
process.stdout.write(`wrote ${Object.keys(PERSONAS).length} agent definitions to ${agentsDir}\n`);
