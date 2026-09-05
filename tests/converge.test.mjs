// Tests for skills/adverse-review/scripts/converge.mjs — the loop's control flow.
//
// This script IS the stop condition: its exit code is what decides whether the
// convergence loop runs again, and nothing else in the tree checks it. The
// module underneath (src/ledger.mjs) is well covered, but every bug this file
// pins lived in the bridge — argument coercion, which commit an anchor is
// recorded against, and the mapping from status to exit code.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CONVERGE = path.join(here, '..', 'skills', 'adverse-review', 'scripts', 'converge.mjs');

// Fixture repos must not inherit the developer's git config — a global
// `tag.gpgSign = true` makes `git tag` fail with "no tag message?".
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
const git = (repo, args) => execFileSync('git', args, { cwd: repo, encoding: 'utf-8', env: GIT_ENV });

function repoWithTwoCommits() {
  const repo = mkdtempSync(path.join(os.tmpdir(), 'converge-'));
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.email', 't@example.com']);
  git(repo, ['config', 'user.name', 'T']);
  git(repo, ['config', 'commit.gpgSign', 'false']);

  writeFileSync(path.join(repo, 'app.py'), Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n') + '\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'reviewed tree']);
  const reviewed = git(repo, ['rev-parse', 'HEAD']).trim();

  // A fix that inserts 10 lines at the top, so every anchor below moves.
  writeFileSync(path.join(repo, 'app.py'),
    Array.from({ length: 10 }, (_, i) => `new ${i + 1}`).join('\n') + '\n'
    + Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n') + '\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'the fix']);
  const fixed = git(repo, ['rev-parse', 'HEAD']).trim();

  return { repo, reviewed, fixed };
}

const blockingFinding = (over = {}) => ({
  severity: 'critical', kind: 'defect', file: 'app.py', line: 30,
  title: 'Off-by-one in the loop bound', blocking: true, confidence: 'consensus',
  ...over,
});

function run(args, cwd) {
  return spawnSync('node', [CONVERGE, ...args], { encoding: 'utf-8', cwd, env: GIT_ENV });
}

function writeJson(dir, name, obj) {
  const file = path.join(dir, name);
  writeFileSync(file, JSON.stringify(obj));
  return file;
}

// --- exit codes are the loop's control flow ---------------------------------

test('exit 1 while a blocking finding is unsettled', () => {
  const { repo } = repoWithTwoCommits();
  const report = writeJson(repo, 'report.json', { findings: [blockingFinding()] });
  const r = run(['--ledger', path.join(repo, 'l.json'), '--report', report, '--repo', repo], repo);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stdout, /still open \(1\)/);
});

test('exit 0 when nothing blocking is left', () => {
  const { repo } = repoWithTwoCommits();
  const report = writeJson(repo, 'report.json', { findings: [] });
  const r = run(['--ledger', path.join(repo, 'l.json'), '--report', report, '--repo', repo], repo);
  assert.equal(r.status, 0, r.stderr);
});

test('an advisory finding never holds the loop open', () => {
  const { repo } = repoWithTwoCommits();
  const report = writeJson(repo, 'report.json', {
    findings: [blockingFinding({ kind: 'design', blocking: false })],
  });
  assert.equal(run(['--ledger', path.join(repo, 'l.json'), '--report', report, '--repo', repo], repo).status, 0);
});

test('exit 3 at the iteration cap — a stop, not a pass', () => {
  const { repo, reviewed } = repoWithTwoCommits();
  const ledger = path.join(repo, 'l.json');
  const report = writeJson(repo, 'report.json', { findings: [blockingFinding()] });

  // Two recorded iterations, cap of 2, so the third pass is over the line.
  for (const i of [1, 2]) {
    const decisions = writeJson(repo, `d${i}.json`, {
      decisions: [{ ...blockingFinding({ title: `unrelated ${i}` }), disposition: 'fixed', reason: 'patched' }],
    });
    const rec = run(['--ledger', ledger, '--record', decisions, '--repo', repo, '--at', reviewed], repo);
    assert.equal(rec.status, 0, rec.stderr);
  }

  const r = run(['--ledger', ledger, '--report', report, '--repo', repo, '--max-iterations', '2'], repo);
  assert.equal(r.status, 3, `expected the cap, got ${r.status}: ${r.stderr}`);
});

test('exit 2 on a usage error', () => {
  const { repo } = repoWithTwoCommits();
  assert.equal(run([], repo).status, 2);
  assert.equal(run(['--ledger', path.join(repo, 'l.json'), '--repo', repo], repo).status, 2);
});

// --- the cap has to survive its own argument handling ------------------------

test('a non-numeric --max-iterations is refused, not silently uncapped', () => {
  // Number('lots') is NaN and `iteration > NaN` is false forever, so this used
  // to disable the cap outright: exit 3 unreachable, loop unbounded.
  const { repo } = repoWithTwoCommits();
  const report = writeJson(repo, 'report.json', { findings: [blockingFinding()] });
  const r = run(['--ledger', path.join(repo, 'l.json'), '--report', report,
                 '--repo', repo, '--max-iterations', 'lots'], repo);
  assert.equal(r.status, 2, 'a bad cap must be a usage error');
  assert.match(r.stderr, /positive integer/);
});

test('the default cap is a real number, not NaN', () => {
  // Dropping the default here so the module's own could apply does not work:
  // the option object is passed unconditionally, and a destructuring default
  // fires on `undefined`, never on NaN.
  const { repo } = repoWithTwoCommits();
  const report = writeJson(repo, 'report.json', { findings: [blockingFinding()] });
  const r = run(['--ledger', path.join(repo, 'l.json'), '--report', report, '--repo', repo], repo);
  assert.match(r.stdout, /of at most 3:/, 'the default cap must be reported as a number');
  assert.doesNotMatch(r.stdout, /NaN/);
});

// --- what an anchor is recorded against --------------------------------------

test('--at records anchors at the reviewed tree, so tracing is not the identity', () => {
  const { repo, reviewed, fixed } = repoWithTwoCommits();
  const ledger = path.join(repo, 'l.json');
  const decisions = writeJson(repo, 'd.json', {
    decisions: [{ ...blockingFinding(), disposition: 'declined', reason: 'intended behavior' }],
  });

  const rec = run(['--ledger', ledger, '--record', decisions, '--repo', repo, '--at', reviewed], repo);
  assert.equal(rec.status, 0, rec.stderr);
  const saved = JSON.parse(readFileSync(ledger, 'utf-8'));
  assert.equal(saved.entries[0].atCommit, reviewed,
    'the anchor belongs to the tree the panel read, not the tree after the fix');
  assert.notEqual(saved.entries[0].atCommit, fixed);

  // The fix inserted 10 lines above, so the declined finding must still be
  // recognized at its new line and stay settled.
  const report = writeJson(repo, 'report.json', { findings: [blockingFinding({ line: 40 })] });
  const r = run(['--ledger', ledger, '--report', report, '--repo', repo], repo);
  assert.equal(r.status, 0, `a re-projected settled finding must not reopen: ${r.stdout}`);
});

test('omitting --at warns that re-projection will be a no-op', () => {
  const { repo } = repoWithTwoCommits();
  const decisions = writeJson(repo, 'd.json', {
    decisions: [{ ...blockingFinding(), disposition: 'declined', reason: 'intended' }],
  });
  const r = run(['--ledger', path.join(repo, 'l.json'), '--record', decisions, '--repo', repo], repo);
  assert.equal(r.status, 0);
  assert.match(r.stderr, /--at not given/);
});

test('a decision with no reason is refused', () => {
  const { repo, reviewed } = repoWithTwoCommits();
  const decisions = writeJson(repo, 'd.json', {
    decisions: [{ ...blockingFinding(), disposition: 'declined' }],
  });
  const r = run(['--ledger', path.join(repo, 'l.json'), '--record', decisions, '--repo', repo, '--at', reviewed], repo);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no reason/);
});

test('an unknown disposition is refused', () => {
  const { repo, reviewed } = repoWithTwoCommits();
  const decisions = writeJson(repo, 'd.json', {
    decisions: [{ ...blockingFinding(), disposition: 'probably-fine', reason: 'eh' }],
  });
  const r = run(['--ledger', path.join(repo, 'l.json'), '--record', decisions, '--repo', repo, '--at', reviewed], repo);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown disposition/);
});

// --- the ledger is untrusted input -------------------------------------------

test('a file-wide ledger entry cannot settle an anchored finding', () => {
  // One hand-written entry with `line: null` used to match every finding of
  // its kind in the file and report the run converged without reviewing it.
  // Anchored at a real commit here, so it passes binding and the SETTLING_SCORE
  // gate is what has to refuse it.
  const { repo, reviewed } = repoWithTwoCommits();
  const ledger = path.join(repo, 'l.json');
  writeFileSync(ledger, JSON.stringify({
    version: 1, base: null, iterations: [],
    entries: [{ id: 'X', title: '', kind: 'defect', file: 'app.py', line: null,
                disposition: 'declined', reason: 'nothing to see here', atCommit: reviewed }],
  }));
  const report = writeJson(repo, 'report.json', { findings: [blockingFinding()] });
  const r = run(['--ledger', ledger, '--report', report, '--repo', repo], repo);
  assert.equal(r.status, 1, 'a wildcard entry must not converge the loop');
});

test('a ledger whose entries name no commit is refused outright', () => {
  // Binding used to be opt-out: it only validated atCommit `if` the field was
  // truthy, so deleting it from a foreign ledger passed clean. recordDecisions
  // always writes one, so an entry without it did not come from this tool.
  const { repo } = repoWithTwoCommits();
  const ledger = path.join(repo, 'l.json');
  writeFileSync(ledger, JSON.stringify({
    version: 1, iterations: [],
    entries: [{ id: 'X', title: 'Off-by-one in the loop bound', kind: 'defect',
                file: 'app.py', line: null, disposition: 'declined', reason: 'trust me' }],
  }));
  const report = writeJson(repo, 'report.json', { findings: [blockingFinding()] });
  const r = run(['--ledger', ledger, '--report', report, '--repo', repo], repo);
  assert.equal(r.status, 2, 'an unanchored ledger must be refused, not adjudicated from');
  assert.match(r.stderr, /carries no atCommit/);
});

test('a ledger anchored in another repository is refused', () => {
  const { repo } = repoWithTwoCommits();
  const ledger = path.join(repo, 'l.json');
  writeFileSync(ledger, JSON.stringify({
    version: 1, base: 'some-other-repo-entirely', iterations: [],
    entries: [{ id: 'X', title: 'a', kind: 'defect', file: 'app.py', line: 10,
                disposition: 'declined', reason: 'r', atCommit: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' }],
  }));
  const report = writeJson(repo, 'report.json', { findings: [blockingFinding()] });
  const r = run(['--ledger', ledger, '--report', report, '--repo', repo], repo);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /does not belong to this repository/);
});

test('a blocking finding nobody cross-examined holds the loop open', () => {
  // The stop condition's own regression, at the exit-code level: a round-2
  // reviewer's added critical has no validators and no challengers, so it is
  // `solo` and the confidence gate drops it.
  const { repo } = repoWithTwoCommits();
  const report = writeJson(repo, 'report.json', {
    cross_examined: true, // report-wide flag set by an edge on some OTHER finding
    findings: [{ ...blockingFinding(), confidence: 'solo', cross_examined: false }],
  });
  const r = run(['--ledger', path.join(repo, 'l.json'), '--report', report, '--repo', repo], repo);
  assert.equal(r.status, 1, 'an unexamined blocking critical must not converge');
  assert.match(r.stdout, /NOT CROSS-EXAMINED/);
});

test('a ledger from a future version is refused rather than guessed at', () => {
  const { repo } = repoWithTwoCommits();
  const ledger = path.join(repo, 'l.json');
  writeFileSync(ledger, JSON.stringify({ version: 99, entries: [] }));
  const report = writeJson(repo, 'report.json', { findings: [] });
  const r = run(['--ledger', ledger, '--report', report, '--repo', repo], repo);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /version 99/);
});

test('a disputed blocking critical is printed and holds the loop open', () => {
  // Challengers are checked before reporters in synthesis, so one persona can
  // label a critical two others found `disputed`. It used to leave `open`, be
  // excluded from `unexamined` as examined, and exit 0 having printed nothing.
  const { repo } = repoWithTwoCommits();
  const report = writeJson(repo, 'report.json', {
    findings: [{ ...blockingFinding(), confidence: 'disputed', cross_examined: true }],
  });
  const r = run(['--ledger', path.join(repo, 'l.json'), '--report', report, '--repo', repo], repo);
  assert.equal(r.status, 1, 'a challenge is not a verdict');
  assert.match(r.stdout, /DISPUTED — reported and challenged, still blocking/);
  assert.match(r.stdout, /record `declined` with the challenger's reasoning, or fix it/);
});

test('a blocking finding matching no bucket is named, not dropped', () => {
  // `solo` with a cross-examination edge cannot come out of synthesis, but it
  // can come out of a hand-edited report — and every previous leak in this
  // file was a blocking finding that matched none of the named buckets.
  const { repo } = repoWithTwoCommits();
  const report = writeJson(repo, 'report.json', {
    findings: [{ ...blockingFinding(), confidence: 'solo', cross_examined: true }],
  });
  const r = run(['--ledger', path.join(repo, 'l.json'), '--report', report, '--repo', repo], repo);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /UNCLASSIFIED — blocking and unsettled, matching no bucket/);
  assert.match(r.stdout, /off-contract/, 'the operator is told it may be the report, not the tool');
});

test('the unexamined remedy printed is one that advances the iteration counter', () => {
  // `iterations` grows only under --record, so a printed remedy that records
  // nothing freezes the counter, makes exit 3 unreachable, and lets a loop
  // that keeps taking it run forever.
  const { repo } = repoWithTwoCommits();
  const report = writeJson(repo, 'report.json', {
    findings: [{ ...blockingFinding(), confidence: 'solo', cross_examined: false }],
  });
  const r = run(['--ledger', path.join(repo, 'l.json'), '--report', report, '--repo', repo], repo);
  assert.match(r.stdout, /only --record advances the iteration counter/);
  assert.doesNotMatch(r.stdout, /Cross-examine them \(round 2\) or record/);
});

test('a report that is not a synthesis report is a usage error, not a clean review', () => {
  const { repo } = repoWithTwoCommits();
  const report = writeJson(repo, 'report.json', { verdict: 'looks fine to me' });
  const r = run(['--ledger', path.join(repo, 'l.json'), '--report', report, '--repo', repo], repo);
  assert.equal(r.status, 2, 'a usage error, not exit 1 — which claims findings are open');
  assert.match(r.stderr, /not a synthesis report/);
});
