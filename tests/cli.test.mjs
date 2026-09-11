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

// ADVERSE_NO_TELEMETRY belongs on every spawn of the real CLI, not only on the
// `npm test` script: `node --test tests/cli.test.mjs` bypasses the script, and
// these tests then append to the developer's own ~/.cache/adverse/runs.jsonl.
// tests/telemetry.test.mjs turns it back on where that is the subject.
function runCli(args, opts = {}) {
  return spawnSync('node', [BIN, ...args], {
    cwd: ROOT,
    encoding: 'utf-8',
    timeout: 60_000,
    ...opts,
    env: { ...process.env, ADVERSE_NO_TELEMETRY: '1', ...(opts.env ?? {}) },
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

// The keys of --round1 and --round2 are the reviewer tally, and nothing
// checked them. Measured before this: one lane keyed `auditor`, a bare
// zero-width space, and `auditor` with one appended published
// `SHIP (2/3 ship, 1/3 block)` over a live
// critical, with a blank verdicts row and two rows both printing `auditor` —
// the counterfeit a citation's `reporter` was closed against, in the field
// that does the counting.
//
// A table rather than one case, because each of these is a different route to
// the same phantom and the previous two attempts at this class each closed one
// spelling short.
for (const [label, key] of [
  ['an invisible one', '\u200b'],
  ['one that prints as a real lane', 'auditor\u200b'],
  ['a re-cased one', 'Auditor'],
  ['one in a shape agentNames cannot emit', 'auditor_a'],
  ['a suffix longer than the one letter agentNames emits', 'auditor-ab'],
  ['a prototype key JSON.parse makes own', '__proto__'],
  ['an empty one', ''],
  // The two a shape check cannot reach: both are well-formed lane names and
  // neither names a lane. Measured before this: `auditor` (reject, one
  // critical), `referee` (approve) and `helper` (approve) exited 0 with
  // `SHIP (2/3 ship, 1/3 block)` over that critical and "3 reviewers".
  ['an invented one', 'referee'],
  ['a half of an invented one', 'referee-a'],
]) {
  test(`synthesize refuses a round-1 reviewer key: ${label}`, () => {
    const out = freshTmp();
    try {
      writeFileSync(path.join(out, 'r1.json'), JSON.stringify({
        auditor: { persona: 'auditor', verdict: 'reject', summary: 'bug', findings: [] },
        [key]: { persona: key, verdict: 'approve', summary: 'ok', findings: [] },
      }));
      const r = runCli(['synthesize', '--round1', path.join(out, 'r1.json'),
        '--out', path.join(out, 'report.md')]);
      assert.equal(r.status, 2, r.stderr);
      assert.match(r.stderr, /--round1 is keyed by reviewer/);
      assert.match(r.stderr, /names no review lane/);
      assert.match(r.stderr, new RegExp(path.join(out, 'r1.json').replace(/[.\\]/g, '\\$&')));
      assert.equal(existsSync(path.join(out, 'report.md')), false, 'nothing was published');
    } finally { rmSync(out, { recursive: true, force: true }); }
  });
}

// The round-2 keys are worse off than the round-1 keys, not better:
// `crossReviews` answers `true` for any name outside the registry, so the
// roster rule directly below this check passed a phantom through, and one
// `challenge` from it relabels a cross-validated critical `disputed`.
test('synthesize refuses a round-2 reviewer key that names no lane', () => {
  const out = freshTmp();
  try {
    const finding = { severity: 'critical', kind: 'defect', file: 'x.py', line: 1,
      title: 'B', detail: 'd', fix: null };
    writeFileSync(path.join(out, 'r1.json'), JSON.stringify({
      auditor:   { persona: 'auditor', verdict: 'reject', summary: 'bug', findings: [finding] },
      adversary: { persona: 'adversary', verdict: 'reject', summary: 'bug', findings: [finding] },
    }));
    writeFileSync(path.join(out, 'r2.json'), JSON.stringify({
      '\u200b': { persona: '\u200b', challenge: [{ title: 'B', reason: 'no' }] },
    }));
    const r = runCli(['synthesize', '--round1', path.join(out, 'r1.json'),
      '--round2', path.join(out, 'r2.json')]);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /--round2 is keyed by reviewer/);
  } finally { rmSync(out, { recursive: true, force: true }); }
});

// Two characters walked around the refusal that exists to stop exactly this.
// `crossReviews` answers `true` for any name it does not recognize, so it was
// answering about the KEY: `pragmatist` exited 2 as a spoof and `pragmatist-a`
// exited 0, relabeled a critical that two lanes reported as `disputed`, and
// emptied `open_blocking`.
test('synthesize asks whether the LANE cross-reviews, not the key', () => {
  const out = freshTmp();
  try {
    const finding = { severity: 'critical', kind: 'defect', file: 'x.py', line: 1,
      title: 'B', detail: 'd', fix: null };
    writeFileSync(path.join(out, 'r1.json'), JSON.stringify({
      auditor:   { persona: 'auditor', verdict: 'reject', summary: 'bug', findings: [finding] },
      adversary: { persona: 'adversary', verdict: 'reject', summary: 'bug', findings: [finding] },
    }));
    for (const key of ['pragmatist', 'pragmatist-a', 'pragmatist-z']) {
      writeFileSync(path.join(out, 'r2.json'), JSON.stringify({
        [key]: { persona: key, agent: key, challenge: [{ title: 'B', reason: 'no' }] },
      }));
      const r = runCli(['synthesize', '--round1', path.join(out, 'r1.json'),
        '--round2', path.join(out, 'r2.json'),
        '--json-out', path.join(out, 'report.json')]);
      assert.equal(r.status, 2, `${key}: exit ${r.status}\n${r.stderr}`);
      // Quoting the key as the file writes it, not the lane it reduces to.
      // The keys are lanes by the time the report is built, and reading them
      // back from there told an operator whose file says `pragmatist-a` that
      // `'pragmatist'` does not cross-review — a name to search the file for
      // that is not in it.
      assert.match(r.stderr, new RegExp(`'${key}' does not cross-review`), key);
      assert.match(r.stderr, key === 'pragmatist' ? /every kind it owns/
        : /every kind the pragmatist lane owns/, key);
      assert.equal(existsSync(path.join(out, 'report.json')), false, `${key} published`);
    }
  } finally { rmSync(out, { recursive: true, force: true }); }
});

// A refusal about a name that prints as nothing has to render it, or it reads
// as a refusal of a name the operator can already see in the file.
test('synthesize spells out an invisible reviewer key rather than printing it', () => {
  const out = freshTmp();
  try {
    writeFileSync(path.join(out, 'r1.json'), JSON.stringify({
      'auditor\u200b': { persona: 'a', verdict: 'approve', summary: 'ok', findings: [] },
    }));
    const r = runCli(['synthesize', '--round1', path.join(out, 'r1.json')]);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /`auditor\\u\{200b\}`/);
    assert.ok(!r.stderr.includes('\u200b'), 'the character itself is not in the message');
  } finally { rmSync(out, { recursive: true, force: true }); }
});

// A long key cannot push the rest of the refusal off the line it is read on.
test('synthesize bounds the reviewer key it spells out', () => {
  const out = freshTmp();
  try {
    writeFileSync(path.join(out, 'r1.json'), JSON.stringify({
      [`A${'b'.repeat(400)}`]: { persona: 'a', verdict: 'approve', summary: 'ok', findings: [] },
    }));
    const r = runCli(['synthesize', '--round1', path.join(out, 'r1.json')]);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /…/);
    assert.ok(!r.stderr.includes('b'.repeat(100)), 'the key was clipped');
  } finally { rmSync(out, { recursive: true, force: true }); }
});

// A payload that is not an object at all reached `Object.entries` four frames
// down and died naming neither the flag nor the path.
for (const [label, doc] of [['null', null], ['a list', []], ['a number', 7]]) {
  test(`synthesize names the file when --round1 holds ${label}`, () => {
    const out = freshTmp();
    try {
      writeFileSync(path.join(out, 'r1.json'), JSON.stringify(doc));
      const r = runCli(['synthesize', '--round1', path.join(out, 'r1.json')]);
      assert.equal(r.status, 2, r.stderr);
      assert.match(r.stderr, /--round1 is not an object keyed by reviewer/);
      assert.match(r.stderr, new RegExp(path.join(out, 'r1.json').replace(/[.\\]/g, '\\$&')));
    } finally { rmSync(out, { recursive: true, force: true }); }
  });
}

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
    assert.match(readFileSync(path.join(out, 'report.md'), 'utf-8'), /\*\*\[`G1`\]\*\* the guard is a bypass/);
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

test('--help on a subcommand prints usage at exit 0, and a parse refusal is exit 2 without a stack trace', () => {
  const help = runCli(['synthesize', '--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /^Usage: adverse/);

  const refusal = runCli(['synthesize', '--no-such-flag']);
  assert.equal(refusal.status, 2, refusal.stderr);
  assert.match(refusal.stderr, /synthesize: Unknown option/);
  assert.match(refusal.stderr, /Usage: adverse/);
  assert.doesNotMatch(refusal.stderr, /at .*parse_args/);
});

test('--plan reconciles the run the payloads prove against the run the plan describes', () => {
  // A planned lane with no payload reviewed nothing, and "reviewed and found
  // nothing" is the same input downstream as "never looked" — the silence
  // --skipped/--degraded exist to break, previously checked by nobody.
  const out = freshTmp();
  try {
    const round1 = {
      auditor: { persona: 'auditor', verdict: 'approve', summary: 'ok', findings: [] },
      steward: { persona: 'steward', verdict: 'approve', summary: 'ok', findings: [] },
    };
    writeFileSync(path.join(out, 'r1.json'), JSON.stringify(round1));
    writeFileSync(path.join(out, 'plan.json'), JSON.stringify({
      lanes: [
        { persona: 'auditor', run: true },
        { persona: 'steward', run: true },
        { persona: 'adversary', run: true },
        { persona: 'pragmatist', run: false, reason: 'small diff' },
      ],
    }));
    const args = ['synthesize', '--round1', path.join(out, 'r1.json'),
      '--plan', path.join(out, 'plan.json'), '--out', path.join(out, 'report.md')];

    const silent = runCli(args);
    assert.equal(silent.status, 2, silent.stderr);
    assert.match(silent.stderr, /the plan ran adversary/);

    const declared = runCli([...args, '--degraded', 'adversary']);
    assert.ok(declared.status === 0 || declared.status === 1, declared.stderr);
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test('--plan accounts a split lane under either spelling of its payloads', () => {
  // combine.mjs unions a split lane's halves under the bare persona, while
  // --skipped/--degraded speak agentNames' persona-a/-b. Requiring one
  // spelling false-refused the other: a plan naming {auditor, agents: 2} with
  // its lane fully reported still exited 2.
  //
  // The accounting reads the spelling the payloads ARRIVED under, not the
  // lanes they reduce to, and the last case is why: against a lane-keyed set,
  // a run that produced only `auditor-a` reads as the auditor fully accounted
  // for, and half the files reviewed by nobody reads exactly like a clean
  // review.
  const out = freshTmp();
  try {
    writeFileSync(path.join(out, 'plan.json'), JSON.stringify({
      lanes: [
        { persona: 'auditor', run: true, agents: 2 },
        { persona: 'steward', run: true },
      ],
    }));
    const payload = (persona) => (
      { persona, verdict: 'approve', summary: 'ok', findings: [] });
    const args = (r1) => ['synthesize', '--round1', path.join(out, r1),
      '--plan', path.join(out, 'plan.json'), '--out', path.join(out, 'report.md')];

    writeFileSync(path.join(out, 'combined.json'), JSON.stringify({
      auditor: payload('auditor'),
      steward: payload('steward'),
    }));
    const combined = runCli(args('combined.json'));
    assert.ok(combined.status === 0 || combined.status === 1,
      `combine's bare-persona union is accounted: ${combined.stderr}`);

    writeFileSync(path.join(out, 'half.json'), JSON.stringify({
      'auditor-a': { ...payload('auditor'), agent: 'auditor-a' },
      steward: payload('steward'),
    }));
    const half = runCli(args('half.json'));
    assert.equal(half.status, 2, half.stderr);
    assert.match(half.stderr, /auditor-b/, 'the refusal names the missing half');
    assert.doesNotMatch(half.stderr, /as one agent/,
      'a lane the plan split is not accused of a misspelling');

    // The mirror: the plan ran the auditor as ONE agent and the payload is
    // keyed by a half of it. `byLane` reads that payload as the auditor's, so
    // the accounting has a payload for the lane and no name for it — refused,
    // because agentNames writes `auditor` for a lane of one and the two files
    // disagree about how many agents reviewed, but refused by a sentence that
    // says so rather than by "no payload accounts for it" about a payload that
    // is sitting right there.
    writeFileSync(path.join(out, 'unsplit-plan.json'), JSON.stringify({
      lanes: [{ persona: 'auditor', run: true }, { persona: 'steward', run: true }],
    }));
    const unsplit = runCli(['synthesize', '--round1', path.join(out, 'half.json'),
      '--plan', path.join(out, 'unsplit-plan.json'), '--out', path.join(out, 'report.md')]);
    assert.equal(unsplit.status, 2, unsplit.stderr);
    assert.match(unsplit.stderr, /ran auditor as one agent/);
    assert.doesNotMatch(unsplit.stderr, /no payload/,
      'the refusal does not deny a payload that byLane accepted');

    // And a lane that produced nothing at all is still named, first. It is the
    // more serious of the two disagreements and the one that hides: refusing on
    // the misspelling alone said nothing about the adversary, whose files no
    // reviewer opened, until the whole run had been repeated to find out.
    writeFileSync(path.join(out, 'lone-half.json'), JSON.stringify({
      'auditor-a': { ...payload('auditor'), agent: 'auditor-a' },
    }));
    writeFileSync(path.join(out, 'two-lane-plan.json'), JSON.stringify({
      lanes: [{ persona: 'auditor', run: true }, { persona: 'adversary', run: true }],
    }));
    const both = runCli(['synthesize', '--round1', path.join(out, 'lone-half.json'),
      '--plan', path.join(out, 'two-lane-plan.json'), '--out', path.join(out, 'report.md')]);
    assert.equal(both.status, 2, both.stderr);
    assert.match(both.stderr, /ran adversary but no payload/);
    assert.match(both.stderr, /Also, the plan ran auditor as one agent/);
    assert.ok(both.stderr.indexOf('adversary') < both.stderr.indexOf('as one agent'),
      'the lane nobody reviewed is named first');
  } finally { rmSync(out, { recursive: true, force: true }); }
});

// SKILL.md says it outright under the split-lane instructions: "The
// synthesizer counts distinct personas, not agents, so a split lane cannot
// inflate consensus." That held on the bridge path, where combine.mjs unions
// halves under the bare persona, and not here, where every key was a reviewer.
// Measured before this: `auditor` (reject, one critical), `auditor-a`
// (approve) and `auditor-b` (approve) exited 0 with
// `SHIP (2/3 ship, 1/3 block)`, "1 total across 3 reviewers" and
// `Open blocking: 0`.
test('synthesize refuses two payloads for one lane rather than counting two reviewers', () => {
  const out = freshTmp();
  try {
    const payload = (persona) => (
      { persona, verdict: 'approve', summary: 'ok', findings: [] });
    for (const keys of [['auditor', 'auditor-a'], ['auditor-a', 'auditor-b'],
      ['auditor-a', 'auditor-z']]) {
      writeFileSync(path.join(out, 'r1.json'), JSON.stringify({
        steward: payload('steward'),
        ...Object.fromEntries(keys.map((k) => [k, payload('auditor')])),
      }));
      const r = runCli(['synthesize', '--round1', path.join(out, 'r1.json'),
        '--out', path.join(out, 'report.md')]);
      assert.equal(r.status, 2, `${keys}: exit ${r.status}\n${r.stderr}`);
      assert.match(r.stderr, /two payloads for the auditor lane/, String(keys));
      assert.match(r.stderr, /--merge-personas auditor/, String(keys));
      assert.equal(existsSync(path.join(out, 'report.md')), false, String(keys));
    }
  } finally { rmSync(out, { recursive: true, force: true }); }
});

// A lane reviewed in halves is ONE reviewer, and the half is not thrown away:
// it moves to `agent`, which is where `reportedBy`'s self-ruling guard reads
// it. Measured before this: `--round1` keyed `auditor` against `--round2`
// keyed `auditor-a` let the auditor challenge its own critical — `disputed`,
// `Open blocking: 0` — because the guard compared the raw round-2 key against
// the raw round-1 key and they are different strings.
test('a lane that reviewed in halves is one reviewer, and cannot rule on itself', () => {
  const out = freshTmp();
  try {
    const finding = { severity: 'critical', kind: 'defect', file: 'x.py', line: 1,
      title: 'B', detail: 'd', fix: null };
    // The auditor reviewed in halves and `-a` found B; the steward found it
    // too, so B is cross-validated and open-blocking. That is the finding a
    // self-challenge would move out of the gate.
    writeFileSync(path.join(out, 'r1.json'), JSON.stringify({
      'auditor-a': { persona: 'auditor', agent: 'auditor-a', verdict: 'reject',
        summary: 'bug', findings: [finding] },
      steward: { persona: 'steward', verdict: 'reject', summary: 'bug',
        findings: [finding] },
    }));
    const synth = (r2, name) => {
      const args = ['synthesize', '--round1', path.join(out, 'r1.json'),
        '--json-out', path.join(out, name)];
      if (r2) args.push('--round2', path.join(out, r2));
      const r = runCli(args);
      assert.ok(r.status === 0 || r.status === 1, r.stderr);
      return JSON.parse(readFileSync(path.join(out, name), 'utf-8'));
    };

    const base = synth(null, 'base.json');
    assert.deepEqual(Object.keys(base.verdicts), ['auditor', 'steward'],
      'a half is counted as its lane');
    assert.deepEqual(base.findings[0].reporters, ['auditor', 'steward']);
    assert.equal(base.findings[0].confidence, 'cross-validated');
    assert.equal(base.open_blocking.length, 1);

    // The lane ruling on its own finding is discarded, however it is spelled.
    // Before this, `auditor-a` in round 2 against `auditor-a` in round 1 read
    // as two different reviewers to `reportedBy`, and the auditor challenged
    // its own critical out of the gate.
    writeFileSync(path.join(out, 'self.json'), JSON.stringify({
      'auditor-a': { persona: 'auditor', agent: 'auditor-a',
        challenge: [{ title: 'B', reason: 'no' }] },
    }));
    const ruled = synth('self.json', 'self-out.json');
    assert.equal(ruled.findings[0].confidence, 'cross-validated',
      'the auditor cannot discard its own critical');
    assert.equal(ruled.open_blocking.length, 1);

    // And the sibling half's ruling still counts — `auditor-b` read different
    // files, and discarding it is the failure the agent stamp exists to
    // prevent. Both spellings of that payload: one that declares its own
    // `agent`, and one that carries the id only in its key, which is the
    // shape this boundary has to stamp or the ruling is read as the whole
    // lane's and discarded.
    for (const [label, payload] of [
      ['declaring its agent', { persona: 'auditor', agent: 'auditor-b',
        challenge: [{ title: 'B', reason: 'no' }] }],
      ['carrying the id only in its key', { persona: 'auditor',
        challenge: [{ title: 'B', reason: 'no' }] }],
    ]) {
      writeFileSync(path.join(out, 'sibling.json'), JSON.stringify({ 'auditor-b': payload }));
      const sibling = synth('sibling.json', 'sibling-out.json');
      assert.equal(sibling.findings[0].confidence, 'disputed',
        `a sibling's ruling counts, ${label}`);
    }
  } finally { rmSync(out, { recursive: true, force: true }); }
});

// Who wrote a review file is settled by how it is filed. `agent` inside it is
// that file's own account of itself, and believing the account cost a finding
// in both directions — the bridge is exposed to neither, because validate.mjs
// holds `agent` against the filename. Nothing holds it here, so this does:
// refused where the file says it outright, overwritten where one entry does.
test('a payload whose header contradicts the key it was filed under is refused', () => {
  const out = freshTmp();
  try {
    // `auditor-b` is the sibling's id, which the LANE check accepts because it
    // is this lane's — so believing it attributed the work to the half that did
    // not write it and let `auditor-a`'s own round-2 challenge rule on it as an
    // independent reviewer. The other four are the trap combine.mjs's
    // `declaresAgent` is named for: to `=== undefined` an ill-formed `agent` is
    // a declaration too, so it suppressed the stamp, resolved the entry to the
    // bare lane, and got `auditor-b`'s honest ruling discarded as the lane
    // ruling on itself.
    for (const [label, claim, shown] of [
      ["the sibling's id", 'auditor-b', '"auditor-b"'],
      ['a null one', null, 'null'],
      ['an empty one', '', '""'],
      ['a numeric one', 42, '42'],
      ["another lane's id", 'steward', '"steward"'],
    ]) {
      writeFileSync(path.join(out, 'r1.json'), JSON.stringify({
        'auditor-a': { persona: 'auditor', agent: claim, verdict: 'approve',
          summary: 'ok', findings: [] },
        steward: { persona: 'steward', verdict: 'approve', summary: 'ok', findings: [] },
      }));
      const r = runCli(['synthesize', '--round1', path.join(out, 'r1.json'),
        '--json-out', path.join(out, 'report.json')]);
      assert.equal(r.status, 2, `${label}: exit ${r.status}\n${r.stderr}`);
      assert.match(r.stderr, /`auditor-a` says its `agent` is/, label);
      assert.ok(r.stderr.includes(shown), `${label}: ${r.stderr}`);
      assert.equal(existsSync(path.join(out, 'report.json')), false, label);
    }

    // The two spellings that are not a contradiction: the key repeated, and no
    // claim at all. Neither may be refused — the first is what agentNames and
    // validate.mjs produce together, and the second is every orchestrator that
    // predates the field.
    for (const [label, header] of [
      ['the key repeated', { agent: 'auditor-a' }],
      ['no claim at all', {}],
    ]) {
      writeFileSync(path.join(out, 'r1.json'), JSON.stringify({
        'auditor-a': { persona: 'auditor', ...header, verdict: 'approve',
          summary: 'ok', findings: [] },
        steward: { persona: 'steward', verdict: 'approve', summary: 'ok', findings: [] },
      }));
      const r = runCli(['synthesize', '--round1', path.join(out, 'r1.json'),
        '--out', path.join(out, 'report.md')]);
      assert.ok(r.status === 0 || r.status === 1, `${label}: ${r.stderr}`);
    }

    // And the bare lane has no half to contradict: combine.mjs copies a lone
    // half's payload through untouched, header included, and keys it by the
    // persona.
    writeFileSync(path.join(out, 'r1.json'), JSON.stringify({
      auditor: { persona: 'auditor', agent: 'auditor-a', verdict: 'approve',
        summary: 'ok', findings: [] },
      steward: { persona: 'steward', verdict: 'approve', summary: 'ok', findings: [] },
    }));
    const union = runCli(['synthesize', '--round1', path.join(out, 'r1.json'),
      '--out', path.join(out, 'report.md')]);
    assert.ok(union.status === 0 || union.status === 1, union.stderr);
  } finally { rmSync(out, { recursive: true, force: true }); }
});

// The same claim, one level down, where `claimedAgent` reads it FIRST. A header
// that agrees with the key closes nothing here.
test('an entry is stamped with the key its file was filed under, not with what it claims', () => {
  const out = freshTmp();
  try {
    const finding = { severity: 'critical', kind: 'defect', file: 'x.py', line: 1,
      title: 'B', detail: 'd', fix: null };
    const synth = (r2, name) => {
      const args = ['synthesize', '--round1', path.join(out, 'r1.json'),
        '--json-out', path.join(out, name)];
      if (r2) args.push('--round2', path.join(out, r2));
      const r = runCli(args);
      assert.ok(r.status === 0 || r.status === 1, r.stderr);
      return JSON.parse(readFileSync(path.join(out, name), 'utf-8'));
    };
    writeFileSync(path.join(out, 'self.json'), JSON.stringify({
      'auditor-a': { persona: 'auditor', challenge: [{ title: 'B', reason: 'no' }] },
    }));
    writeFileSync(path.join(out, 'sibling.json'), JSON.stringify({
      'auditor-b': { persona: 'auditor', challenge: [{ title: 'B', reason: 'no' }] },
    }));

    for (const [label, claim] of [
      ["the sibling's id", 'auditor-b'],
      ['a null one', null],
      ['an empty one', ''],
      ['a numeric one', 42],
      ["another lane's id", 'steward'],
    ]) {
      writeFileSync(path.join(out, 'r1.json'), JSON.stringify({
        'auditor-a': { persona: 'auditor', verdict: 'reject', summary: 'bug',
          findings: [{ ...finding, agent: claim }] },
        steward: { persona: 'steward', verdict: 'reject', summary: 'bug',
          findings: [finding] },
      }));

      const base = synth(null, 'base.json');
      assert.equal(base.findings[0].confidence, 'cross-validated', label);
      assert.equal(base.open_blocking.length, 1, label);

      const self = synth('self.json', 'self-out.json');
      assert.equal(self.findings[0].confidence, 'cross-validated',
        `the lane cannot discard its own critical, its finding claiming ${label}`);
      assert.equal(self.open_blocking.length, 1, label);

      const sibling = synth('sibling.json', 'sibling-out.json');
      assert.equal(sibling.findings[0].confidence, 'disputed',
        `the sibling's ruling still counts, the finding claiming ${label}`);
    }

    // The round-2 entry, the other end of the same field. A lane whose only
    // reporter is itself cannot mint a second voice by filing a validate that
    // says a sibling wrote it: `solo` either way, and no validators.
    writeFileSync(path.join(out, 'r1.json'), JSON.stringify({
      'auditor-a': { persona: 'auditor', verdict: 'reject', summary: 'bug',
        findings: [finding] },
      steward: { persona: 'steward', verdict: 'approve', summary: 'ok', findings: [] },
    }));
    for (const [label, entry] of [
      ['claiming the sibling', { title: 'B', reason: 'yes', agent: 'auditor-b' }],
      ['claiming nothing', { title: 'B', reason: 'yes' }],
    ]) {
      writeFileSync(path.join(out, 'r2.json'), JSON.stringify({
        'auditor-a': { persona: 'auditor', validate: [entry] },
      }));
      const minted = synth('r2.json', 'minted.json');
      assert.equal(minted.findings[0].confidence, 'solo',
        `a lane cannot validate its own finding, ${label}`);
      assert.equal(minted.open_blocking.length, 0, label);
    }

    // And the challenge side of round 2, where the same claim empties
    // `Open blocking` instead of filling `validators`.
    writeFileSync(path.join(out, 'r1.json'), JSON.stringify({
      'auditor-a': { persona: 'auditor', verdict: 'reject', summary: 'bug',
        findings: [finding] },
      steward: { persona: 'steward', verdict: 'reject', summary: 'bug',
        findings: [finding] },
    }));
    writeFileSync(path.join(out, 'r2.json'), JSON.stringify({
      'auditor-a': { persona: 'auditor',
        challenge: [{ title: 'B', reason: 'no', agent: 'auditor-b' }] },
    }));
    const challenged = synth('r2.json', 'challenged.json');
    assert.equal(challenged.findings[0].confidence, 'cross-validated',
      'a challenge cannot borrow the sibling to discard the lane\'s own critical');
    assert.equal(challenged.open_blocking.length, 1);
  } finally { rmSync(out, { recursive: true, force: true }); }
});

// The other half of the same rule, and it splits: under the bare lane the
// ENTRIES keep their ids and the HEADER does not. A lane-keyed file may hold
// both halves' work — `mergeSplitReviews` stamps each half's id onto that
// half's entries, and overwriting those is what makes `auditor-b`'s ruling on
// `auditor-a`'s finding read as the lane ruling on itself, a voice lost rather
// than minted, and still wrong. A header is one claim about the whole file, and
// a file the whole lane is accountable for is the lane's.
test('a payload filed under the bare lane keeps the ids its entries carry', () => {
  const out = freshTmp();
  try {
    const finding = { severity: 'critical', kind: 'defect', file: 'x.py', line: 1,
      title: 'B', detail: 'd', fix: null };
    writeFileSync(path.join(out, 'r1.json'), JSON.stringify({
      auditor: { persona: 'auditor', verdict: 'reject', summary: 'bug',
        findings: [{ ...finding, agent: 'auditor-a' }] },
      steward: { persona: 'steward', verdict: 'approve', summary: 'ok', findings: [] },
    }));
    writeFileSync(path.join(out, 'r2.json'), JSON.stringify({
      auditor: { persona: 'auditor',
        validate: [{ title: 'B', reason: 'yes', agent: 'auditor-b' }] },
    }));
    const r = runCli(['synthesize', '--round1', path.join(out, 'r1.json'),
      '--round2', path.join(out, 'r2.json'),
      '--json-out', path.join(out, 'report.json')]);
    assert.ok(r.status === 0 || r.status === 1, r.stderr);
    const report = JSON.parse(readFileSync(path.join(out, 'report.json'), 'utf-8'));
    assert.equal(report.findings[0].confidence, 'consensus',
      "the sibling half's validate counts");
    assert.equal(report.open_blocking.length, 1);
  } finally { rmSync(out, { recursive: true, force: true }); }
});

// combine.mjs copies a LONE half's payload through untouched and keys it by the
// persona, so `agent: 'auditor-a'` beside `persona: 'auditor'` is a shape the
// documented pipeline writes — and it means one agent reviewed, which cannot
// rule on its own finding. Believing the claim instead hands one lane two names
// under one key, which is the whole hole this branch exists to close, reopened
// one field over. Both directions measured before this: `auditor-a` in round 1
// against `auditor-b` in round 2 took a cross-validated critical to `disputed`
// with nothing open, and took a solo critical to `consensus` with one.
test('a bare-lane header names the lane, so one lane cannot cross-examine itself', () => {
  const out = freshTmp();
  try {
    const finding = { severity: 'critical', kind: 'defect', file: 'x.py', line: 1,
      title: 'B', detail: 'd', fix: null };
    const half = (round) => ({
      auditor: { persona: 'auditor', agent: 'auditor-a', verdict: 'reject',
        summary: 'bug', findings: [finding] },
      ...round,
    });
    const synth = (name) => {
      const r = runCli(['synthesize', '--round1', path.join(out, 'r1.json'),
        '--round2', path.join(out, 'r2.json'), '--json-out', path.join(out, name)]);
      assert.ok(r.status === 0 || r.status === 1, r.stderr);
      return JSON.parse(readFileSync(path.join(out, name), 'utf-8'));
    };

    writeFileSync(path.join(out, 'r2.json'), JSON.stringify({
      auditor: { persona: 'auditor', agent: 'auditor-b',
        challenge: [{ title: 'B', reason: 'no' }] },
    }));
    writeFileSync(path.join(out, 'r1.json'), JSON.stringify(half({
      adversary: { persona: 'adversary', verdict: 'reject', summary: 'bug',
        findings: [finding] },
    })));
    const challenged = synth('challenged.json');
    assert.equal(challenged.findings[0].confidence, 'cross-validated',
      'a second name under one key does not discard the lane\'s own critical');
    assert.equal(challenged.open_blocking.length, 1);

    writeFileSync(path.join(out, 'r2.json'), JSON.stringify({
      auditor: { persona: 'auditor', agent: 'auditor-b',
        validate: [{ title: 'B', reason: 'yes' }] },
    }));
    writeFileSync(path.join(out, 'r1.json'), JSON.stringify(half({
      adversary: { persona: 'adversary', verdict: 'approve', summary: 'ok', findings: [] },
    })));
    const validated = synth('validated.json');
    assert.equal(validated.findings[0].confidence, 'solo',
      'a second name under one key does not vouch for the lane\'s own critical');
    assert.equal(validated.open_blocking.length, 0);
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test('help is an option the parser owns, not a substring scanned out of argv', () => {
  // The first cut scanned the raw argv for --help/-h, so any option VALUE equal
  // to -h silently skipped the run and exited 0 — on a CI gate whose exit-code
  // contract reads 0 as "reviewed, clean". Each shape below must refuse loudly
  // or run; none may print help and exit 0.
  const value = runCli(['synthesize', '--round1', '/nonexistent', '--out', '-h']);
  assert.equal(value.status, 2, `${value.stdout}${value.stderr}`);
  assert.doesNotMatch(value.stdout, /^Usage: adverse/);

  const diff = runCli(['review', '--diff', '-h']);
  assert.equal(diff.status, 2, `${diff.stdout}${diff.stderr}`);
  assert.doesNotMatch(diff.stdout, /^Usage: adverse/);

  const unknown = runCli(['bogus', '--help']);
  assert.equal(unknown.status, 2, unknown.stdout);
  assert.match(unknown.stderr, /unknown command: bogus/);
});
