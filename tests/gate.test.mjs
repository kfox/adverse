// Tests for src/gate.mjs — what the repo's own checks said, and whether that
// is allowed to suppress a reviewer's findings.
//
// The asymmetry under test is the whole point of the module and is stated once
// here so the individual cases do not each re-argue it: `verified: true` lets
// four lanes stay silent about a category of defect, so it has to be earned by
// commands that demonstrably ran against the tree under review. Every other
// state — asserted, unbound, stale, red, partial, empty — is `false`, and the
// cost of being wrong in that direction is a redundant finding rather than an
// invisible one.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { assertedGate, normalizeGate, runCheck, runGate } from '../src/gate.mjs';

const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

// A stand-in for spawnSync: `spec` maps a command to what it did.
const fakeRun = (spec) => (command) => spec[command] ?? { status: 0, stdout: '', stderr: '' };

const check = (name, command) => ({ name, command });

test('every check exiting 0 is green, and green against this tree verifies', () => {
  const gate = runGate([check('lint', 'L'), check('test', 'T')], {
    head: HEAD,
    run: fakeRun({ L: { status: 0, stdout: 'ok', stderr: '' }, T: { status: 0, stdout: '', stderr: '' } }),
  });
  assert.equal(gate.status, 'green');
  assert.equal(gate.source, 'measured');
  assert.equal(normalizeGate(gate, { head: HEAD }).verified, true);
});

test('one failing check makes the gate red, whatever the others said', () => {
  const gate = runGate([check('lint', 'L'), check('test', 'T')], {
    head: HEAD,
    run: fakeRun({ L: { status: 0, stdout: '', stderr: '' }, T: { status: 1, stdout: '', stderr: '3 failed' } }),
  });
  assert.equal(gate.status, 'red');
  assert.equal(gate.verified, false);
  assert.match(gate.summary, /test exit 1/);
});

// The distinction this protects: "could not tell" must not collapse into
// either "passed" or "failed". A spawn error folded into a pass is a
// fabricated green; folded into a failure it aborts a review for no reason.
test('a check that cannot be spawned is partial — neither a pass nor a failure', () => {
  const gate = runGate([check('lint', 'L'), check('typecheck', 'X')], {
    head: HEAD,
    run: fakeRun({ L: { status: 0, stdout: '', stderr: '' }, X: { error: new Error('ENOENT') } }),
  });
  assert.equal(gate.status, 'partial');
  assert.equal(gate.verified, false);
  assert.equal(gate.checks.find((c) => c.name === 'typecheck').exitCode, null);
});

test('a check killed by its timeout did not answer, and is not a pass', () => {
  const gate = runGate([check('test', 'T')], {
    head: HEAD,
    run: fakeRun({ T: { status: null, signal: 'SIGTERM', stdout: '', stderr: '' } }),
  });
  assert.equal(gate.status, 'partial');
  assert.equal(gate.checks[0].exitCode, null);
  assert.match(gate.checks[0].result, /SIGTERM/);
});

test('no checks at all is unknown, never an empty green', () => {
  const gate = runGate([], { head: HEAD });
  assert.equal(gate.status, 'unknown');
  assert.equal(gate.verified, false);
});

test('a hand-typed summary is asserted, and asserted never verifies', () => {
  const gate = normalizeGate('lint green · 1,412 tests pass', { head: HEAD });
  assert.equal(gate.source, 'asserted');
  assert.equal(gate.status, 'unknown');
  assert.equal(gate.verified, false);
  assert.equal(gate.summary, 'lint green · 1,412 tests pass');
});

test('a green run against a different commit does not verify, and says which', () => {
  const gate = normalizeGate(runGate([check('lint', 'L')], { head: OTHER, run: fakeRun({}) }), { head: HEAD });
  assert.equal(gate.status, 'green');
  assert.equal(gate.verified, false);
  assert.match(gate.why, /not the tree under review/);
});

// A record with no `head` cannot be shown to describe this tree, so it is
// treated exactly like one that describes a different tree.
test('a measured record with no commit binding does not verify', () => {
  const gate = normalizeGate({
    status: 'green', source: 'measured', head: null, summary: 'lint exit 0',
    checks: [{ name: 'lint', command: 'L', exitCode: 0, result: '' }],
  }, { head: HEAD });
  assert.equal(gate.verified, false);
  assert.match(gate.why, /not bound to a commit/);
});

test('no gate at all is null — absent and unverified are different answers', () => {
  assert.equal(normalizeGate(null, { head: HEAD }), null);
  assert.equal(normalizeGate(undefined, { head: HEAD }), null);
});

// Anything that arrives claiming to be measured but carries no evidence of a
// run is downgraded rather than believed: `source` is data from a file, and a
// file in the run directory is writable by every agent in the run.
test('a payload claiming measured with an unrecognized status is recomputed from its checks', () => {
  const gate = normalizeGate({
    status: 'immaculate', source: 'measured', head: HEAD,
    checks: [{ name: 'lint', command: 'L', exitCode: 1, result: 'boom' }],
  }, { head: HEAD });
  assert.equal(gate.status, 'red');
  assert.equal(gate.verified, false);
});

test('an unrecognized source is treated as asserted, not as measured', () => {
  const gate = normalizeGate({
    status: 'green', source: 'vibes', head: HEAD, summary: 's', checks: [],
  }, { head: HEAD });
  assert.equal(gate.source, 'asserted');
  assert.equal(gate.verified, false);
});

test('a check reports its last meaningful line, preferring stderr', () => {
  const r = runCheck(check('test', 'T'), {
    run: fakeRun({ T: { status: 1, stdout: 'ran 10\nran 11', stderr: 'FAIL: two\n' } }),
  });
  assert.equal(r.result, 'FAIL: two');
});

test('assertedGate is what a bare string becomes, and it carries no checks', () => {
  const gate = assertedGate('everything is fine');
  assert.equal(gate.source, 'asserted');
  assert.deepEqual(gate.checks, []);
  assert.equal(gate.verified, false);
});

// --- the working-tree half of the binding ---
//
// A commit SHA does not move when uncommitted changes do, and reviewing
// uncommitted changes is one of this tool's scope modes. So the record pins
// both, and a gate is evidence only while both still hold.

test('a green gate whose working tree moved does not verify', () => {
  const gate = normalizeGate(
    runGate([check('lint', 'L')], { head: HEAD, worktree: 'w1', run: fakeRun({}) }),
    { head: HEAD, worktree: 'w2' });
  assert.equal(gate.status, 'green');
  assert.equal(gate.verified, false);
  assert.match(gate.why, /working tree changed/);
});

test('a measured record with no working-tree digest does not verify when one is asked for', () => {
  const gate = normalizeGate({
    status: 'green', source: 'measured', head: HEAD, worktree: null, summary: 's',
    checks: [{ name: 'lint', command: 'L', exitCode: 0, result: '' }],
  }, { head: HEAD, worktree: 'w1' });
  assert.equal(gate.verified, false);
  assert.match(gate.why, /not pinned to a working-tree state/);
});

// A caller that cannot compute a digest asks the narrower question and gets the
// narrower answer, rather than every gate failing to verify.
test('a caller that supplies no digest still gets the HEAD answer', () => {
  const gate = normalizeGate(
    runGate([check('lint', 'L')], { head: HEAD, worktree: 'w1', run: fakeRun({}) }),
    { head: HEAD });
  assert.equal(gate.verified, true);
});

test('a passing check reports stdout, not its runner\'s stderr banner', () => {
  const r = runCheck(check('lint', 'L'), {
    run: fakeRun({ L: { status: 0, stdout: 'all files clean', stderr: 'npm notice run lint' } }),
  });
  assert.equal(r.result, 'all files clean');
});

test('worktreeDigest returns null when git cannot answer, rather than a digest of nothing', async () => {
  const { worktreeDigest } = await import('../src/gate.mjs');
  const digest = worktreeDigest('/nonexistent-repo-for-adverse-tests', {
    exec: () => { throw new Error('not a git repository'); },
  });
  assert.equal(digest, null);
});
