// Tests for skills/adverse-review/scripts/synthesize.mjs — specifically the
// declaration flags whose failure mode is silence: a skipped round 2 that is
// not declared reads exactly like a panel that cross-examined and found
// nothing, and an EMPTY declaration is that same failure with better manners.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const SYNTH = path.join(ROOT, 'skills', 'adverse-review', 'scripts', 'synthesize.mjs');
const BIN = path.join(ROOT, 'bin', 'adverse.mjs');

// See the note in tests/cli.test.mjs: the env goes on the spawn, because a
// developer running this one file directly does not go through `npm test`.
const QUIET = { ...process.env, ADVERSE_NO_TELEMETRY: '1' };

function runSynth(args, cwd = ROOT) {
  return spawnSync('node', [SYNTH, ...args],
    { cwd, encoding: 'utf-8', timeout: 30_000, env: QUIET });
}

function runCli(args) {
  return spawnSync('node', [BIN, ...args],
    { cwd: ROOT, encoding: 'utf-8', timeout: 30_000, env: QUIET });
}

function round1File(dir) {
  const p = path.join(dir, 'round1.json');
  writeFileSync(p, JSON.stringify({
    auditor: { persona: 'auditor', verdict: 'approve', summary: 's', findings: [] },
    steward: { persona: 'steward', verdict: 'approve', summary: 's', findings: [] },
  }));
  return p;
}

test('an unreadable --round1 file is exit 2, not exit 1 — this run could not read a review, it did not judge one', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'adverse-synth-bad-'));
  try {
    const bad = path.join(dir, 'round1-bad.json');
    writeFileSync(bad, '{ not valid json');
    const r = runSynth(['--round1', bad, '--out', path.join(dir, 'r.md')]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /synthesize:.*round1-bad\.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an empty --round2-skipped is a usage error, not a silent undeclared skip', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'adverse-synth-'));
  try {
    const r = runSynth(['--round1', round1File(dir), '--round2-skipped', '',
      '--out', path.join(dir, 'r.md')]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /non-empty reason/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a declared round-2 skip renders in the markdown and the JSON report', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'adverse-synth2-'));
  try {
    const md = path.join(dir, 'r.md');
    const json = path.join(dir, 'r.json');
    const r = runSynth(['--round1', round1File(dir),
      '--round2-skipped', 'no blocking finding in round 1',
      '--out', md, '--json-out', json]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(readFileSync(md, "utf-8"), /Round 2 skipped:\*\* no blocking finding in round 1/);
    assert.equal(JSON.parse(readFileSync(json, 'utf-8')).round2_skipped, 'no blocking finding in round 1');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the bridge and `adverse synthesize` produce byte-identical reports — they are one implementation, not two synced copies', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'adverse-synth-parity-'));
  try {
    const r1 = round1File(dir);
    const args = ['--round1', r1, '--skipped', 'adversary=no trust boundary in the diff',
      '--degraded', 'pragmatist', '--round2-skipped', 'no blocking finding in round 1'];

    const viaBridge = runSynth([...args, '--out', path.join(dir, 'bridge.md'), '--json-out', path.join(dir, 'bridge.json')]);
    const viaCli = runCli(['synthesize', ...args, '--out', path.join(dir, 'cli.md'), '--json-out', path.join(dir, 'cli.json')]);

    assert.equal(viaBridge.status, viaCli.status);
    assert.equal(
      readFileSync(path.join(dir, 'bridge.md'), 'utf-8'),
      readFileSync(path.join(dir, 'cli.md'), 'utf-8'),
    );
    assert.equal(
      readFileSync(path.join(dir, 'bridge.json'), 'utf-8'),
      readFileSync(path.join(dir, 'cli.json'), 'utf-8'),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
