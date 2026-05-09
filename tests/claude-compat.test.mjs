// Contract tests: every pinned `claude -p` output shape under
// tests/fixtures/claude-cli/ must round-trip through extractJson and satisfy
// the appropriate phase validator. Adding a new shape is "drop a file in the
// fixtures dir, name it correctly, no test edit needed".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractJson } from '../src/parse.mjs';
import { validatePhase1, validatePhase2 } from '../src/prompts.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(here, 'fixtures', 'claude-cli');

function fixtureFiles() {
  return readdirSync(FIXTURES)
    .filter((n) => (n.endsWith('.json') || n.endsWith('.txt')) && n !== 'README.md')
    .sort();
}

function phaseAndPersona(filename) {
  const stem = filename.replace(/\.[^.]+$/, '');
  const [phase, rest] = [stem.split('_')[0], stem.split('_').slice(1).join('_')];
  const persona = rest.split('__')[0];
  return { phase, persona };
}

test('fixture directory is non-empty', () => {
  const files = fixtureFiles();
  assert.ok(files.length >= 6, `expected ≥6 fixtures, got ${files.length}`);
});

for (const filename of fixtureFiles()) {
  test(`fixture round-trips: ${filename}`, () => {
    const raw = readFileSync(path.join(FIXTURES, filename), 'utf-8');
    const parsed = extractJson(raw);
    assert.equal(typeof parsed, 'object', `${filename}: expected object`);
    assert.ok(!Array.isArray(parsed), `${filename}: expected object, got array`);

    let { phase, persona } = phaseAndPersona(filename);
    if (persona === 'clean') persona = parsed.persona; // stand-in name

    if (phase === 'round1') {
      const err = validatePhase1(parsed, persona);
      assert.equal(err, null, `${filename}: validatePhase1 rejected: ${err}`);
    } else if (phase === 'round2') {
      const err = validatePhase2(parsed, persona);
      assert.equal(err, null, `${filename}: validatePhase2 rejected: ${err}`);
    } else {
      assert.fail(`${filename}: unknown phase '${phase}'`);
    }
  });

  test(`fixture survives terminal escapes around it: ${filename}`, () => {
    const raw = readFileSync(path.join(FIXTURES, filename), 'utf-8').trim();
    if (raw.startsWith('"')) {
      // plain-string-shape: prepending bytes breaks it irrecoverably and there
      // is no `{` for the substring scan to find. Documented in parse.mjs.
      return;
    }
    const decorated = '\x1b[1;33mloading...\x1b[0m\n' + raw + '\n\x1b[0m';
    const parsed = extractJson(decorated);
    assert.equal(typeof parsed, 'object');
  });
}
