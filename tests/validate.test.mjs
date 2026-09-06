// Tests for skills/adverse-review/scripts/validate.mjs — the check that
// replaces the orchestrator retyping a reviewer-written payload (issue #17).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const VALIDATE = path.join(ROOT, 'skills', 'adverse-review', 'scripts', 'validate.mjs');

function freshTmp() {
  return mkdtempSync(path.join(tmpdir(), 'adverse-validate-'));
}

function write(dir, filename, payload) {
  const p = path.join(dir, filename);
  writeFileSync(p, JSON.stringify(payload));
  return p;
}

function run(args) {
  return spawnSync('node', [VALIDATE, ...args], { cwd: ROOT, encoding: 'utf-8', timeout: 30_000 });
}

const goodPhase1 = { persona: 'auditor', verdict: 'approve', summary: 's', findings: [] };
const goodPhase2 = { persona: 'auditor', validate: [], challenge: [], added: [] };
const goodVerify = { persona: 'auditor', verified: [], added: [] };

test('validates a round1 payload the persona name is read from the filename', () => {
  const dir = freshTmp();
  try {
    const f = write(dir, 'round1-auditor.json', goodPhase1);
    const r = run(['--phase', 'round1', f]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /ok \(auditor\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a split-lane -a/-b suffix is stripped before persona comparison', () => {
  const dir = freshTmp();
  try {
    const f = write(dir, 'round1-auditor-a.json', goodPhase1);
    const r = run(['--phase', 'round1', f]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /ok \(auditor\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('validates round2 and verify payloads under their own phase', () => {
  const dir = freshTmp();
  try {
    const r2 = write(dir, 'round2-auditor.json', goodPhase2);
    const rv = write(dir, 'verify-auditor.json', goodVerify);
    assert.equal(run(['--phase', 'round2', r2]).status, 0);
    assert.equal(run(['--phase', 'verify', rv]).status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('validates multiple files in one call, reporting each', () => {
  const dir = freshTmp();
  try {
    const a = write(dir, 'round1-auditor.json', goodPhase1);
    const b = write(dir, 'round1-adversary.json', { ...goodPhase1, persona: 'adversary' });
    const r = run(['--phase', 'round1', a, b]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /ok \(auditor\)/);
    assert.match(r.stdout, /ok \(adversary\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rejects a persona mismatch between filename and payload', () => {
  const dir = freshTmp();
  try {
    const f = write(dir, 'round1-adversary.json', goodPhase1); // payload says auditor
    const r = run(['--phase', 'round1', f]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /must be 'adversary'/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('one bad file among several fails the whole call, but still reports the good ones', () => {
  const dir = freshTmp();
  try {
    const good = write(dir, 'round1-auditor.json', goodPhase1);
    const bad = write(dir, 'round1-adversary.json', { ...goodPhase1, verdict: 'yolo', persona: 'adversary' });
    const r = run(['--phase', 'round1', good, bad]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /ok \(auditor\)/);
    assert.match(r.stderr, /verdict/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('malformed JSON is exit 2 — the file was never written, not a claim about a review', () => {
  const dir = freshTmp();
  try {
    const bad = path.join(dir, 'round1-auditor.json');
    writeFileSync(bad, '{ not valid json');
    const r = run(['--phase', 'round1', bad]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /validate:.*round1-auditor\.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rejects an unknown --phase', () => {
  const dir = freshTmp();
  try {
    const f = write(dir, 'x.json', goodPhase1);
    const r = run(['--phase', 'roundwat', f]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /Usage:/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('requires at least one file', () => {
  const r = run(['--phase', 'round1']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Usage:/);
});

test('--phase __proto__ is a usage error, not a stack trace', () => {
  // A plain object answers `__proto__` and `constructor` with something
  // truthy, so an inherited property satisfied the membership guard and the
  // script then crashed past its own contract: exit 2 means "could not read an
  // input", never an uncaught throw.
  // The file must EXIST, or readJson exits 2 first and the guard is never
  // reached — which is how this looked fine while being broken.
  const dir = mkdtempSync(path.join(tmpdir(), 'adverse-validate-proto-'));
  try {
    const file = path.join(dir, 'round1-auditor.json');
    writeFileSync(file, JSON.stringify(goodPhase1));
    for (const phase of ['__proto__', 'constructor', 'toString', 'valueOf']) {
      const r = run(['--phase', phase, file]);
      assert.equal(r.status, 2, `--phase ${phase} must be a usage error, got ${r.status}`);
      assert.match(r.stderr, /--phase must be one of/);
      assert.doesNotMatch(r.stderr, /is not a function|TypeError/, 'no crash');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a filename implying a persona outside the registry is refused', () => {
  // validatePhase1 only checks that the payload's persona equals the one its
  // FILENAME implies, so a file claiming to be an invented lane agreed with
  // itself and validated clean — this bridge blessing a lane that does not
  // exist, one step before combine is asked to trust the glob.
  const dir = mkdtempSync(path.join(tmpdir(), 'adverse-validate-roster-'));
  try {
    const file = path.join(dir, 'round1-referee.json');
    writeFileSync(file, JSON.stringify({ ...goodPhase1, persona: 'referee' }));
    const r = run(['--phase', 'round1', file]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /is not one of/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
