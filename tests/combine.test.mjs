// Tests for skills/adverse-review/scripts/combine.mjs — CLI argument parsing.
// Regression coverage for the documented multi-file invocation forms
// (space-separated and shell-glob-expanded), the backward-compatible
// repeated-flag form, and the exactly-one-round guard.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const COMBINE = path.join(ROOT, 'skills', 'adverse-review', 'scripts', 'combine.mjs');

function freshTmp() {
  return mkdtempSync(path.join(tmpdir(), 'adverse-combine-'));
}

// Write a minimal valid per-persona review and return its path.
function review(dir, persona) {
  const p = path.join(dir, `${persona}.json`);
  writeFileSync(p, JSON.stringify({ persona, verdict: 'approve', summary: 's', findings: [] }));
  return p;
}

function runCombine(args) {
  return spawnSync('node', [COMBINE, ...args], { cwd: ROOT, encoding: 'utf-8', timeout: 30_000 });
}

function personasIn(outPath) {
  return Object.keys(JSON.parse(readFileSync(outPath, 'utf-8'))).sort();
}

// --- Accepted invocation forms (all must parse to the same three personas) --

const ACCEPTED_FORMS = [
  {
    name: 'space-separated (SKILL.md Phase 2 form)',
    args: (f, out) => ['--round1', f.auditor, f.adversary, f.pragmatist, '--out', out],
  },
  {
    name: 'glob-expanded multi-file (SKILL.md Phase 3 form)',
    args: (f, out) => ['--round2', f.auditor, f.adversary, f.pragmatist, '--out', out],
  },
  {
    name: 'repeated flags (backward-compatible)',
    args: (f, out) => [
      '--round1', f.auditor, '--round1', f.adversary, '--round1', f.pragmatist, '--out', out,
    ],
  },
];

for (const form of ACCEPTED_FORMS) {
  test(`combine accepts ${form.name}`, () => {
    const dir = freshTmp();
    try {
      const f = {
        auditor: review(dir, 'auditor'),
        adversary: review(dir, 'adversary'),
        pragmatist: review(dir, 'pragmatist'),
      };
      const out = path.join(dir, 'combined.json');
      const r = runCombine(form.args(f, out));
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(personasIn(out), ['adversary', 'auditor', 'pragmatist']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('combine accepts a single input file', () => {
  const dir = freshTmp();
  try {
    const out = path.join(dir, 'combined.json');
    const r = runCombine(['--round1', review(dir, 'auditor'), '--out', out]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(personasIn(out), ['auditor']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Rejected / error cases -------------------------------------------------

test('combine rejects both --round1 and --round2 in one call', () => {
  const dir = freshTmp();
  try {
    const out = path.join(dir, 'combined.json');
    const r = runCombine([
      '--round1', review(dir, 'auditor'),
      '--round2', review(dir, 'adversary'),
      '--out', out,
    ]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /exactly one of --round1 or --round2/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('combine rejects bare positionals with no round flag', () => {
  const dir = freshTmp();
  try {
    const out = path.join(dir, 'combined.json');
    const r = runCombine([review(dir, 'auditor'), review(dir, 'adversary'), '--out', out]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /exactly one of --round1 or --round2/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('combine requires --out', () => {
  const dir = freshTmp();
  try {
    const r = runCombine(['--round1', review(dir, 'auditor')]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /Usage:/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('combine fails on a duplicate persona', () => {
  const dir = freshTmp();
  try {
    const a = review(dir, 'auditor');
    const b = path.join(dir, 'auditor2.json');
    writeFileSync(b, JSON.stringify({ persona: 'auditor', verdict: 'approve', summary: 's', findings: [] }));
    const out = path.join(dir, 'combined.json');
    const r = runCombine(['--round1', a, b, '--out', out]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /duplicate persona/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('combine fails on malformed JSON', () => {
  const dir = freshTmp();
  try {
    const bad = path.join(dir, 'bad.json');
    writeFileSync(bad, '{ not valid json');
    const out = path.join(dir, 'combined.json');
    const r = runCombine(['--round1', bad, '--out', out]);
    assert.equal(r.status, 2, 'unreadable JSON is exit 2 — the run could not read an input, not a claim about a review');
    assert.match(r.stderr, /combine:.*bad\.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('combine rejects a file with no persona field', () => {
  const dir = freshTmp();
  try {
    const noPersona = path.join(dir, 'nopersona.json');
    writeFileSync(noPersona, JSON.stringify({ verdict: 'approve', findings: [] }));
    const out = path.join(dir, 'combined.json');
    const r = runCombine(['--round1', noPersona, '--out', out]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /missing or invalid/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- --merge-personas: the deliberately split lane ---------------------------

function reviewAs(dir, filename, payload) {
  const p = path.join(dir, filename);
  writeFileSync(p, JSON.stringify(payload));
  return p;
}

test('--merge-personas <persona> unions the split lane: findings, worse verdict, BOTH summaries', () => {
  const dir = freshTmp();
  try {
    const a = reviewAs(dir, 'auditor-a.json', {
      persona: 'auditor', verdict: 'approve', summary: 'half one',
      findings: [{ severity: 'warning', kind: 'defect', title: 'from half one' }],
    });
    const b = reviewAs(dir, 'auditor-b.json', {
      persona: 'auditor', verdict: 'reject', summary: 'half two',
      findings: [{ severity: 'critical', kind: 'defect', title: 'from half two' }],
    });
    const out = path.join(dir, 'combined.json');
    const r = runCombine(['--round1', a, b, '--merge-personas', 'auditor', '--out', out]);
    assert.equal(r.status, 0, r.stderr);
    const combined = JSON.parse(readFileSync(out, 'utf-8'));
    assert.deepEqual(Object.keys(combined), ['auditor']);
    assert.deepEqual(combined.auditor.findings.map((f) => f.title),
      ['from half one', 'from half two']);
    assert.equal(combined.auditor.verdict, 'reject');
    assert.match(combined.auditor.summary, /half one/);
    assert.match(combined.auditor.summary, /half two/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the worse verdict wins in either input order', () => {
  const dir = freshTmp();
  try {
    const a = reviewAs(dir, 'a.json', { persona: 'auditor', verdict: 'conditional', summary: 's', findings: [] });
    const b = reviewAs(dir, 'b.json', { persona: 'auditor', verdict: 'approve', summary: 's', findings: [] });
    for (const order of [[a, b], [b, a]]) {
      const out = path.join(dir, 'combined.json');
      const r = runCombine(['--round1', ...order, '--merge-personas', 'auditor', '--out', out]);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(JSON.parse(readFileSync(out, 'utf-8')).auditor.verdict, 'conditional');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an off-contract verdict is recorded as reject, loudly — it cannot erase its partner\'s reject', () => {
  const dir = freshTmp();
  try {
    const a = reviewAs(dir, 'a.json', { persona: 'auditor', verdict: 'reject', summary: 's', findings: [] });
    const b = reviewAs(dir, 'b.json', { persona: 'auditor', verdict: 'REJECTED', summary: 's', findings: [] });
    for (const order of [[a, b], [b, a]]) {
      const out = path.join(dir, 'combined.json');
      const r = runCombine(['--round1', ...order, '--merge-personas', 'auditor', '--out', out]);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(JSON.parse(readFileSync(out, 'utf-8')).auditor.verdict, 'reject');
      assert.match(r.stderr, /off-contract/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an off-contract verdict on an UNSPLIT lane is normalized too — the class, not the merge instance', () => {
  const dir = freshTmp();
  try {
    const a = reviewAs(dir, 'a.json', { persona: 'auditor', verdict: 'REJECT', summary: 's', findings: [] });
    const out = path.join(dir, 'combined.json');
    const r = runCombine(['--round1', a, '--out', out]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(readFileSync(out, 'utf-8')).auditor.verdict, 'reject');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a persona outside the registry is rejected — no phantom reviewer, no prototype key', () => {
  const dir = freshTmp();
  try {
    for (const persona of ['Auditor', '__proto__', 'constructor']) {
      const p = reviewAs(dir, 'x.json', { persona, verdict: 'approve', summary: 's', findings: [] });
      const out = path.join(dir, 'combined.json');
      const r = runCombine(['--round1', p, '--out', out]);
      assert.equal(r.status, 1, persona);
      assert.match(r.stderr, /unknown persona/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a split lane with only one half present is refused — half the diff got no reviewer', () => {
  const dir = freshTmp();
  try {
    const a = reviewAs(dir, 'auditor-a.json', { persona: 'auditor', verdict: 'approve', summary: 's', findings: [] });
    const out = path.join(dir, 'combined.json');
    const r = runCombine(['--round1', a, '--merge-personas', 'auditor', '--out', out]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /got 1/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--merge-personas leaves the duplicate guard live for lanes it does not name', () => {
  const dir = freshTmp();
  try {
    const a = reviewAs(dir, 'aud-a.json', { persona: 'auditor', verdict: 'approve', summary: 's', findings: [] });
    const b = reviewAs(dir, 'aud-b.json', { persona: 'auditor', verdict: 'approve', summary: 's', findings: [] });
    const s1 = reviewAs(dir, 'stew-1.json', { persona: 'steward', verdict: 'approve', summary: 's', findings: [] });
    const s2 = reviewAs(dir, 'stew-2.json', { persona: 'steward', verdict: 'approve', summary: 's', findings: [] });
    const out = path.join(dir, 'combined.json');
    const r = runCombine(['--round1', a, b, s1, s2, '--merge-personas', 'auditor', '--out', out]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /duplicate persona 'steward'/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--merge-personas is refused for --round2 — round-2 payloads carry no findings to union', () => {
  const dir = freshTmp();
  try {
    const a = review(dir, 'auditor');
    const out = path.join(dir, 'combined.json');
    const r = runCombine(['--round2', a, '--merge-personas', 'auditor', '--out', out]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /applies only to --round1/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--merge-personas rejects a name outside the registry', () => {
  const dir = freshTmp();
  try {
    const a = review(dir, 'auditor');
    const out = path.join(dir, 'combined.json');
    const r = runCombine(['--round1', a, '--merge-personas', 'Auditor', '--out', out]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /not a persona/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a third payload under a merged persona is refused — exactly two halves, as the header says', () => {
  const dir = freshTmp();
  try {
    const files = ['a', 'b', 'c'].map((tag) =>
      reviewAs(dir, `auditor-${tag}.json`, { persona: 'auditor', verdict: 'approve', summary: tag, findings: [] }));
    const out = path.join(dir, 'combined.json');
    const r = runCombine(['--round1', ...files, '--merge-personas', 'auditor', '--out', out]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /got 3/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
