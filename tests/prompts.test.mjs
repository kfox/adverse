// Unit tests for src/prompts.mjs — validators + prompt construction.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AUDITOR, PERSONAS } from '../src/personas.mjs';
import {
  KINDS,
  PHASE1_INSTRUCTIONS,
  validateVerify,
  buildPhase1Prompt,
  buildPhase2Prompt,
  knownTitles,
  validatePhase1,
  validatePhase2,
} from '../src/prompts.mjs';

import * as PROMPTS from '../src/prompts.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

const goodPhase1 = (persona = 'auditor') => ({
  persona, verdict: 'approve', summary: 'ok', findings: [],
});

test('phase1: valid with no findings', () => {
  assert.equal(validatePhase1(goodPhase1(), 'auditor'), null);
});

test('phase1: valid with findings', () => {
  const p = goodPhase1();
  p.verdict = 'conditional';
  p.findings = [{ severity: 'critical', kind: 'defect', file: 'x.py', line: 10, title: 'bug', detail: 'broken', fix: 'fix it' }];
  assert.equal(validatePhase1(p, 'auditor'), null);
});

test('phase1: rejects non-dict', () => {
  const err = validatePhase1([], 'auditor');
  assert.match(err, /object/);
});

test('phase1: rejects null', () => {
  const err = validatePhase1(null, 'auditor');
  assert.match(err, /object/);
});

test('phase1: rejects missing keys', () => {
  const err = validatePhase1({ persona: 'auditor' }, 'auditor');
  assert.match(err, /Missing required keys/);
});

test('phase1: rejects wrong persona name', () => {
  const err = validatePhase1(goodPhase1('evil'), 'auditor');
  assert.match(err, /auditor/);
});

test('phase1: rejects unknown verdict', () => {
  const p = goodPhase1();
  p.verdict = 'yolo';
  assert.match(validatePhase1(p, 'auditor'), /verdict/);
});

test('phase1: rejects findings not list', () => {
  const p = goodPhase1();
  p.findings = 'not a list';
  assert.match(validatePhase1(p, 'auditor'), /findings/);
});

test('phase1: rejects finding with missing required field', () => {
  const p = goodPhase1();
  p.findings = [{ severity: 'critical', kind: 'defect', title: 'x' }]; // missing detail
  assert.match(validatePhase1(p, 'auditor'), /detail/);
});

test('phase1: rejects invalid severity', () => {
  const p = goodPhase1();
  p.findings = [{ severity: 'huge', kind: 'defect', title: 'x', detail: 'y' }];
  assert.match(validatePhase1(p, 'auditor'), /severity/);
});

const goodPhase2 = (persona = 'auditor') => ({
  persona, validate: [], challenge: [], added: [],
});

test('phase2: valid empty', () => {
  assert.equal(validatePhase2(goodPhase2(), 'auditor'), null);
});

test('phase2: valid populated', () => {
  const p = goodPhase2();
  p.validate = [{ from: 'adversary', title: 'SQLi', reason: 'yes' }];
  p.challenge = [{ from: 'pragmatist', title: 'Style nit', reason: 'out of scope' }];
  p.added = [{ severity: 'warning', kind: 'design', title: 'extra', detail: 'more', file: null, line: null }];
  assert.equal(validatePhase2(p, 'auditor'), null);
});

test('phase2: rejects validate entry missing reason', () => {
  const p = goodPhase2();
  p.validate = [{ from: 'adversary', title: 'SQLi' }];
  assert.match(validatePhase2(p, 'auditor'), /reason/);
});

test('phase2: rejects added missing severity', () => {
  const p = goodPhase2();
  p.added = [{ title: 'x', kind: 'defect', detail: 'y' }];
  assert.match(validatePhase2(p, 'auditor'), /severity/);
});

test('buildPhase1Prompt contains persona and source', () => {
  const prompt = buildPhase1Prompt(AUDITOR, '=== FILE: foo.py ===\nprint(1)\n');
  assert.ok(prompt.includes('Auditor'));
  assert.ok(prompt.includes('foo.py'));
  assert.ok(prompt.includes('Round 1'));
  assert.ok(prompt.toLowerCase().includes('out of scope'));
});

test('buildPhase2Prompt embeds round-1 reviews', () => {
  const round1 = {
    auditor: { persona: 'auditor', verdict: 'approve', summary: 'ok', findings: [] },
    adversary: {
      persona: 'adversary', verdict: 'reject', summary: 'bad',
      findings: [{ severity: 'critical', title: 'SQL injection', detail: '...' }],
    },
  };
  const prompt = buildPhase2Prompt(AUDITOR, '<source>', round1);
  assert.ok(prompt.includes('Round 2'));
  assert.ok(prompt.includes('SQL injection'));
  assert.ok(prompt.includes('<source>'));
});

test('knownTitles collects across personas', () => {
  const round1 = {
    auditor: { findings: [{ title: 'alpha' }, { title: 'beta' }] },
    adversary: { findings: [{ title: 'gamma' }] },
  };
  assert.deepEqual([...knownTitles(round1)].sort(), ['alpha', 'beta', 'gamma']);
});

test('knownTitles handles missing findings array', () => {
  assert.equal(knownTitles({ auditor: {}, adversary: { findings: null } }).size, 0);
});

for (const name of Object.keys(PERSONAS)) {
  test(`persona '${name}' has complete system prompt`, () => {
    const p = PERSONAS[name];
    assert.ok(p.system && p.system.length > 100, `${name} has no system prompt`);
    assert.ok(p.system.toLowerCase().includes('scope'), 'must declare scope');
    assert.ok(p.system.includes(p.title), 'system must reference its own title');
  });
}

// --- Skill prompt drift ------------------------------------------------------
// The Skill reads prompts from scripts/prompts/*.txt, generated from the
// canonical definitions here by dump-prompts.mjs. Nothing at runtime notices
// when the two disagree: the CLI would use the new text and the Skill the
// stale copy, and the panel would quietly run two different reviews. This is
// the check that makes forgetting to regenerate a build failure instead.

test('skill prompt files match their generators', async () => {
  const skillPrompts = path.join(here, '..', 'skills', 'adverse-review', 'scripts', 'prompts');
  const { PHASE1_INSTRUCTIONS, PHASE2_BRIEFING_INSTRUCTIONS } =
    await import('../src/prompts.mjs');

  const { VERIFY_INSTRUCTIONS } = await import('../src/prompts.mjs');
  const expected = new Map([
    ['round1.txt', PHASE1_INSTRUCTIONS],
    ['round2.txt', PHASE2_BRIEFING_INSTRUCTIONS],
    ['verify.txt', VERIFY_INSTRUCTIONS],
  ]);
  for (const p of Object.values(PERSONAS)) expected.set(`${p.name}.txt`, p.system + '\n');

  for (const [name, want] of expected) {
    const got = readFileSync(path.join(skillPrompts, name), 'utf-8');
    assert.equal(got, want,
      `${name} is stale — run: node skills/adverse-review/scripts/dump-prompts.mjs`);
  }

  const onDisk = readdirSync(skillPrompts).filter((n) => n.endsWith('.txt')).sort();
  assert.deepEqual(onDisk, [...expected.keys()].sort(),
    'prompts/ has a file no generator writes (or is missing one)');
});

test('round-1 schema documents every kind', () => {
  for (const kind of KINDS) {
    assert.ok(PHASE1_INSTRUCTIONS.includes(`\`${kind}\``), `round 1 must define ${kind}`);
  }
  assert.ok(PHASE1_INSTRUCTIONS.includes('ADVISORY'), 'the advisory rule must be stated');
});

test('validator rejects an unknown kind', () => {
  const p = goodPhase1();
  p.findings = [{ severity: 'warning', kind: 'vibes', title: 'x', detail: 'y' }];
  assert.match(validatePhase1(p, 'auditor'), /kind/);
});

test('validator rejects a finding with no kind', () => {
  const p = goodPhase1();
  p.findings = [{ severity: 'warning', title: 'x', detail: 'y' }];
  assert.match(validatePhase1(p, 'auditor'), /kind/);
});

// --- verification round -------------------------------------------------------

const goodVerify = (persona = 'auditor') => ({ persona, verified: [], added: [] });

test('verify: valid empty', () => {
  assert.equal(validateVerify(goodVerify(), 'auditor'), null);
});

test('verify: valid populated', () => {
  const p = goodVerify();
  p.verified = [{ id: 'F1', title: 'x', status: 'closed', reason: 'the guard was added' }];
  p.added = [{ severity: 'warning', kind: 'defect', title: 'new', detail: 'd' }];
  assert.equal(validateVerify(p, 'auditor'), null);
});

test('verify: rejects a status outside closed|open|moot', () => {
  const p = goodVerify();
  p.verified = [{ id: 'F1', title: 'x', status: 'probably', reason: 'r' }];
  assert.match(validateVerify(p, 'auditor'), /status/);
});

test('verify: rejects a verdict with no reason', () => {
  const p = goodVerify();
  p.verified = [{ id: 'F1', title: 'x', status: 'closed' }];
  assert.match(validateVerify(p, 'auditor'), /reason/);
});

test('verify: an added finding still has to carry a kind', () => {
  const p = goodVerify();
  p.added = [{ severity: 'warning', title: 'new', detail: 'd' }];
  assert.match(validateVerify(p, 'auditor'), /kind/);
});

test('verify prompt asks both questions, not just closure', () => {
  const { VERIFY_INSTRUCTIONS } = PROMPTS;
  assert.match(VERIFY_INSTRUCTIONS, /Is each finding actually closed/);
  assert.match(VERIFY_INSTRUCTIONS, /Did the fix introduce anything new/);
});

// --- subagent definitions ----------------------------------------------------
// `.claude/agents/<persona>.md` is what makes the agent list show "steward"
// instead of a fourth indistinguishable "general-purpose" row. It embeds the
// persona system prompt, so it is a THIRD copy of text that has already drifted
// once between the CLI and the Skill. Generated, and checked here.

test('agent definitions match their generators', async () => {
  const { agentDefinition } = await import('../skills/adverse-review/scripts/dump-prompts.mjs');
  const agentsDir = path.join(here, '..', 'skills', 'adverse-review', 'agents');

  for (const p of Object.values(PERSONAS)) {
    const got = readFileSync(path.join(agentsDir, `${p.name}.md`), 'utf-8');
    assert.equal(got, agentDefinition(p),
      `${p.name}.md is stale — run: node skills/adverse-review/scripts/dump-prompts.mjs`);
  }

  const onDisk = readdirSync(agentsDir).filter((n) => n.endsWith('.md')).sort();
  assert.deepEqual(onDisk, Object.values(PERSONAS).map((p) => `${p.name}.md`).sort(),
    'agents/ has a definition no persona generates (or is missing one)');
});

test('an agent definition is parseable frontmatter', async () => {
  const { agentDefinition } = await import('../skills/adverse-review/scripts/dump-prompts.mjs');
  for (const p of Object.values(PERSONAS)) {
    const lines = agentDefinition(p).split('\n');
    assert.equal(lines[0], '---');
    const close = lines.indexOf('---', 1);
    assert.ok(close > 1, `${p.name}: frontmatter is not closed`);

    const fm = Object.fromEntries(lines.slice(1, close).map((l) => {
      const i = l.indexOf(':');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }));
    assert.equal(fm.name, p.name);
    // Several lenses contain a colon-space; unquoted, YAML reads that as a
    // nested mapping and the definition fails to load.
    assert.ok(fm.description.startsWith('"') && fm.description.endsWith('"'),
      `${p.name}: description must be a quoted YAML string`);
    assert.ok(!/(^|[^\\])"/.test(fm.description.slice(1, -1)), `${p.name}: unescaped quote`);
    assert.ok(lines.slice(close + 1).join('\n').includes(p.title),
      `${p.name}: body must be the persona system prompt`);
  }
});
