// End-to-end CLI smoke tests via subprocess. Uses fake-agent.mjs to simulate
// a coding agent so no real model is spawned.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const BIN = path.join(ROOT, 'bin', 'adverse.mjs');
const FAKE = path.join(ROOT, 'tests', 'fixtures', 'fake-agent.mjs');
const FLAKY = path.join(ROOT, 'tests', 'fixtures', 'flaky-agent.mjs');

function freshTmp() {
  return mkdtempSync(path.join(tmpdir(), 'adverse-cli-'));
}

function buildBuggyTarget() {
  const dir = freshTmp();
  writeFileSync(path.join(dir, 'auth.py'),
    "import hashlib\n\n" +
    "def hash_password(p, salt=''):\n" +
    "    return hashlib.md5((p+salt).encode()).hexdigest()\n\n" +
    "def check_user(name, conn):\n" +
    "    q = \"SELECT * FROM users WHERE name = '\" + name + \"'\"\n" +
    "    return conn.execute(q).fetchone()\n");
  return dir;
}

function runCli(args, opts = {}) {
  return spawnSync('node', [BIN, ...args], {
    cwd: ROOT, encoding: 'utf-8', timeout: 60_000, ...opts,
  });
}

test('full pipeline produces a report', () => {
  const target = buildBuggyTarget();
  try {
    const r = runCli(['review', target, '--agent', `node ${FAKE}`]);
    assert.ok(r.status === 0 || r.status === 1, `unexpected status ${r.status}: ${r.stderr}`);
    assert.match(r.stdout, /Adversarial Code Review/);
    assert.match(r.stdout, /Reviewer verdicts/);
    for (const persona of ['auditor', 'adversary', 'pragmatist']) {
      assert.match(r.stdout, new RegExp(persona));
    }
  } finally { rmSync(target, { recursive: true, force: true }); }
});

test('--out, --json-out, --html-out write to disk', () => {
  const target = buildBuggyTarget();
  const out = freshTmp();
  try {
    const r = runCli([
      'review', target, '--agent', `node ${FAKE}`,
      '--out', path.join(out, 'report.md'),
      '--json-out', path.join(out, 'report.json'),
      '--html-out', path.join(out, 'report.html'),
    ]);
    assert.ok(r.status === 0 || r.status === 1, r.stderr);
    assert.ok(existsSync(path.join(out, 'report.md')));
    assert.ok(existsSync(path.join(out, 'report.json')));
    assert.ok(existsSync(path.join(out, 'report.html')));
    const json = JSON.parse(readFileSync(path.join(out, 'report.json'), 'utf-8'));
    assert.equal(typeof json.consensus_label, 'string');
    assert.ok(Array.isArray(json.findings));
    const html = readFileSync(path.join(out, 'report.html'), 'utf-8');
    assert.match(html, /<!doctype html>/i);
    assert.match(html, /Adversarial Code Review/);
  } finally {
    rmSync(target, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});

test('--single-round skips round 2', () => {
  const target = buildBuggyTarget();
  try {
    const r = runCli(['review', target, '--agent', `node ${FAKE}`, '--single-round']);
    assert.ok(r.status === 0 || r.status === 1, r.stderr);
    assert.ok(!r.stderr.toLowerCase().includes('round 2'));
  } finally { rmSync(target, { recursive: true, force: true }); }
});

test('--personas subset works', () => {
  const target = buildBuggyTarget();
  try {
    const r = runCli([
      'review', target, '--agent', `node ${FAKE}`,
      '--personas', 'auditor,adversary',
    ]);
    assert.ok(r.status === 0 || r.status === 1, r.stderr);
    // Pragmatist must not appear in the verdicts table.
    assert.ok(!r.stdout.toLowerCase().includes('| pragmatist |'));
  } finally { rmSync(target, { recursive: true, force: true }); }
});

test('rejects single-persona run', () => {
  const target = buildBuggyTarget();
  try {
    const r = runCli([
      'review', target, '--agent', `node ${FAKE}`,
      '--personas', 'auditor',
    ]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /at least 2 personas/);
  } finally { rmSync(target, { recursive: true, force: true }); }
});

test('rejects unknown persona', () => {
  const target = buildBuggyTarget();
  try {
    const r = runCli([
      'review', target, '--agent', `node ${FAKE}`,
      '--personas', 'auditor,wizard',
    ]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /wizard/);
  } finally { rmSync(target, { recursive: true, force: true }); }
});

test('handles failed persona (degraded run)', () => {
  const target = buildBuggyTarget();
  try {
    const r = runCli(['review', target, '--agent', `node ${FLAKY}`, '--single-round']);
    assert.ok(r.status === 0 || r.status === 1, r.stderr);
    assert.match(r.stdout, /Degraded run/);
    assert.match(r.stdout, /adversary/);
  } finally { rmSync(target, { recursive: true, force: true }); }
});

test('--save-artifacts saves per-persona JSON', async () => {
  const target = buildBuggyTarget();
  const artifacts = freshTmp();
  try {
    const r = runCli([
      'review', target, '--agent', `node ${FAKE}`,
      '--save-artifacts', artifacts,
    ]);
    assert.ok(r.status === 0 || r.status === 1, r.stderr);
    const { readdirSync } = await import('node:fs');
    const files = readdirSync(artifacts);
    assert.ok(files.includes('source.txt'));
    assert.ok(files.some((f) => f.startsWith('round1_')));
    assert.ok(files.some((f) => f.startsWith('round2_')));
  } finally {
    rmSync(target, { recursive: true, force: true });
    rmSync(artifacts, { recursive: true, force: true });
  }
});

test('personas command lists all three', () => {
  const r = runCli(['personas']);
  assert.equal(r.status, 0);
  for (const n of ['auditor', 'adversary', 'pragmatist']) {
    assert.match(r.stdout, new RegExp(n));
  }
});

test('target must exist', () => {
  const r = runCli(['review', '/path/that/does/not/exist']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no such path/);
});

test('synthesize subcommand reads disk and emits report', () => {
  const out = freshTmp();
  try {
    const round1 = {
      auditor: {
        persona: 'auditor', verdict: 'conditional', summary: 'one bug',
        findings: [{ severity: 'critical', file: 'x.py', line: 1, title: 'B', detail: 'd', fix: null }],
      },
      adversary: { persona: 'adversary', verdict: 'approve', summary: 'ok', findings: [] },
    };
    writeFileSync(path.join(out, 'r1.json'), JSON.stringify(round1));
    const r = runCli([
      'synthesize',
      '--round1', path.join(out, 'r1.json'),
      '--out', path.join(out, 'report.md'),
      '--json-out', path.join(out, 'report.json'),
    ]);
    assert.ok(r.status === 0 || r.status === 1, r.stderr);
    assert.ok(existsSync(path.join(out, 'report.md')));
    assert.ok(existsSync(path.join(out, 'report.json')));
  } finally { rmSync(out, { recursive: true, force: true }); }
});

// The roster rule lived only in src/roster.mjs, which the Skill bridges call
// and the shipped binary does not — so `adverse synthesize` still accepted a
// round-2 payload from a lane that never cross-reviews, and one such
// `challenge` moves a critical reported by two lanes out of `Open blocking`.
// The same rule, on both paths.
test('synthesize refuses a round-2 payload from a lane that does not cross-review', () => {
  const out = freshTmp();
  try {
    const round1 = {
      auditor:   { persona: 'auditor', verdict: 'reject', summary: 'bug', findings: [
        { severity: 'critical', kind: 'defect', file: 'x.py', line: 1, title: 'B', detail: 'd', fix: null }] },
      adversary: { persona: 'adversary', verdict: 'reject', summary: 'bug', findings: [
        { severity: 'critical', kind: 'defect', file: 'x.py', line: 1, title: 'B', detail: 'd', fix: null }] },
    };
    writeFileSync(path.join(out, 'r1.json'), JSON.stringify(round1));
    writeFileSync(path.join(out, 'r2.json'), JSON.stringify({
      pragmatist: { persona: 'pragmatist', challenge: [{ title: 'B', reason: 'no' }] },
    }));
    const r = runCli(['synthesize', '--round1', path.join(out, 'r1.json'),
      '--round2', path.join(out, 'r2.json')]);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /does not cross-review/);
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test('synthesize subcommand records --skipped, --degraded, and --round2-skipped', () => {
  const out = freshTmp();
  try {
    const round1 = {
      auditor: { persona: 'auditor', verdict: 'approve', summary: 'ok', findings: [] },
      steward: { persona: 'steward', verdict: 'approve', summary: 'ok', findings: [] },
    };
    writeFileSync(path.join(out, 'r1.json'), JSON.stringify(round1));
    const r = runCli([
      'synthesize',
      '--round1', path.join(out, 'r1.json'),
      '--skipped', 'adversary=no trust boundary in the diff',
      '--degraded', 'pragmatist',
      '--round2-skipped', 'no blocking finding in round 1',
      '--out', path.join(out, 'report.md'),
      '--json-out', path.join(out, 'report.json'),
    ]);
    assert.equal(r.status, 0, r.stderr);
    const md = readFileSync(path.join(out, 'report.md'), 'utf-8');
    assert.match(md, /adversary/);
    assert.match(md, /no trust boundary in the diff/);
    assert.match(md, /Degraded run/);
    assert.match(md, /pragmatist/);
    assert.match(md, /Round 2 skipped:\*\* no blocking finding in round 1/);
    const json = JSON.parse(readFileSync(path.join(out, 'report.json'), 'utf-8'));
    assert.equal(json.round2_skipped, 'no blocking finding in round 1');
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test('synthesize --briefing carries the root causes into every output', () => {
  const out = freshTmp();
  try {
    const finding = (title, severity, file, line) =>
      ({ severity, kind: 'defect', file, line, counterpart: null, title, detail: 'd', fix: null });
    writeFileSync(path.join(out, 'r1.json'), JSON.stringify({
      auditor: { persona: 'auditor', verdict: 'conditional', summary: '', findings: [finding('guard is unreachable', 'warning', 'a.py', 10)] },
      adversary: { persona: 'adversary', verdict: 'reject', summary: '', findings: [finding('the guard is a bypass', 'critical', 'a.py', 14)] },
    }));
    // Two independent voices: confirming a group is one disposition covering N
    // findings, so it takes the same cross-validation the report's confidence
    // labels take.
    //
    // The second voice is the AUDITOR, not the Pragmatist. SKILL.md Phase 4 is
    // explicit that "the Pragmatist skips round 2", so a round2-pragmatist
    // payload is not something the documented flow produces — it was only ever
    // the nearest second persona to hand here, and it is now refused. The
    // Auditor is not discounted as `selfRuled`, because it is not the sole
    // reporter of every citation (F2 is the Adversary's).
    writeFileSync(path.join(out, 'r2.json'), JSON.stringify({
      steward: { persona: 'steward', validate: [], challenge: [], added: [],
                 groups: [{ id: 'G1', ruling: 'one', reason: 'one unreachable guard' }] },
      auditor: { persona: 'auditor', validate: [], challenge: [], added: [],
                 groups: [{ id: 'G1', ruling: 'one', reason: 'agreed' }] },
    }));

    writeFileSync(path.join(out, 'briefing.json'), JSON.stringify({
      findings: [], groups: [{
        id: 'G1', title: 'the guard is a bypass', severity: 'critical', kinds: ['defect'],
        files: ['a.py'], reporters: ['auditor', 'adversary'], members: ['F1', 'F2'],
        via: ['cluster'], oversized: false, anchor: 'F2',

        citations: [
          { id: 'F1', reporter: 'auditor', kind: 'defect', severity: 'warning', file: 'a.py', line: 10, title: 'guard is unreachable' },
          { id: 'F2', reporter: 'adversary', kind: 'defect', severity: 'critical', file: 'a.py', line: 14, title: 'the guard is a bypass' },
        ],
      }],
    }));
    const r = runCli([
      'synthesize',
      '--round1', path.join(out, 'r1.json'),
      '--round2', path.join(out, 'r2.json'),
      '--briefing', path.join(out, 'briefing.json'),
      '--out', path.join(out, 'report.md'),
      '--json-out', path.join(out, 'report.json'),
      '--html-out', path.join(out, 'report.html'),
    ]);
    assert.ok(r.status === 0 || r.status === 1, r.stderr);
    assert.match(readFileSync(path.join(out, 'report.md'), 'utf-8'), /\*\*\[G1\]\*\* the guard is a bypass/);
    assert.match(readFileSync(path.join(out, 'report.html'), 'utf-8'), /Root causes — 1 confirmed of 1 proposed/);
    const json = JSON.parse(readFileSync(path.join(out, 'report.json'), 'utf-8'));
    assert.equal(json.root_causes[0].status, 'confirmed');
    assert.deepEqual(json.findings.map((f) => f.group), ['G1', 'G1']);
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test('synthesize --briefing pointed at something that is not a briefing is a usage error', () => {
  const out = freshTmp();
  try {
    writeFileSync(path.join(out, 'r1.json'), JSON.stringify({ auditor: { persona: 'auditor', verdict: 'approve', summary: '', findings: [] } }));
    writeFileSync(path.join(out, 'nope.json'), JSON.stringify({ findings: [] }));
    const r = runCli(['synthesize', '--round1', path.join(out, 'r1.json'), '--briefing', path.join(out, 'nope.json')]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /not a briefing\.json/);
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test('synthesize subcommand rejects an empty --round2-skipped reason', () => {
  const out = freshTmp();
  try {
    const round1 = { auditor: { persona: 'auditor', verdict: 'approve', summary: 'ok', findings: [] } };
    writeFileSync(path.join(out, 'r1.json'), JSON.stringify(round1));
    const r = runCli(['synthesize', '--round1', path.join(out, 'r1.json'), '--round2-skipped', '']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /non-empty reason/);
  } finally { rmSync(out, { recursive: true, force: true }); }
});
