// Tests for skills/adverse-review/scripts/gate.mjs — the Phase 0 bridge.
//
// The predicates are proven in-process in tests/gate.test.mjs and are not
// repeated here. What only exists at the process boundary is the part below:
// argv refusals, the exit-code contract, that the record on disk is bound to
// the real HEAD of a real checkout, and that the two ways of establishing
// nothing (no --check, unresolvable HEAD) refuse instead of writing a file
// that would later read as evidence.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const GATE = path.join(here, '..', 'skills', 'adverse-review', 'scripts', 'gate.mjs');

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };

function repoWithOneCommit() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'adverse-gate-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, env: GIT_ENV, encoding: 'utf-8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  git('add', '.');
  git('commit', '-qm', 'one');
  return { dir, head: git('rev-parse', 'HEAD').trim() };
}

const run = (args, cwd) => spawnSync(process.execPath, [GATE, ...args], { cwd, encoding: 'utf-8', env: GIT_ENV });

test('a passing check writes a green record bound to HEAD, and exits 0', () => {
  const { dir, head } = repoWithOneCommit();
  const out = path.join(dir, 'gate.json');
  const r = run(['--repo', dir, '--check', 'lint=exit 0', '--out', out], dir);

  assert.equal(r.status, 0);
  const gate = JSON.parse(readFileSync(out, 'utf-8'));
  assert.equal(gate.status, 'green');
  assert.equal(gate.source, 'measured');
  assert.equal(gate.head, head);
  assert.equal(gate.verified, true);
  assert.deepEqual(gate.checks.map((c) => [c.name, c.exitCode]), [['lint', 0]]);
  assert.match(r.stdout, /verified/);
});

// Exit 1 is the bridge contract's "a claim about the change", which is what a
// failing check is. SKILL.md's Phase 0 abort reads this.
test('a failing check exits 1 and still writes the record', () => {
  const { dir } = repoWithOneCommit();
  const out = path.join(dir, 'gate.json');
  const r = run(['--repo', dir, '--check', 'lint=exit 0', '--check', 'test=exit 3', '--out', out], dir);

  assert.equal(r.status, 1);
  const gate = JSON.parse(readFileSync(out, 'utf-8'));
  assert.equal(gate.status, 'red');
  assert.equal(gate.verified, false);
  assert.equal(gate.checks.find((c) => c.name === 'test').exitCode, 3);
});

// A missing command is not a "could not run" at this layer: the shell runs, and
// reports 127. That is a check answering no, and the gate is red.
test('a command the shell cannot find is a failing check, not an unrunnable one', () => {
  const { dir } = repoWithOneCommit();
  const out = path.join(dir, 'gate.json');
  const r = run(['--repo', dir, '--check', 'typecheck=adverse-no-such-command-xyz', '--out', out], dir);

  assert.equal(r.status, 1);
  const gate = JSON.parse(readFileSync(out, 'utf-8'));
  assert.equal(gate.status, 'red');
  assert.equal(gate.verified, false);
});

// Partial is not an abort: nothing objected, so the panel may run — the gate
// simply suppresses nothing. A timeout is the way a check genuinely fails to
// answer, and the record must not round that off to either a pass or a failure.
test('a check killed by its timeout is partial, exits 0, and does not verify', () => {
  const { dir } = repoWithOneCommit();
  const out = path.join(dir, 'gate.json');
  const r = run(['--repo', dir, '--check', 'slow=sleep 30', '--timeout', '250', '--out', out], dir);

  assert.equal(r.status, 0);
  const gate = JSON.parse(readFileSync(out, 'utf-8'));
  assert.equal(gate.status, 'partial');
  assert.equal(gate.verified, false);
  assert.equal(gate.checks[0].exitCode, null);
  assert.match(gate.why, /could not be run/);
});

test('no --check refuses at exit 2 and writes nothing — an unconfigured gate is not a pass', () => {
  const { dir } = repoWithOneCommit();
  const out = path.join(dir, 'gate.json');
  const r = run(['--repo', dir, '--out', out], dir);

  assert.equal(r.status, 2);
  assert.match(r.stderr, /at least one --check/);
  assert.equal(existsSync(out), false);
});

test('a malformed --check refuses rather than guessing where the command starts', () => {
  const { dir } = repoWithOneCommit();
  const r = run(['--repo', dir, '--check', 'npm test', '--out', path.join(dir, 'g.json')], dir);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /must be 'name=command'/);
});

test('a command containing = keeps everything after the first = ', () => {
  const { dir } = repoWithOneCommit();
  const out = path.join(dir, 'gate.json');
  const r = run(['--repo', dir, '--check', 'env=FOO=1 exit 0', '--out', out], dir);
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(readFileSync(out, 'utf-8')).checks[0].command, 'FOO=1 exit 0');
});

test('a repo with no commits cannot bind the record to a tree, so it refuses', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'adverse-gate-empty-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir, env: GIT_ENV });
  const out = path.join(dir, 'gate.json');
  const r = run(['--repo', dir, '--check', 'lint=exit 0', '--out', out], dir);

  assert.equal(r.status, 2);
  assert.match(r.stderr, /cannot resolve HEAD/);
  assert.equal(existsSync(out), false);
});

test('--timeout must be a positive number', () => {
  const { dir } = repoWithOneCommit();
  const r = run(['--repo', dir, '--check', 'lint=exit 0', '--timeout', 'soon', '--out', path.join(dir, 'g.json')], dir);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /positive number/);
});

test('checks run in the repo, not in the caller\'s working directory', () => {
  const { dir } = repoWithOneCommit();
  const elsewhere = mkdtempSync(path.join(os.tmpdir(), 'adverse-gate-cwd-'));
  const out = path.join(dir, 'gate.json');
  const r = run(['--repo', dir, '--check', 'here=test -f a.txt', '--out', out], elsewhere);
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(readFileSync(out, 'utf-8')).status, 'green');
});

test('--help exits 0 with the usage text', () => {
  const { dir } = repoWithOneCommit();
  const r = run(['--help'], dir);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Usage: gate\.mjs/);
});
