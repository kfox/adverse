// Tests for skills/adverse-review/scripts/triage.mjs — the Skill's round-1
// triage bridge.
//
// Two layers below this one are tested directly, and this file deliberately
// does not repeat them: the claim/kind/cluster predicates against
// src/triage.mjs in tests/triage.test.mjs, and the briefing they are assembled
// into against src/briefing.mjs in tests/briefing.test.mjs, in-process and
// without a git fixture.
//
// What is left is the part that only exists at the process boundary, and it is
// worth naming because "run it as a subprocess too" is how this file grew to
// 615 lines of things already proven elsewhere:
//
//   - argv: parsing, positionals, the --base option guard, exit codes
//   - the roster: which payloads are allowed to be reviewers
//   - the summary line printed to stdout
//   - a real checkout: that a path escaping it, or an in-tree symlink pointing
//     out of it, is disproved AND that its content never reaches briefing.json
//   - the ledger FILE: that --ledger is read, bound to this repository, and
//     that a foreign or future-version one exits rather than being ignored
//
// NOT covered here, and not covered anywhere: replacing the anchor tracer with
// the identity function breaks no test. Re-projecting a ledger entry's
// position to HEAD before matching it is what stops a fix that shifted a file
// from making every past decision look like a different finding, and nothing
// currently drives a case where the projection changes the answer. The gap
// predates this file's reorganization — it survives the same mutation on the
// commit before it — and is written down rather than left to look covered.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const TRIAGE = path.join(here, '..', 'skills', 'adverse-review', 'scripts', 'triage.mjs');

// Fixture repos must not inherit the developer's global git config: signing,
// commit templates, and hooks all leak in and fail in ways that have nothing to
// do with the code under test.
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };

function git(cwd, ...args) {
  execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: 'pipe', env: GIT_ENV });
}

// A repo with one commit on `base` and one changed file on HEAD, so the
// in-diff / outside-diff distinction has something real to answer against.
function makeRepo() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'adverse-triage-'));
  git(dir, 'init', '-q', '-b', 'base');
  git(dir, 'config', 'user.email', 'test@example.invalid');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'config', 'tag.gpgSign', 'false');
  mkdirSync(path.join(dir, 'docs'), { recursive: true });
  writeFileSync(path.join(dir, 'app.py'), Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n') + '\n');
  writeFileSync(path.join(dir, 'docs', 'app.md'), 'app returns a list\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'base');

  git(dir, 'checkout', '-q', '-b', 'work');
  const lines = readFileSync(path.join(dir, 'app.py'), 'utf-8').split('\n');
  lines[19] = 'line 20 CHANGED';
  writeFileSync(path.join(dir, 'app.py'), lines.join('\n'));
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'work');
  return dir;
}

function runTriage(dir, reviews, mergePersonas = []) {
  const files = reviews.map((r, i) => {
    const p = path.join(dir, `round1-${i}.json`);
    writeFileSync(p, JSON.stringify(r), 'utf-8');
    return p;
  });
  const out = path.join(dir, 'briefing.json');
  const args = [TRIAGE];
  for (const f of files) args.push('--round1', f);
  args.push('--repo', dir, '--base', 'base', '--out', out);
  for (const p of mergePersonas) args.push('--merge-personas', p);
  const stdout = execFileSync(process.execPath, args, { encoding: 'utf-8' });
  return { briefing: JSON.parse(readFileSync(out, 'utf-8')), stdout };
}

const review = (persona, findings) => ({ persona, verdict: 'conditional', summary: '', findings });
const finding = (over = {}) => ({
  severity: 'warning', kind: 'defect', file: 'app.py', line: 20,
  counterpart: null, title: 't', detail: 'd', fix: null, ...over,
});

let repo;
test.before(() => { repo = makeRepo(); });
test.after(() => rmSync(repo, { recursive: true, force: true }));

test('--gate and --base are carried from argv into the briefing verbatim', () => {
  // What buildBriefing does with these is tested in-process; this is the wire
  // between argv and that call, which is its own claim. Both fields are read
  // by a round-2 reviewer: `gate` tells them which findings the repo's own
  // tools already rule out, and `base` is the ref every anchor is relative to.
  const p = path.join(repo, 'round1-wire.json');
  writeFileSync(p, JSON.stringify(review('auditor', [finding()])));
  const out = path.join(repo, 'briefing-wire.json');
  const r = spawnSync(process.execPath,
    [TRIAGE, '--round1', p, '--repo', repo, '--base', 'base',
      '--gate', 'lint green · 1,412 tests pass', '--out', out],
    { encoding: 'utf-8', timeout: 30_000 });
  assert.equal(r.status, 0, r.stderr);
  const briefing = JSON.parse(readFileSync(out, 'utf-8'));
  assert.equal(briefing.gate, 'lint green · 1,412 tests pass');
  assert.equal(briefing.base, 'base');
});

test('an omitted --gate is recorded as null, not left out of the briefing', () => {
  const { briefing } = runTriage(repo, [review('auditor', [finding()])]);
  assert.equal(briefing.gate, null);
  assert.ok('gate' in briefing);
});

test('the summary line reports every tally, and reports the run the file describes', () => {
  // One assertion site for the whole summary block. Each of these counts used
  // to ride along on whichever behavioural test happened to produce it, so the
  // advisory line in particular was asserted in exactly one place and by
  // accident.
  const { briefing, stdout } = runTriage(repo, [
    review('auditor', [
      finding({ line: 20 }),
      finding({ line: 1, file: 'docs/app.md', kind: 'contract', counterpart: 'nope.md' }),
      finding({ line: 9999 }),
    ]),
    review('adversary', [
      finding({ line: 21, detail: 'the same thing docs/app.md line 1 is about' }),
      finding({ kind: 'design', file: null, line: null }),
      finding({ line: 'twenty' }),
      finding({ kind: 'defect', line: null }),
    ]),
  ]);

  assert.match(stdout, /^triaged 7 findings from 2 reviewers/);
  assert.match(stdout, /clusters \(same file, <=\d+ lines apart, 2\+ reporters\): 1\b/);
  assert.match(stdout, /claim-check disproved: 2 \(F2, F3\)/);
  assert.match(stdout, /malformed anchors coerced away \(field kept null\): 1 \(F6\.line\)/);
  assert.match(stdout, /co-citations \(.*max \d+\/finding\): 1 \(F4->F2\)/);
  assert.match(stdout, /candidate root causes \(proposed, for round 2 to confirm or split\): 1 \(G1=/);
  assert.match(stdout, /under-anchored for their kind \(annotated, not rejected\): 2 \(F6, F7\)/);
  assert.match(stdout, /advisory \(design — cannot block\): 1 \(F5\)/);
  assert.match(stdout, /already settled in an earlier iteration: 0\n/);
  assert.match(stdout, /REGRESSED \(recorded fixed, reported again\): 0\n/);

  // The counts describe the file, not a parallel calculation of their own.
  assert.equal(briefing.findings.length, 7);
  assert.equal(briefing.clusters.length, 1);
  assert.equal(briefing.groups.length, 1);
});

test('a counterpart that does not exist disproves the contradiction', () => {
  const { briefing, stdout } = runTriage(repo, [review('auditor', [
    finding({ kind: 'contract', counterpart: 'docs/ghost.md' }),
  ])]);
  assert.equal(briefing.findings[0].counterpartCheck.status, 'DISPROVED');
  assert.match(stdout, /claim-check disproved: 1/);
});

// --- the ledger ---------------------------------------------------------------

function runTriageWithLedger(dir, reviews, ledger) {
  const lp = path.join(dir, 'ledger.json');
  writeFileSync(lp, JSON.stringify(ledger), 'utf-8');
  const files = reviews.map((r, i) => {
    const p = path.join(dir, `lr1-${i}.json`);
    writeFileSync(p, JSON.stringify(r), 'utf-8');
    return p;
  });
  const out = path.join(dir, 'lbriefing.json');
  const args = [TRIAGE];
  for (const f of files) args.push('--round1', f);
  args.push('--repo', dir, '--base', 'base', '--ledger', lp, '--out', out);
  const stdout = execFileSync(process.execPath, args, { encoding: 'utf-8' });
  return { briefing: JSON.parse(readFileSync(out, 'utf-8')), stdout };
}

const ledgerEntry = (over = {}) => ({
  id: 'F1', title: 't', kind: 'defect', severity: 'warning',
  file: 'app.py', line: 20, counterpart: null, citedLine: 'line 20 CHANGED',
  disposition: 'declined', reason: 'intentional', iteration: 1, atCommit: 'HEAD', ...over,
});

test('a settled finding is marked in the briefing and counted as settled', () => {
  const { briefing, stdout } = runTriageWithLedger(repo, [review('auditor', [finding()])], {
    version: 1, base: null, iterations: [{ n: 1 }], entries: [ledgerEntry()],
  });
  const f = briefing.findings[0];
  assert.equal(f.adjudicated.settled, true);
  assert.equal(f.adjudicated.reason, 'intentional');
  assert.deepEqual(briefing.settled, ['F1']);
  assert.deepEqual(briefing.regressed, []);
  assert.match(stdout, /already settled in an earlier iteration: 1/);
});

test('a ledger from a future version fails the run rather than being ignored', () => {
  assert.throws(() => runTriageWithLedger(repo, [review('auditor', [finding()])],
    { version: 99, entries: [] }), /status 1|Command failed/);
});

// --- candidate root causes ---------------------------------------------------

// --- the invocation the documentation actually tells you to type -------------
// F12 happened because SKILL.md documented `--round1 run/round1-*.json` while
// every test built args with a repeated `--round1` flag. The documented form
// and the tested form were different, so the break was invisible: the shell
// expands the glob, the extra paths arrive as positionals, and strict parseArgs
// aborts. Reverting `allowPositionals` must fail a test, not pass 263 of them.

test('round-1 paths given as positionals are read, like the documented glob', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'adverse-glob-'));
  const files = [
    review('auditor', [finding({ title: 'a' })]),
    review('adversary', [finding({ title: 'b' })]),
    review('steward', [finding({ title: 'c', kind: 'contract', counterpart: 'docs/app.md' })]),
  ].map((r, i) => {
    const p = path.join(dir, `round1-${i}.json`);
    writeFileSync(p, JSON.stringify(r), 'utf-8');
    return p;
  });
  const out = path.join(dir, 'briefing.json');

  // Exactly what `--round1 "$RUN"/round1-*.json` becomes after the shell:
  // one flag, then bare paths.
  const args = [TRIAGE, '--round1', files[0], files[1], files[2],
                '--repo', repo, '--base', 'base', '--out', out];
  execFileSync(process.execPath, args, { encoding: 'utf-8' });

  const briefing = JSON.parse(readFileSync(out, 'utf-8'));
  assert.equal(briefing.findings.length, 3, 'every globbed file must be read, not just the first');
  assert.deepEqual(briefing.findings.map((f) => f.reporter), ['auditor', 'adversary', 'steward']);
});

test('a path escaping the checkout is disproved, not read', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'adverse-escape-'));
  const secret = path.join(dir, 'secret.txt');
  writeFileSync(secret, 'SENTINEL-DO-NOT-EXFILTRATE\n', 'utf-8');

  const rel = path.relative(repo, secret);
  const { briefing } = runTriage(repo, [review('auditor', [finding({ file: rel, line: 1 })])]);
  assert.equal(briefing.findings[0].claimCheck.status, 'DISPROVED');
  assert.match(briefing.findings[0].claimCheck.why, /escapes the checkout/);
  assert.ok(!JSON.stringify(briefing).includes('SENTINEL'), 'no out-of-tree content may reach the briefing');
});

test('an in-tree symlink pointing out of the tree is disproved, not followed', () => {
  // path.resolve normalizes `..` but knows nothing about symlinks, while
  // statSync and readFileSync both follow them — so a symlink committed inside
  // the checkout (git stores mode 120000) kept the path under the repo prefix
  // while the read landed wherever it pointed.
  const outside = mkdtempSync(path.join(os.tmpdir(), 'adverse-outside-'));
  const secret = path.join(outside, 'id_rsa');
  writeFileSync(secret, 'line one\nSSH-SENTINEL-DO-NOT-EXFILTRATE\n', 'utf-8');

  const link = path.join(repo, 'docs_link');
  try {
    symlinkSync(secret, link);
  } catch {
    return; // no symlink support; nothing to assert
  }

  const { briefing } = runTriage(repo, [review('auditor', [
    finding({ file: 'docs_link', line: 2, kind: 'contract', counterpart: 'docs/app.md' }),
  ])]);
  unlinkSync(link);

  assert.equal(briefing.findings[0].claimCheck.status, 'DISPROVED');
  assert.ok(!JSON.stringify(briefing).includes('SSH-SENTINEL'),
    'the symlink target must never reach the briefing, which becomes the round-2 prompt');
});

test('a counterpart that is an in-tree symlink pointing out of the tree is disproved', () => {
  // checkCounterpart answers the same "is this really a file in the checkout"
  // question as claimCheck, for the second path a `contract` finding names —
  // it must reject an escaping symlink exactly the same way.
  const outside = mkdtempSync(path.join(os.tmpdir(), 'adverse-outside-'));
  const secret = path.join(outside, 'id_rsa');
  writeFileSync(secret, 'SSH-SENTINEL-DO-NOT-EXFILTRATE\n', 'utf-8');

  const link = path.join(repo, 'counterpart_link');
  try {
    symlinkSync(secret, link);
  } catch {
    return; // no symlink support; nothing to assert
  }

  const { briefing } = runTriage(repo, [review('auditor', [
    finding({ kind: 'contract', counterpart: 'counterpart_link' }),
  ])]);
  unlinkSync(link);

  assert.equal(briefing.findings[0].counterpartCheck.status, 'DISPROVED');
  assert.ok(!JSON.stringify(briefing).includes('SSH-SENTINEL'),
    'the symlink target must never reach the briefing, which becomes the round-2 prompt');
});

test('a ledger that does not belong to this repository is refused', () => {
  // triage.mjs writes briefing.json, which IS the round-2 prompt, so a foreign
  // ledger accepted here marks findings settled with "Do not re-open it" in
  // front of every reviewer. converge.mjs's copy of this guard is tested;
  // this one was added by the same fix and was not.
  const dir = mkdtempSync(path.join(os.tmpdir(), 'adverse-foreign-'));
  const ledger = path.join(dir, 'l.json');
  writeFileSync(ledger, JSON.stringify({
    version: 1, base: 'some-other-repo-entirely', iterations: [],
    entries: [{ id: 'X', title: 't', kind: 'defect', file: 'app.py', line: 20,
                disposition: 'declined', reason: 'trust me',
                atCommit: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' }],
  }));

  const round1 = path.join(dir, 'round1-0.json');
  writeFileSync(round1, JSON.stringify(review('auditor', [finding()])));
  const r = spawnSync(process.execPath, [TRIAGE, '--round1', round1, '--repo', repo,
                                         '--base', 'base', '--ledger', ledger,
                                         '--out', path.join(dir, 'b.json')],
                      { encoding: 'utf-8' });
  assert.equal(r.status, 1, 'a foreign ledger must be refused, not adjudicated from');
  assert.match(r.stderr, /does not belong to this repository/);
});

test('a ledger entry with no atCommit is refused', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'adverse-unanchored-'));
  const ledger = path.join(dir, 'l.json');
  writeFileSync(ledger, JSON.stringify({
    version: 1, iterations: [],
    entries: [{ id: 'X', title: 't', kind: 'defect', file: 'app.py', line: 20,
                disposition: 'declined', reason: 'trust me' }],
  }));
  const round1 = path.join(dir, 'round1-0.json');
  writeFileSync(round1, JSON.stringify(review('auditor', [finding()])));
  const r = spawnSync(process.execPath, [TRIAGE, '--round1', round1, '--repo', repo,
                                         '--base', 'base', '--ledger', ledger,
                                         '--out', path.join(dir, 'b.json')],
                      { encoding: 'utf-8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /carries no atCommit/);
});

test('a split lane\'s two payloads merge in briefing.verdicts — worse verdict, both summaries', () => {
  const { briefing } = runTriage(repo, [
    { persona: 'auditor', verdict: 'approve', summary: 'half A', findings: [] },
    { persona: 'auditor', verdict: 'reject', summary: 'half B', findings: [] },
  ], ['auditor']);
  assert.equal(briefing.verdicts.auditor.verdict, 'reject');
  assert.match(briefing.verdicts.auditor.summary, /half A/);
  assert.match(briefing.verdicts.auditor.summary, /half B/);
});

test('the merged verdict does not depend on which half the shell globbed first', () => {
  const { briefing } = runTriage(repo, [
    { persona: 'auditor', verdict: 'reject', summary: 'half B', findings: [] },
    { persona: 'auditor', verdict: 'approve', summary: 'half A', findings: [] },
  ], ['auditor']);
  assert.equal(briefing.verdicts.auditor.verdict, 'reject');
});

test('an undeclared duplicate persona is refused, not silently merged', () => {
  const dir = repo;
  const files = [
    { persona: 'auditor', verdict: 'approve', summary: 'half A', findings: [] },
    { persona: 'auditor', verdict: 'reject', summary: 'half B', findings: [] },
  ].map((r, i) => {
    const p = path.join(dir, `round1-dup-${i}.json`);
    writeFileSync(p, JSON.stringify(r));
    return p;
  });
  const out = path.join(dir, 'briefing-dup.json');
  const r = spawnSync(process.execPath,
    [TRIAGE, '--round1', files[0], '--round1', files[1], '--repo', dir, '--base', 'base', '--out', out],
    { encoding: 'utf-8', timeout: 30_000 });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /duplicate persona 'auditor'/);
  assert.match(r.stderr, /--merge-personas/);
});

test('a declared split lane missing its other half is refused, not treated as a solo review', () => {
  const p = path.join(repo, 'round1-solo.json');
  writeFileSync(p, JSON.stringify({ persona: 'auditor', verdict: 'approve', summary: 's', findings: [] }));
  const out = path.join(repo, 'briefing-solo.json');
  const r = spawnSync(process.execPath,
    [TRIAGE, '--round1', p, '--merge-personas', 'auditor', '--repo', repo, '--base', 'base', '--out', out],
    { encoding: 'utf-8', timeout: 30_000 });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /expected exactly 2 payloads/);
  assert.match(r.stderr, /re-run it/);
});

test('a declared split lane with a stray third payload is refused, not merged three ways', () => {
  const files = ['half A', 'half B', 'stray'].map((s, i) => {
    const p = path.join(repo, `round1-triple-${i}.json`);
    writeFileSync(p, JSON.stringify({ persona: 'auditor', verdict: 'approve', summary: s, findings: [] }));
    return p;
  });
  const out = path.join(repo, 'briefing-triple.json');
  const r = spawnSync(process.execPath,
    [TRIAGE, ...files.flatMap((f) => ['--round1', f]),
      '--merge-personas', 'auditor', '--repo', repo, '--base', 'base', '--out', out],
    { encoding: 'utf-8', timeout: 30_000 });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /expected exactly 2 payloads.*got 3/);
  assert.match(r.stderr, /stale file or a double glob/);
});

test('--merge-personas naming a non-persona is a usage error, exit 2', () => {
  const p = path.join(repo, 'round1-ok2.json');
  writeFileSync(p, JSON.stringify({ persona: 'auditor', verdict: 'approve', summary: 's', findings: [] }));
  const out = path.join(repo, 'briefing-ok2.json');
  const r = spawnSync(process.execPath,
    [TRIAGE, '--round1', p, '--merge-personas', 'referee', '--repo', repo, '--base', 'base', '--out', out],
    { encoding: 'utf-8', timeout: 30_000 });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /not a persona/);
});

// --- --plan: derive the split roster from plan.json, instead of retyping it -

function writePlan(dir, lanes) {
  const p = path.join(dir, 'plan.json');
  writeFileSync(p, JSON.stringify({ lanes }));
  return p;
}

test('--plan derives the split roster from lanes the plan split (agents > 1)', () => {
  const a = path.join(repo, 'round1-plan-a.json');
  const b = path.join(repo, 'round1-plan-b.json');
  writeFileSync(a, JSON.stringify({ persona: 'auditor', verdict: 'approve', summary: 'half one', findings: [] }));
  writeFileSync(b, JSON.stringify({ persona: 'auditor', verdict: 'reject', summary: 'half two', findings: [] }));
  const plan = writePlan(repo, [
    { persona: 'auditor', run: true, agents: 2, reason: 'split' },
    { persona: 'steward', run: true, agents: 1, reason: 'not split' },
  ]);
  const out = path.join(repo, 'briefing-plan.json');
  const r = spawnSync(process.execPath,
    [TRIAGE, '--round1', a, '--round1', b, '--plan', plan, '--repo', repo, '--base', 'base', '--out', out],
    { encoding: 'utf-8', timeout: 30_000 });
  assert.equal(r.status, 0, r.stderr);
  const briefing = JSON.parse(readFileSync(out, 'utf-8'));
  assert.equal(briefing.verdicts.auditor.verdict, 'reject');
});

test('a lane the plan did NOT split still trips the duplicate guard under --plan', () => {
  const s1 = path.join(repo, 'round1-plan-s1.json');
  const s2 = path.join(repo, 'round1-plan-s2.json');
  writeFileSync(s1, JSON.stringify({ persona: 'steward', verdict: 'approve', summary: 's', findings: [] }));
  writeFileSync(s2, JSON.stringify({ persona: 'steward', verdict: 'approve', summary: 's', findings: [] }));
  const plan = writePlan(repo, [{ persona: 'steward', run: true, agents: 1, reason: 'not split' }]);
  const out = path.join(repo, 'briefing-plan-dup.json');
  const r = spawnSync(process.execPath,
    [TRIAGE, '--round1', s1, '--round1', s2, '--plan', plan, '--repo', repo, '--base', 'base', '--out', out],
    { encoding: 'utf-8', timeout: 30_000 });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /duplicate persona 'steward'/);
});

test('a --plan persona outside the registry is refused, not read as a phantom lane', () => {
  const p = path.join(repo, 'round1-plan-bad.json');
  writeFileSync(p, JSON.stringify({ persona: 'auditor', verdict: 'approve', summary: 's', findings: [] }));
  const plan = writePlan(repo, [{ persona: 'referee', run: true, agents: 2, reason: 'split' }]);
  const out = path.join(repo, 'briefing-plan-bad.json');
  const r = spawnSync(process.execPath,
    [TRIAGE, '--round1', p, '--plan', plan, '--repo', repo, '--base', 'base', '--out', out],
    { encoding: 'utf-8', timeout: 30_000 });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /not a persona/);
});

test('a lane the plan ran that sent no payload is warned about here too, not only in combine', () => {
  // The roster rules lived in two copies and this half existed in only one of
  // them. triage builds the round-2 PROMPT, so a lane missing from its input
  // is the earlier and worse place for the silence to go unremarked.
  const p = path.join(repo, 'round1-silent.json');
  writeFileSync(p, JSON.stringify({ persona: 'auditor', verdict: 'approve', summary: 's', findings: [] }));
  const plan = writePlan(repo, [
    { persona: 'auditor', run: true, agents: 1, reason: 'r' },
    { persona: 'steward', run: true, agents: 1, reason: 'r' },
  ]);
  const out = path.join(repo, 'briefing-silent.json');
  const r = spawnSync(process.execPath,
    [TRIAGE, '--round1', p, '--plan', plan, '--repo', repo, '--base', 'base', '--out', out],
    { encoding: 'utf-8', timeout: 30_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /the plan ran steward but no payload arrived/);
});

test('the not-run refusal names the override and the payload, as combine\'s always did', () => {
  const p = path.join(repo, 'round1-notrun.json');
  writeFileSync(p, JSON.stringify({ persona: 'pragmatist', verdict: 'approve', summary: 's', findings: [] }));
  const plan = writePlan(repo, [{ persona: 'pragmatist', run: false, agents: 0, reason: 'skip' }]);
  const out = path.join(repo, 'briefing-notrun.json');
  const r = spawnSync(process.execPath,
    [TRIAGE, '--round1', p, '--plan', plan, '--repo', repo, '--base', 'base', '--out', out],
    { encoding: 'utf-8', timeout: 30_000 });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /recorded 'pragmatist' as not run/);
  assert.match(r.stderr, /thorough pass/);
  assert.match(r.stderr, /round1-notrun\.json/);
});

test('a findings ELEMENT that is not an object is refused too, not only the array', () => {
  // Guarding the container and not its contents closed one instance and left
  // the class open: `[null]` reached normalizeAnchor and threw at
  // src/triage.mjs:49 — the same crash under a different input.
  for (const findings of [[null], [7], ['x'], [[]], [{}, null]]) {
    const f = path.join(repo, 'round1-element.json');
    writeFileSync(f, JSON.stringify({ persona: 'auditor', verdict: 'approve', summary: 's', findings }));
    const out = path.join(repo, 'briefing-element.json');
    const r = spawnSync(process.execPath,
      [TRIAGE, '--round1', f, '--repo', repo, '--base', 'base', '--out', out],
      { encoding: 'utf-8', timeout: 30_000 });
    assert.equal(r.status, 1, `findings ${JSON.stringify(findings)}`);
    assert.match(r.stderr, /is not an object/);
    assert.doesNotMatch(r.stderr, /TypeError|at file:/);
  }
});

test('a non-array `findings` is refused with a sentence, not a TypeError stack', () => {
  // Exit 1, not 2: SKILL.md's line is "2 means it never read a payload, 1
  // means it read one that failed the schema", and this one parsed fine.
  const p = path.join(repo, 'round1-notarray.json');
  writeFileSync(p, JSON.stringify({ persona: 'auditor', verdict: 'approve', summary: 's', findings: 7 }));
  const out = path.join(repo, 'briefing-notarray.json');
  const r = spawnSync(process.execPath,
    [TRIAGE, '--round1', p, '--repo', repo, '--base', 'base', '--out', out],
    { encoding: 'utf-8', timeout: 30_000 });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /`findings` is not an array/);
  assert.doesNotMatch(r.stderr, /TypeError|at file:/);
});

test('a --plan persona outside the registry is refused even when the lane was NOT split', () => {
  // The registry check used to reach plan lanes only through
  // `--merge-personas`, which a lane with `agents: 1` never becomes — so this
  // exact plan was accepted (exit 0) and its phantom lane shaped the roster.
  // src/scaling.mjs's parsePlan checks every lane, split or not.
  const p = path.join(repo, 'round1-plan-unsplit.json');
  writeFileSync(p, JSON.stringify({ persona: 'auditor', verdict: 'approve', summary: 's', findings: [] }));
  const plan = writePlan(repo, [{ persona: 'referee', run: true, agents: 1, reason: 'solo' }]);
  const out = path.join(repo, 'briefing-plan-unsplit.json');
  const r = spawnSync(process.execPath,
    [TRIAGE, '--round1', p, '--plan', plan, '--repo', repo, '--base', 'base', '--out', out],
    { encoding: 'utf-8', timeout: 30_000 });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /not a persona/);
});

test('a --plan file with no `lanes` array is a usage error, not a silent no-op', () => {
  const p = path.join(repo, 'round1-plan-malformed.json');
  writeFileSync(p, JSON.stringify({ persona: 'auditor', verdict: 'approve', summary: 's', findings: [] }));
  const plan = path.join(repo, 'plan-malformed.json');
  writeFileSync(plan, JSON.stringify({ oops: true }));
  const out = path.join(repo, 'briefing-plan-malformed.json');
  const r = spawnSync(process.execPath,
    [TRIAGE, '--round1', p, '--plan', plan, '--repo', repo, '--base', 'base', '--out', out],
    { encoding: 'utf-8', timeout: 30_000 });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /not a plan\.json/);
});

test('an unsplit lane\'s off-contract verdict is normalized in the briefing too', () => {
  const { briefing } = runTriage(repo, [
    { persona: 'auditor', verdict: 'REJECT', summary: 's', findings: [] },
  ]);
  assert.equal(briefing.verdicts.auditor.verdict, 'reject');
});

test('a persona outside the registry is refused before it can key the briefing', () => {
  const p = path.join(repo, 'round1-phantom.json');
  writeFileSync(p, JSON.stringify({ persona: 'Auditor', verdict: 'approve', summary: 's', findings: [] }));
  const out = path.join(repo, 'briefing-phantom.json');
  const r = spawnSync(process.execPath,
    [TRIAGE, '--round1', p, '--repo', repo, '--base', 'base', '--out', out],
    { encoding: 'utf-8', timeout: 30_000 });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unknown persona/);
});

test('a --base that looks like a git option is refused', () => {
  const p = path.join(repo, 'round1-ok.json');
  writeFileSync(p, JSON.stringify({ persona: 'auditor', verdict: 'approve', summary: 's', findings: [] }));
  const out = path.join(repo, 'briefing-x.json');
  const r = spawnSync(process.execPath,
    [TRIAGE, '--round1', p, '--repo', repo, '--base=--output=/tmp/x', '--out', out],
    { encoding: 'utf-8', timeout: 30_000 });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /looks like an option/);
});

test('an unreadable round-1 file is exit 2, not exit 1 — this run could not read a review, it did not judge one', () => {
  const bad = path.join(repo, 'round1-bad.json');
  writeFileSync(bad, '{ not valid json');
  const out = path.join(repo, 'briefing-bad.json');
  const r = spawnSync(process.execPath,
    [TRIAGE, '--round1', bad, '--repo', repo, '--base', 'base', '--out', out],
    { encoding: 'utf-8', timeout: 30_000 });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /triage:.*round1-bad\.json/);
});
