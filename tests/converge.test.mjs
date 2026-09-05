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
  const { repo } = repoWithTwoCommits();
  const ledger = path.join(repo, 'l.json');
  writeFileSync(ledger, JSON.stringify({
    version: 1, base: null, iterations: [],
    entries: [{ id: 'X', title: '', kind: 'defect', file: 'app.py', line: null,
                disposition: 'declined', reason: 'nothing to see here', atCommit: null }],
  }));
  const report = writeJson(repo, 'report.json', { findings: [blockingFinding()] });
  const r = run(['--ledger', ledger, '--report', report, '--repo', repo], repo);
  assert.equal(r.status, 1, 'a wildcard entry must not converge the loop');
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
