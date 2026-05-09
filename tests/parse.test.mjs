// Unit tests for src/parse.mjs — JSON extraction across every wrapper shape.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { extractJson, ParseError } from '../src/parse.mjs';

test('plain object passes through', () => {
  const out = extractJson('{"persona":"auditor","verdict":"approve","summary":"ok","findings":[]}');
  assert.deepEqual(out, { persona: 'auditor', verdict: 'approve', summary: 'ok', findings: [] });
});

test('markdown-fenced JSON', () => {
  const text = '```json\n{"persona":"auditor","verdict":"approve","summary":"ok","findings":[]}\n```';
  const out = extractJson(text);
  assert.equal(out.persona, 'auditor');
});

test('fence without language tag', () => {
  const out = extractJson('```\n{"persona":"x"}\n```');
  assert.deepEqual(out, { persona: 'x' });
});

test('claude --output-format json wrapper unwraps inner string', () => {
  const inner = { persona: 'adversary', verdict: 'reject', summary: 'boom', findings: [] };
  const wrapper = JSON.stringify({ result: JSON.stringify(inner) });
  assert.deepEqual(extractJson(wrapper), inner);
});

test('claude wrapper with fenced inner', () => {
  const inner = { persona: 'adversary', verdict: 'reject', summary: 'boom', findings: [] };
  const fenced = '```json\n' + JSON.stringify(inner) + '\n```';
  const wrapper = JSON.stringify({ result: fenced });
  assert.deepEqual(extractJson(wrapper), inner);
});

test('content_block unwraps first text block', () => {
  const inner = { persona: 'pragmatist', verdict: 'approve', summary: 'ok', findings: [] };
  const wrapper = JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(inner) }] });
  assert.deepEqual(extractJson(wrapper), inner);
});

test('content_block skips non-text blocks until first text', () => {
  const inner = { persona: 'pragmatist', verdict: 'approve', summary: 'ok', findings: [] };
  const wrapper = JSON.stringify({
    content: [
      { type: 'tool_use', name: 'x', input: {} },
      { type: 'text', text: JSON.stringify(inner) },
    ],
  });
  assert.deepEqual(extractJson(wrapper), inner);
});

test('plain string shape: top-level JSON-encoded string', () => {
  const inner = { persona: 'auditor', verdict: 'approve', summary: 'ok', findings: [] };
  const wrapper = JSON.stringify(JSON.stringify(inner));
  assert.deepEqual(extractJson(wrapper), inner);
});

test('banner-then-object finds balanced braces', () => {
  const inner = { persona: 'auditor', verdict: 'approve', summary: 'ok', findings: [] };
  const text = 'Banner line one\nBanner line two\n---\n' + JSON.stringify(inner) + '\nfooter\n';
  assert.deepEqual(extractJson(text), inner);
});

test('braces inside strings are ignored by brace matcher', () => {
  const inner = { summary: 'the value is {literal-braces} ok', findings: [] };
  const text = 'preamble\n' + JSON.stringify(inner) + '\npostamble';
  assert.deepEqual(extractJson(text), inner);
});

test('escaped quote in string does not break brace matcher', () => {
  const inner = { summary: 'value with " inside', findings: [] };
  const text = 'preamble\n' + JSON.stringify(inner) + '\nfooter';
  const out = extractJson(text);
  assert.equal(out.summary, 'value with " inside');
});

test('empty stdout throws ParseError', () => {
  assert.throws(() => extractJson(''), ParseError);
});

test('whitespace-only stdout throws ParseError', () => {
  assert.throws(() => extractJson('   \n\t\n  '), ParseError);
});

test('no JSON at all throws with helpful message', () => {
  assert.throws(() => extractJson('Just some prose, no braces.'), /no JSON object/);
});

test('malformed JSON substring throws with parse error preserved', () => {
  assert.throws(() => extractJson("here is some {bad: 'json',}"), /failed to parse/);
});

test('first balanced object wins when multiple are present', () => {
  // When the whole stdout fails to parse (two objects glued together is not
  // valid JSON), substring scan returns the first balanced block.
  const a = { persona: 'auditor', verdict: 'approve', summary: 'first', findings: [] };
  const b = { persona: 'auditor', verdict: 'reject', summary: 'second', findings: [] };
  const text = JSON.stringify(a) + '\n\nUPDATED:\n\n' + JSON.stringify(b);
  assert.deepEqual(extractJson(text), a);
});
