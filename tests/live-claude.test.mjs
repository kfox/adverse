// Live integration test against `claude -p`. Skipped by default unless
// ADVERSE_LIVE=1 is set. Cannot pass when invoked from inside another Claude
// Code session — nested `claude` subprocesses don't inherit auth there.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { extractJson } from '../src/parse.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const BIN = path.join(ROOT, 'bin', 'adverse.mjs');

const SHOULD_RUN = process.env.ADVERSE_LIVE === '1';

function freshTmp() {
  return mkdtempSync(path.join(tmpdir(), 'adverse-live-'));
}

function buildBuggyTarget() {
  const dir = freshTmp();
  writeFileSync(path.join(dir, 'auth.py'),
    "import hashlib\n\n" +
    "def hash_password(password):\n" +
    "    # MD5, no salt: Adversary should flag\n" +
    "    return hashlib.md5(password.encode()).hexdigest()\n\n" +
    "def lookup(name, conn):\n" +
    "    # SQL injection: Adversary should flag\n" +
    "    return conn.execute(\"SELECT * FROM u WHERE n='\" + name + \"'\")\n\n" +
    "def avg(xs):\n" +
    "    # Auditor should flag: ZeroDivisionError on []\n" +
    "    return sum(xs) / len(xs)\n");
  return dir;
}

function claudeOnPath() {
  const r = spawnSync('which', ['claude'], { encoding: 'utf-8' });
  return r.status === 0 && r.stdout.trim().length > 0;
}

test('live: claude -p smoke returns parseable JSON', { skip: !SHOULD_RUN || !claudeOnPath() }, () => {
  const prompt =
    'Output a single JSON object and nothing else. No markdown fences. ' +
    'The object must have keys: "ok" (true) and "msg" (a one-word string).';
  const r = spawnSync('claude', ['-p', '--model', 'haiku'], {
    input: prompt, encoding: 'utf-8', timeout: 120_000,
  });
  assert.equal(r.status, 0, `claude -p failed: ${r.stderr}`);
  const parsed = extractJson(r.stdout);
  assert.equal(typeof parsed, 'object');
  assert.equal(parsed.ok, true);
});

test('live: full review with claude -p', { skip: !SHOULD_RUN || !claudeOnPath() }, () => {
  const target = buildBuggyTarget();
  try {
    const r = spawnSync('node', [
      BIN, 'review', target,
      '--agent', 'claude -p --model haiku',
      '--single-round',
      '--timeout', '180',
      '--verbose',
    ], { encoding: 'utf-8', timeout: 300_000 });
    assert.ok(r.status === 0 || r.status === 1,
      `unexpected status ${r.status}\nstderr:\n${r.stderr}\nstdout:\n${r.stdout}`);
    assert.match(r.stdout, /# Adversarial Code Review/);
    assert.match(r.stdout, /Reviewer verdicts/);
    assert.ok(/\*\*\[CRITICAL\]\*\*/.test(r.stdout) || /\*\*\[WARNING\]\*\*/.test(r.stdout),
      'expected at least one finding for an obviously buggy target');
  } finally { rmSync(target, { recursive: true, force: true }); }
});

test('live: artifacts contain valid round-1 payloads', { skip: !SHOULD_RUN || !claudeOnPath() }, () => {
  const target = buildBuggyTarget();
  const artifacts = freshTmp();
  try {
    const r = spawnSync('node', [
      BIN, 'review', target,
      '--agent', 'claude -p --model haiku',
      '--save-artifacts', artifacts,
      '--out', path.join(artifacts, '..', 'report.md'),
      '--timeout', '180',
      '--verbose',
    ], { encoding: 'utf-8', timeout: 300_000 });
    assert.ok(r.status === 0 || r.status === 1, r.stderr);
    const round1Files = readdirSync(artifacts).filter((f) => f.startsWith('round1_') && f.endsWith('.json'));
    assert.ok(round1Files.length >= 2, `expected ≥2 round1 artifacts; got ${round1Files}`);
    for (const f of round1Files) {
      const payload = JSON.parse(readFileSync(path.join(artifacts, f), 'utf-8'));
      assert.equal(typeof payload.persona, 'string');
      assert.equal(typeof payload.verdict, 'string');
      assert.ok(Array.isArray(payload.findings));
    }
  } finally {
    rmSync(target, { recursive: true, force: true });
    rmSync(artifacts, { recursive: true, force: true });
  }
});
