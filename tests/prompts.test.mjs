// Unit tests for src/prompts.mjs — validators + prompt construction.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AUDITOR, PERSONAS } from '../src/personas.mjs';
import {
  buildPhase1Prompt,
  buildPhase2Prompt,
  knownTitles,
  validatePhase1,
  validatePhase2,
} from '../src/prompts.mjs';

const goodPhase1 = (persona = 'auditor') => ({
  persona, verdict: 'approve', summary: 'ok', findings: [],
});

test('phase1: valid with no findings', () => {
  assert.equal(validatePhase1(goodPhase1(), 'auditor'), null);
});

test('phase1: valid with findings', () => {
  const p = goodPhase1();
  p.verdict = 'conditional';
  p.findings = [{ severity: 'critical', file: 'x.py', line: 10, title: 'bug', detail: 'broken', fix: 'fix it' }];
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
  p.findings = [{ severity: 'critical', title: 'x' }]; // missing detail
  assert.match(validatePhase1(p, 'auditor'), /detail/);
});

test('phase1: rejects invalid severity', () => {
  const p = goodPhase1();
  p.findings = [{ severity: 'huge', title: 'x', detail: 'y' }];
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
  p.added = [{ severity: 'warning', title: 'extra', detail: 'more', file: null, line: null }];
  assert.equal(validatePhase2(p, 'auditor'), null);
});

test('phase2: rejects validate entry missing reason', () => {
  const p = goodPhase2();
  p.validate = [{ from: 'adversary', title: 'SQLi' }];
  assert.match(validatePhase2(p, 'auditor'), /reason/);
});

test('phase2: rejects added missing severity', () => {
  const p = goodPhase2();
  p.added = [{ title: 'x', detail: 'y' }];
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
