// Tests for skills/adverse-review/scripts/plan.mjs — the budget bridge, driven
// as a subprocess like combine.test.mjs drives its bridge.
//
// The panel found every defect in this file's first version by running it by
// hand, because nothing else did. The end-to-end cases pin the two attacks the
// policy exists to resist: content hidden from the diff (`.gitattributes
// -diff`) and a pure-deletion change, both of which must land OUTSIDE the
// cheap shape.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const PLAN = path.join(ROOT, 'skills', 'adverse-review', 'scripts', 'plan.mjs');

function runPlan(args, cwd = ROOT) {
  return spawnSync('node', [PLAN, ...args], { cwd, encoding: 'utf-8', timeout: 30_000 });
}

// A scratch repo with a `main` branch holding `base`, and HEAD holding
// `change` — the shape the bridge diffs (`main...HEAD`).
function repoWith({ base, change }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'adverse-plan-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf-8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@test');
  git('config', 'user.name', 'test');
  for (const [file, content] of Object.entries(base)) {
    writeFileSync(path.join(dir, file), content);
  }
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  git('checkout', '-q', '-b', 'change');
  for (const [file, content] of Object.entries(change)) {
    if (content === null) rmSync(path.join(dir, file));
    else writeFileSync(path.join(dir, file), content);
  }
  git('add', '-A');
  git('commit', '-q', '-m', 'change');
  return dir;
}

const lines = (n, tag) => Array.from({ length: n }, (_, i) => `const ${tag}${i} = ${i};`).join('\n') + '\n';

test('a small boundary-free diff plans the cheap shape', () => {
  const dir = repoWith({
    base: { 'palette.mjs': lines(3, 'p') },
    change: { 'palette.mjs': lines(5, 'p') },
  });
  try {
    const r = runPlan(['--repo', dir, '--base', 'main']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^size: small /);
    assert.match(r.stdout, /adversary\s+skip/);
    assert.match(r.stdout, /pragmatist\s+skip/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('diff-suppressed content cannot buy the cheap shape (.gitattributes -diff)', () => {
  const dir = repoWith({
    base: { 'palette.mjs': lines(3, 'p') },
    change: {
      '.gitattributes': '*.xyz -diff\n',
      'payload.xyz': lines(400, 'x'),
    },
  });
  try {
    const r = runPlan(['--repo', dir, '--base', 'main']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^size: large /);
    assert.match(r.stdout, /unmeasurable/);
    assert.match(r.stdout, /adversary\s+run\s+2 agents/);
    assert.match(r.stdout, /auditor\s+run\s+2 agents/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a pure-deletion diff is not small and the adversary runs', () => {
  const dir = repoWith({
    base: { 'gate.mjs': lines(200, 'g'), 'keep.mjs': 'const k = 1;\n' },
    change: { 'gate.mjs': null },
  });
  try {
    const r = runPlan(['--repo', dir, '--base', 'main']);
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /^size: small /);
    assert.match(r.stdout, /adversary\s+run/);
    assert.match(r.stdout, /deleted/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a pin forces the full panel, case-insensitively', () => {
  const dir = repoWith({
    base: { 'Auth.mjs': lines(2, 'a') },
    change: { 'Auth.mjs': lines(4, 'a') },
  });
  try {
    const r = runPlan(['--repo', dir, '--base', 'main', '--pin', 'auth', '--json']);
    assert.equal(r.status, 0, r.stderr);
    const plan = JSON.parse(r.stdout);
    assert.equal(plan.pinned.length, 1);
    for (const l of plan.lanes) assert.equal(l.run, true, l.persona);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unreadable base prints size: unknown, not size: small, and plans the full shape', () => {
  const dir = repoWith({
    base: { 'a.mjs': 'const a = 1;\n' },
    change: { 'a.mjs': 'const a = 2;\n' },
  });
  try {
    const r = runPlan(['--repo', dir, '--base', 'nosuchref']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^size: unknown /);
    assert.doesNotMatch(r.stdout, /size: small/);
    for (const persona of ['auditor', 'adversary', 'steward', 'pragmatist']) {
      assert.match(r.stdout, new RegExp(`${persona}\\s+run`));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a supplied --files list survives a failed git read', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'adverse-plan-nogit-'));
  try {
    const list = path.join(dir, 'files.txt');
    writeFileSync(list, 'src/auth/creds.mjs\n');
    const r = runPlan(['--repo', dir, '--files', list, '--pin', 'src/auth', '--json'], dir);
    assert.equal(r.status, 0, r.stderr);
    const plan = JSON.parse(r.stdout);
    assert.equal(plan.pinned.length, 1);
    assert.equal(plan.size.measured, false);
    assert.notEqual(plan.size.bucket, 'small');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unreadable diff forces the adversary with the truthful unread reason', () => {
  // No pin here: a pin would win the reason string. '' in place of null was
  // the fail-open the diff:null contract exists to close, and plan.mjs is the
  // only production caller that can produce it.
  const dir = mkdtempSync(path.join(tmpdir(), 'adverse-plan-nogit2-'));
  try {
    const list = path.join(dir, 'files.txt');
    writeFileSync(list, 'src/render/palette.mjs\n');
    const r = runPlan(['--repo', dir, '--files', list, '--json'], dir);
    assert.equal(r.status, 0, r.stderr);
    const adv = JSON.parse(r.stdout).lanes.find((l) => l.persona === 'adversary');
    assert.equal(adv.run, true);
    assert.match(adv.reason, /could not be read/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a --base that looks like a git option is refused', () => {
  const r = runPlan(['--repo', ROOT, '--base=--output=/tmp/x']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /looks like an option/);
});

test('a stray positional in plan mode is a usage error', () => {
  const r = runPlan(['--repo', ROOT, 'round1-auditor.json']);
  assert.equal(r.status, 2);
});

test('--escalate: an unreadable round-1 file is exit 2, not default advice', () => {
  const r = runPlan(['--escalate', '--expect', 'auditor', 'no-such-file.json']);
  assert.equal(r.status, 2);
});

test('--escalate without --expect is a usage error — blind escalation is the fail-open it closes', () => {
  const r = runPlan(['--escalate', 'whatever.json']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--expect/);
});

test('--escalate: a missing expected lane fails closed', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'adverse-plan-esc-'));
  try {
    const f = path.join(dir, 'round1-auditor.json');
    writeFileSync(f, JSON.stringify({ persona: 'auditor', verdict: 'approve', summary: 's', findings: [] }));
    const r = runPlan(['--escalate', '--expect', 'auditor,steward', f]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /round 2: run/);
    assert.match(r.stdout, /fail closed/);
    assert.match(r.stdout, /steward/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--escalate: a quiet round 1 skips round 2 and says how to declare it', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'adverse-plan-esc2-'));
  try {
    const f = path.join(dir, 'round1-auditor.json');
    writeFileSync(f, JSON.stringify({ persona: 'auditor', verdict: 'approve', summary: 's', findings: [] }));
    const r = runPlan(['--escalate', '--expect', 'auditor', f]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /round 2: skip/);
    assert.match(r.stdout, /--round2-skipped/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a supplied --files list is never sized by an unrelated numstat — unmeasured, not small', () => {
  // base HEAD means an empty diff range: an empty measurement of the wrong
  // range must not read as a measurement of the supplied list.
  const dir = repoWith({
    base: { 'a.mjs': 'const a = 1;\n' },
    change: { 'a.mjs': 'const a = 2;\n' },
  });
  try {
    const list = path.join(dir, 'files.txt');
    writeFileSync(list, 'big1.mjs\nbig2.mjs\nbig3.mjs\n');
    const r = runPlan(['--repo', dir, '--base', 'HEAD', '--files', list, '--json']);
    assert.equal(r.status, 0, r.stderr);
    const plan = JSON.parse(r.stdout);
    assert.equal(plan.size.measured, false);
    assert.notEqual(plan.size.bucket, 'small');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a sub-floor guard deletion still runs the adversary — removed lines are signal-scanned', () => {
  // 79 deleted lines of permission checks: below DELETED_LINES_ADVERSARY_FLOOR,
  // neutral path, nothing added — the near-miss that reproduced after the
  // first fix. `u.perm`, not `u.permission`: the panel caught this fixture
  // having been rewritten to fit the vocabulary list, so it pins the SHAPE
  // scan (a negated-condition guard), which no CONTENT_SIGNALS entry matches.
  const guards = Array.from({ length: 79 }, (_, i) => `if (!u.perm[${i}]) throw new Error(${i});`).join('\n') + '\n';
  const dir = repoWith({
    base: { 'widget.js': guards + 'const keep = 1;\n' },
    change: { 'widget.js': 'const keep = 1;\n' },
  });
  try {
    const r = runPlan(['--repo', dir, '--base', 'main']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /adversary\s+run/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--files does not surrender the forcing signals: hidden content still lands large', () => {
  // The F10 fix suppressed the numstat read under --files, which quietly
  // discarded the unscannable and deleted-lines forces — one flag away from
  // the documented flow, which builds files.txt from the very same range.
  const dir = repoWith({
    base: { 'palette.mjs': lines(3, 'p') },
    change: {
      '.gitattributes': '*.xyz -diff\n',
      'payload.xyz': lines(400, 'x'),
    },
  });
  try {
    const list = path.join(dir, 'files.txt');
    writeFileSync(list, '.gitattributes\npayload.xyz\n');
    const r = runPlan(['--repo', dir, '--base', 'main', '--files', list]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^size: large /);
    assert.match(r.stdout, /unmeasurable/);
    assert.match(r.stdout, /adversary\s+run\s+2 agents/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--files does not surrender the deletion floor', () => {
  // Innocuous deleted lines — no guard shape — so only the numstat floor can
  // force the lane, which pins the numstat read surviving --files.
  const dir = repoWith({
    base: { 'gate.mjs': lines(200, 'g'), 'keep.mjs': 'const k = 1;\n' },
    change: { 'gate.mjs': null },
  });
  try {
    const list = path.join(dir, 'files.txt');
    writeFileSync(list, 'gate.mjs\n');
    const r = runPlan(['--repo', dir, '--base', 'main', '--files', list]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /adversary\s+run/);
    assert.match(r.stdout, /deleted/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- --agents: the worktree loop's list, read from plan.json ----------------

function writePlanFile(dir, lanes) {
  const p = path.join(dir, 'plan.json');
  writeFileSync(p, JSON.stringify({ lanes }));
  return p;
}

test('--agents lists one name per running lane, and skips a lane the plan skipped', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'adverse-plan-agents-'));
  try {
    const plan = writePlanFile(dir, [
      { persona: 'auditor', run: true, agents: 1, reason: 'r' },
      { persona: 'pragmatist', run: false, agents: 0, reason: 'skip' },
    ]);
    const r = runPlan(['--agents', plan]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'auditor');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--agents expands a split lane into one letter-suffixed name per agent, not hardcoded to two', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'adverse-plan-agents2-'));
  try {
    const plan = writePlanFile(dir, [
      { persona: 'auditor', run: true, agents: 3, reason: 'split three ways' },
      { persona: 'steward', run: true, agents: 1, reason: 'never split' },
    ]);
    const r = runPlan(['--agents', plan]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.stdout.trim().split(' '), ['auditor-a', 'auditor-b', 'auditor-c', 'steward']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--agents rejects a lane with a malformed `agents` count instead of silently dropping it', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'adverse-plan-agents3-'));
  try {
    const plan = writePlanFile(dir, [{ persona: 'auditor', run: true, agents: null, reason: 'r' }]);
    const r = runPlan(['--agents', plan]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /invalid `agents` count/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--agents on a plan.json missing `lanes` is a usage error, not a silent empty list', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'adverse-plan-agents4-'));
  try {
    const plan = path.join(dir, 'plan.json');
    writeFileSync(plan, JSON.stringify({ oops: true }));
    const r = runPlan(['--agents', plan]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /not a plan\.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--agents combined with --escalate is a usage error — the two modes do not mix', () => {
  const r = runPlan(['--agents', 'plan.json', '--escalate']);
  assert.equal(r.status, 2);
});

// --- --expect <plan.json>: the round-2 roster, read instead of retyped ------

test('--expect <plan.json> prints the run-lane roster, comma-joined', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'adverse-plan-expect-'));
  try {
    const plan = writePlanFile(dir, [
      { persona: 'auditor', run: true, agents: 1, reason: 'r' },
      { persona: 'adversary', run: true, agents: 1, reason: 'r' },
      { persona: 'pragmatist', run: false, agents: 0, reason: 'skip' },
    ]);
    const r = runPlan(['--expect', plan]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'auditor,adversary');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--expect <plan.json> feeds straight into --escalate --expect', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'adverse-plan-expect2-'));
  try {
    const plan = writePlanFile(dir, [{ persona: 'auditor', run: true, agents: 1, reason: 'r' }]);
    const expectOut = runPlan(['--expect', plan]);
    assert.equal(expectOut.status, 0, expectOut.stderr);
    const roundOne = path.join(dir, 'round1-auditor.json');
    writeFileSync(roundOne, JSON.stringify({ persona: 'auditor', verdict: 'approve', summary: 's', findings: [] }));
    const r = runPlan(['--escalate', '--expect', expectOut.stdout.trim(), roundOne]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /round 2: skip/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--expect <plan.json> missing `lanes` is a usage error', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'adverse-plan-expect3-'));
  try {
    const plan = path.join(dir, 'plan.json');
    writeFileSync(plan, JSON.stringify({ oops: true }));
    const r = runPlan(['--expect', plan]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /not a plan\.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- --escalate --sh: ROUNDS/CAP/R2_REASON as one eval-able block -----------

test('--escalate --sh prints ROUNDS/CAP/R2_REASON as shell assignments', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'adverse-plan-sh-'));
  try {
    const f = path.join(dir, 'round1-auditor.json');
    writeFileSync(f, JSON.stringify({
      persona: 'auditor', verdict: 'reject', summary: 's',
      findings: [{ severity: 'critical', kind: 'defect', title: 't' }],
    }));
    const r = runPlan(['--escalate', '--expect', 'auditor', '--sh', f]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^ROUNDS=\d+$/m);
    assert.match(r.stdout, /^CAP=5$/m); // escalated: round 1 has a blocking critical
    assert.match(r.stdout, /^R2_REASON='.*'$/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--escalate --sh quotes an embedded single quote safely for eval', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'adverse-plan-sh2-'));
  try {
    // A missing expected lane drives roundsReason through the fail-closed
    // "expected lane "<name>" has no readable round-1 payload" phrasing —
    // naming an unheard-from persona with an apostrophe puts one right in
    // the reason string, so `eval`-ing the output has to reconstruct it.
    const f = path.join(dir, 'round1-auditor.json');
    writeFileSync(f, JSON.stringify({ persona: 'auditor', verdict: 'approve', summary: 's', findings: [] }));
    const r = runPlan(['--escalate', '--expect', "auditor,o'brien", '--sh', f]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /R2_REASON=/);
    const out = execFileSync('bash', ['-c', `${r.stdout}\nprintf '%s' "$R2_REASON"`], { encoding: 'utf-8' });
    assert.match(out, /o'brien/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--escalate --sh together with --json is a usage error — pick one output format', () => {
  const r = runPlan(['--escalate', '--expect', 'auditor', '--sh', '--json', 'whatever.json']);
  assert.equal(r.status, 2);
});

test('--agents refuses a plan lane whose persona is not in the registry', () => {
  // The `agents` count was validated and `persona` was not, and SKILL.md
  // Phase 1 word-splits this output into `git worktree add "$WORKTREES/$agent"`
  // — so a persona carrying whitespace or a path separator becomes checkout
  // paths.
  for (const persona of ['auditor extra', '../../escape', 'Auditor', '']) {
    const dir = mkdtempSync(path.join(tmpdir(), 'adverse-plan-persona-'));
    try {
      const plan = path.join(dir, 'plan.json');
      writeFileSync(plan, JSON.stringify({ lanes: [{ persona, run: true, agents: 1 }] }));
      const r = runPlan(['--agents', plan]);
      assert.equal(r.status, 2, `persona ${JSON.stringify(persona)} must be refused`);
      // Wording follows src/scaling.mjs's `parsePlan`, the one reader of a
      // plan.json now — this bridge no longer spells the rule itself. The
      // claim is unchanged: each of these is refused, exit 2.
      assert.match(r.stderr, /is not a persona/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('a long documentation line runs the adversary without claiming a boundary', () => {
  // The reason `assessScope` returns is what this bridge persists into
  // plan.json's lane, so the operator surface and the artifact are one string.
  // Measured before the fix, on this repo's own README shape: the lane read
  // "trust-boundary signals present (0 in paths, 1 in added code, 0 in removed
  // code)" for one added line of ordinary prose.
  const prose = 'Amend the scope gate description so that it says what is true of the length '
    + 'backstop, because the sentence it replaces described a gate that only ever matched '
    + 'patterns and that is no longer the gate this repository ships to anybody at all.';
  assert.ok(prose.length > 200, `fixture is ${prose.length} chars`);
  const dir = repoWith({
    base: { 'README.md': 'short line\n' },
    change: { 'README.md': `short line\n${prose}\n` },
  });
  try {
    const r = runPlan(['--repo', dir, '--base', 'main', '--json']);
    assert.equal(r.status, 0, r.stderr);
    const lane = JSON.parse(r.stdout).lanes.find((l) => l.persona === 'adversary');

    // Still run — an unreadable line is evidence in its own right.
    assert.equal(lane.run, true, JSON.stringify(lane));
    assert.match(lane.reason, /ran past the 200-character span limit/);
    assert.doesNotMatch(lane.reason, /trust-boundary signals present/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


// --- --depth: the user's own answer, carried as data ----------------------------

test('--depth is recorded in plan.json, which is where the report reads it from', () => {
  const dir = repoWith({ base: { 'a.mjs': 'x\n' }, change: { 'a.mjs': 'y\n' } });
  try {
    for (const depth of ['cheap', 'standard', 'thorough']) {
      const r = runPlan(['--repo', dir, '--base', 'main', '--depth', depth, '--json']);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(JSON.parse(r.stdout).depth, depth);
    }
    const bare = runPlan(['--repo', dir, '--base', 'main', '--json']);
    assert.equal(JSON.parse(bare.stdout).depth, 'standard');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a misspelled --depth is exit 2, not a quietly standard run', () => {
  // The failure this refuses is specific: a typo that planned a standard run
  // would then be RECORDED as one, and the report's whole claim is that it can
  // be trusted about how much looking produced it.
  const r = runPlan(['--repo', ROOT, '--base', 'main', '--depth', 'thourough', '--json']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown depth "thourough"/);
  assert.equal(r.stdout, '');
});

test('--depth thorough runs a lane the same diff otherwise skips', () => {
  // End to end, through the bridge, on a diff small enough that the default
  // plan skips the advisory-only lane and the trust-boundary gate is quiet.
  const dir = repoWith({ base: { 'a.mjs': 'const x = 1;\n' }, change: { 'a.mjs': 'const x = 2;\n' } });
  try {
    const laneOf = (out, persona) => JSON.parse(out).lanes.find((l) => l.persona === persona);
    const bare = runPlan(['--repo', dir, '--base', 'main', '--json']);
    assert.equal(bare.status, 0, bare.stderr);
    assert.equal(laneOf(bare.stdout, 'pragmatist').run, false);

    const deep = runPlan(['--repo', dir, '--base', 'main', '--depth', 'thorough', '--json']);
    assert.equal(deep.status, 0, deep.stderr);
    for (const l of JSON.parse(deep.stdout).lanes) assert.equal(l.run, true, l.persona);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the human output names the depth and the tier it implies', () => {
  // The prose form is the one an operator actually reads, and depth is the one
  // plan input they supplied themselves — a run planned cheap that prints
  // identically to a standard one is the bug this field was added for.
  const r = runPlan(['--repo', ROOT, '--base', 'main', '--depth', 'cheap']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^depth: cheap \(model tier: default tier/m);
  assert.match(r.stdout, /note: depth cheap;/);
});
