// Tests for skills/adverse-review/scripts/verify.mjs — the Phase 9
// verification bridge.
//
// This is the bridge validateVerify (src/prompts.mjs) was written for and
// never had: before this script existed, nothing in src/, bin/, or skills/
// called it. These tests cover the bridge's contract — schema validation,
// the round-1-compatible reshape, and the exit-code contract shared with
// every other bridge — not a full spec of the review logic (that lives in
// tests/prompts.test.mjs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const VERIFY = path.join(here, '..', 'skills', 'adverse-review', 'scripts', 'verify.mjs');

function runVerify(args) {
  return spawnSync(process.execPath, [VERIFY, ...args], { encoding: 'utf-8', timeout: 30_000 });
}

function freshTmp() {
  return mkdtempSync(path.join(tmpdir(), 'adverse-verify-'));
}

test('a valid verify payload reshapes into the round-1 shape triage.mjs reads', () => {
  const dir = freshTmp();
  try {
    const src = path.join(dir, 'verify-auditor.json');
    writeFileSync(src, JSON.stringify({
      persona: 'auditor',
      verified: [
        { id: 'F1', title: 'x', status: 'closed', reason: 'fix confirmed' },
        { id: 'F2', title: 'y', status: 'moot', reason: 'code path removed' },
      ],
      added: [{ severity: 'warning', kind: 'defect', file: 'a.mjs', line: 3, title: 'z', detail: 'd', fix: null }],
    }));
    const r = runVerify(['--verify', src, '--outdir', dir]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /1 closed, 0 open, 1 moot, 1 new finding\(s\) added/);

    const out = JSON.parse(readFileSync(path.join(dir, 'round1-auditor.verified.json'), 'utf-8'));
    assert.equal(out.persona, 'auditor');
    assert.equal(out.verdict, 'conditional'); // nothing open, but a new finding was added
    assert.equal(out.findings.length, 1);
    assert.equal(out.findings[0].title, 'z');
    assert.equal(out.verified.length, 2); // preserved for Phase 7, untouched by triage
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('any verified finding still open makes the reshaped verdict reject', () => {
  const dir = freshTmp();
  try {
    const src = path.join(dir, 'verify-steward.json');
    writeFileSync(src, JSON.stringify({
      persona: 'steward',
      verified: [{ id: 'F1', title: 'x', status: 'open', reason: 'the fix did not address the claim' }],
      added: [],
    }));
    const r = runVerify(['--verify', src, '--outdir', dir]);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(readFileSync(path.join(dir, 'round1-steward.verified.json'), 'utf-8'));
    assert.equal(out.verdict, 'reject');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unknown persona is exit 1 — the payload read fine but fails the domain check', () => {
  const dir = freshTmp();
  try {
    const src = path.join(dir, 'verify-bad.json');
    writeFileSync(src, JSON.stringify({ persona: 'referee', verified: [], added: [] }));
    const r = runVerify(['--verify', src, '--outdir', dir]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /unknown persona "referee"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a payload failing validateVerify (bad status) is exit 1, not exit 0', () => {
  const dir = freshTmp();
  try {
    const src = path.join(dir, 'verify-bad-status.json');
    writeFileSync(src, JSON.stringify({
      persona: 'auditor',
      verified: [{ id: 'F1', title: 'x', status: 'fixed-i-guess', reason: 'r' }],
      added: [],
    }));
    const r = runVerify(['--verify', src, '--outdir', dir]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /status must be closed\|open\|moot/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('missing required arguments is a usage error', () => {
  const r = runVerify(['--outdir', '/tmp']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Usage: verify\.mjs/);
});

test('an unreadable --verify file is exit 2, not exit 1 — this run could not read its input', () => {
  const dir = freshTmp();
  try {
    const bad = path.join(dir, 'verify-bad.json');
    writeFileSync(bad, '{ not valid json');
    const r = runVerify(['--verify', bad, '--outdir', dir]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /verify:.*verify-bad\.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- the reshape the stop condition actually reads --------------------------
//
// `findings: payload.added` dropped every `verified` entry, so a payload whose
// own verdict was `reject` reshaped into an empty findings array — and
// `convergenceStatus` computes `done` over exactly that array, consulting no
// verdict. converge.mjs then exited 0 on a fix a reviewer had just said failed.

test('a still-open verification is re-emitted as a finding, not dropped', () => {
  const dir = freshTmp();
  try {
    const src = path.join(dir, 'verify-auditor.json');
    writeFileSync(src, JSON.stringify({
      persona: 'auditor',
      verified: [
        { id: 'F1', title: 'the fix did not take', status: 'open', reason: 'still reproduces' },
        { id: 'F2', title: 'closed one', status: 'closed', reason: 'confirmed' },
      ],
      added: [],
    }));
    const r = runVerify(['--verify', src, '--outdir', dir]);
    assert.equal(r.status, 0, r.stderr);

    const out = JSON.parse(readFileSync(path.join(dir, 'round1-auditor.verified.json'), 'utf-8'));
    assert.equal(out.verdict, 'reject');
    assert.equal(out.findings.length, 1, 'the open verification must reach `findings`');

    const [f] = out.findings;
    assert.equal(f.title, 'the fix did not take');
    assert.match(f.detail, /STILL OPEN/);
    assert.match(f.detail, /still reproduces/, "the reviewer's reason is the evidence");
    // isBlocking is `kind is not advisory && severity is not info`. Both halves
    // have to hold or this finding cannot hold the loop open.
    assert.notEqual(f.severity, 'info');
    assert.notEqual(f.kind, 'design');

    // A closed verification is not a finding — only the failures come back.
    assert.equal(out.verified.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--briefing restores a reopened finding\'s original severity and anchor', () => {
  const dir = freshTmp();
  try {
    const briefing = path.join(dir, 'briefing.json');
    writeFileSync(briefing, JSON.stringify({
      findings: [{
        id: 'F1', severity: 'critical', kind: 'defect',
        file: 'src/a.mjs', line: 42, counterpart: null, title: 'orig', fix: 'do the thing',
      }],
    }));
    const src = path.join(dir, 'verify-auditor.json');
    writeFileSync(src, JSON.stringify({
      persona: 'auditor',
      verified: [{ id: 'F1', title: 'orig', status: 'open', reason: 'nope' }],
      added: [],
    }));
    const r = runVerify(['--verify', src, '--outdir', dir, '--briefing', briefing]);
    assert.equal(r.status, 0, r.stderr);

    const [f] = JSON.parse(readFileSync(path.join(dir, 'round1-auditor.verified.json'), 'utf-8')).findings;
    assert.equal(f.severity, 'critical', 'a critical must not be downgraded by the round trip');
    assert.equal(f.kind, 'defect');
    assert.equal(f.file, 'src/a.mjs');
    assert.equal(f.line, 42);
    assert.equal(f.fix, 'do the thing');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('without --briefing a reopened finding still blocks', () => {
  const dir = freshTmp();
  try {
    const src = path.join(dir, 'verify-steward.json');
    writeFileSync(src, JSON.stringify({
      persona: 'steward',
      verified: [{ id: 'F9', title: 'unknown anchor', status: 'open', reason: 'r' }],
      added: [],
    }));
    const r = runVerify(['--verify', src, '--outdir', dir]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /re-emitted as findings/);

    const [f] = JSON.parse(readFileSync(path.join(dir, 'round1-steward.verified.json'), 'utf-8')).findings;
    assert.notEqual(f.severity, 'info');
    assert.notEqual(f.kind, 'design');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('two verify payloads for one persona refuse to collide', () => {
  const dir = freshTmp();
  try {
    // verify.mjs had the roster check from the start and not this one, so two
    // payloads for one persona still collapsed onto a single output file
    // before combine.mjs globbed the directory.
    const mk = (name) => {
      const f = path.join(dir, name);
      writeFileSync(f, JSON.stringify({ persona: 'auditor', verified: [], added: [] }));
      return f;
    };
    const r = runVerify(['--verify', mk('verify-auditor.json'),
                         '--verify', mk('verify-auditor-stale.json'), '--outdir', dir]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /already written this run/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
