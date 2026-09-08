// Tests for src/probe.mjs — a reproduction a reviewer attached, and what
// re-running it found.
//
// The asymmetry under test is the module's whole point and is stated once here
// so the cases below do not each re-argue it. `confirmed: true` is the only
// thing that buys a finding `demonstrated`, the strongest label this tool
// prints and one that lets a single reviewer block a change. So it takes three
// independent yeses — this process ran the script, this process saw exit 0,
// and the reporter said it reproduced — and EVERY other state is `false`. The
// cost of being wrong in that direction is a finding judged exactly as it would
// have been before probes existed, which is no cost at all.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  INTERPRETERS, MAX_PROBE_OUTPUT_CHARS, declinedProbe, indexProbes, normalizeProbes,
  parseProbeClaim, probeKey, resolveScript, runProbe,
} from '../src/probe.mjs';

const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

function scratch(files = { 'p.sh': 'exit 0\n' }) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'adverse-probe-'));
  for (const [rel, body] of Object.entries(files)) {
    const at = path.join(dir, rel);
    mkdirSync(path.dirname(at), { recursive: true });
    writeFileSync(at, body);
  }
  return dir;
}

const entry = (over = {}) => ({
  persona: 'auditor',
  agent: 'auditor',
  title: 'mean returns NaN on an empty list',
  claim: parseProbeClaim({ script: 'p.sh', expect: 'NaN', observed: 'NaN', outcome: 'reproduced' }),
  ...over,
});

// A stand-in for spawnSync. `result` is what the script "did".
const fakeRun = (result) => () => ({ status: 0, stdout: '', stderr: '', ...result });

// ---------- the claim a reviewer writes ------------------------------------

test('a claim is canonicalized and its outcome is held to the vocabulary', () => {
  const c = parseProbeClaim({ script: ' p.sh ', expect: 'x', observed: 'y', outcome: 'reproduced' });
  assert.deepEqual(c, { script: 'p.sh', expect: 'x', observed: 'y', outcome: 'reproduced' });
});

// Garbage must not be able to buy a stronger word than the vocabulary allows —
// the direction normalizeVerdict already takes in synthesis.mjs. `inconclusive`
// is the value that claims nothing.
test('an outcome outside the vocabulary normalizes to the one that claims nothing', () => {
  for (const outcome of ['REPRODUCED', 'demonstrated', 'yes', 42, null, {}]) {
    assert.equal(parseProbeClaim({ script: 'p.sh', outcome }).outcome, 'inconclusive');
  }
});

test('a non-object probe is no claim at all, not an empty one', () => {
  for (const raw of [null, undefined, 'p.sh', 7, ['p.sh']]) {
    assert.equal(parseProbeClaim(raw), null);
  }
});

// ---------- which scripts may run -------------------------------------------

test('a script inside the reporter\'s own directory resolves, with its interpreter', () => {
  const root = scratch();
  const r = resolveScript(root, 'p.sh');
  assert.equal(r.path, path.join(root, 'p.sh'));
  assert.deepEqual(r.argv, INTERPRETERS['.sh']);
});

// The confinement is the point: a probe may not run a script another lane
// wrote, and may not reach out of the run directory at all.
test('a script escaping the reporter\'s directory is refused, not run', () => {
  const root = scratch();
  for (const script of ['../elsewhere/p.sh', '/etc/p.sh', '../../p.sh']) {
    const r = resolveScript(root, script);
    assert.equal(r.path, undefined);
    assert.match(r.why, /escapes the reporter's own directory/);
  }
});

test('an extension with no interpreter is refused rather than guessed at', () => {
  const root = scratch({ 'p.rb': 'exit 0\n', p: 'exit 0\n' });
  assert.match(resolveScript(root, 'p.rb').why, /no interpreter for \.rb/);
  assert.match(resolveScript(root, 'p').why, /no interpreter for a script with no extension/);
});

// A payload naming a script after an Object.prototype member is refused. What
// makes that hold is `path.extname` returning a LEADING DOT — the key is
// `.constructor`, which no prototype answers — and not the null prototype
// INTERPRETERS is built on: making it a plain object leaves this green.
// Asserted anyway, because the behavior is what matters and it should stay
// true if the key ever stops carrying the dot.
test('a script named after a prototype member is not a runnable probe', () => {
  const root = scratch({ 'p.constructor': 'x', 'p.__proto__': 'x', 'p.toString': 'x' });
  for (const script of ['p.constructor', 'p.__proto__', 'p.toString']) {
    assert.match(resolveScript(root, script).why, /no interpreter/);
  }
});

test('a symlink is refused where a regular file would be opened', () => {
  const root = scratch({ 'real.sh': 'exit 0\n' });
  symlinkSync(path.join(root, 'real.sh'), path.join(root, 'link.sh'));
  assert.match(resolveScript(root, 'link.sh').why, /not a readable regular file/);
});

test('a directory is not a script', () => {
  const root = scratch({ 'p.sh/inner.txt': 'x' });
  assert.match(resolveScript(root, 'p.sh').why, /not a regular file/);
});

test('a missing script is refused with a reason, never spawned', () => {
  assert.match(resolveScript(scratch(), 'gone.sh').why, /not a readable regular file/);
});

// ---------- what running one establishes ------------------------------------

test('exit 0 on a claimed reproduction is the one state that confirms', () => {
  const root = scratch();
  const p = runProbe(entry(), { root, cwd: root, run: fakeRun({ status: 0, stdout: 'NaN' }) });
  assert.equal(p.source, 'measured');
  assert.equal(p.status, 'reproduced');
  assert.equal(p.confirmed, true);
  assert.equal(p.why, '');
  assert.equal(p.ran.exitCode, 0);
  assert.equal(p.ran.output, 'NaN');
});

test('a non-zero exit did not reproduce, and says whose account it contradicts', () => {
  const root = scratch();
  const p = runProbe(entry(), { root, cwd: root, run: fakeRun({ status: 1, stderr: 'no' }) });
  assert.equal(p.status, 'not-reproduced');
  assert.equal(p.confirmed, false);
  assert.match(p.why, /the reporter recorded a reproduction, and re-running it did not reproduce/);
});

// "Could not tell" must not collapse into either verdict. That is the class of
// bug src/gate.mjs was written to close, and this module inherits it.
test('a script that could not run at all is inconclusive, never a pass or a failure', () => {
  const root = scratch();
  for (const r of [{ error: new Error('ENOENT') }, { signal: 'SIGTERM', status: null }, { status: null }]) {
    const p = runProbe(entry(), { root, cwd: root, run: fakeRun(r) });
    assert.equal(p.status, 'inconclusive');
    assert.equal(p.confirmed, false);
    assert.match(p.why, /could not be run to a verdict/);
  }
});

// A reviewer whose own probe says it did not reproduce is not asking anyone to
// believe a reproduction, so a green exit code cannot mint one on its behalf.
test('a reproduction the reporter never claimed does not confirm on the exit code alone', () => {
  const root = scratch();
  for (const outcome of ['not-reproduced', 'inconclusive']) {
    const e = entry({ claim: parseProbeClaim({ script: 'p.sh', outcome }) });
    const p = runProbe(e, { root, cwd: root, run: fakeRun({ status: 0 }) });
    assert.equal(p.status, 'reproduced');
    assert.equal(p.confirmed, false);
    assert.match(p.why, new RegExp(`reporter recorded \`${outcome}\``));
  }
});

test('an unrunnable script is declined rather than run, and the finding keeps its claim', () => {
  const root = scratch();
  const e = entry({ claim: parseProbeClaim({ script: '../x.sh', outcome: 'reproduced' }) });
  const p = runProbe(e, { root, cwd: root, run: () => assert.fail('must not spawn') });
  assert.equal(p.source, 'declined');
  assert.equal(p.confirmed, false);
  assert.equal(p.claim.outcome, 'reproduced');
});

test('an operator-supplied sandbox prefixes the interpreter and is not reinterpreted', () => {
  const root = scratch();
  let argv = null;
  runProbe(entry(), {
    root,
    cwd: root,
    sandbox: ['bwrap', '--unshare-net', '--'],
    run: (cmd, args) => { argv = [cmd, ...args]; return { status: 0, stdout: '', stderr: '' }; },
  });
  assert.deepEqual(argv.slice(0, 4), ['bwrap', '--unshare-net', '--', 'sh']);
  assert.equal(argv[4], path.join(root, 'p.sh'));
});

// The captured output is the stdout of code from the diff under review, and it
// is rendered into a Markdown report and an HTML dashboard. A probe that prints
// a gigabyte must not be a probe that ate the report.
test('captured output is bounded', () => {
  const root = scratch();
  const p = runProbe(entry(), {
    root, cwd: root, run: fakeRun({ status: 0, stdout: 'x'.repeat(MAX_PROBE_OUTPUT_CHARS * 3) }),
  });
  assert.ok(p.ran.output.length < MAX_PROBE_OUTPUT_CHARS * 2);
  assert.match(p.ran.output, /clipped/);
});

test('a probe reads nothing and inherits no proxy', () => {
  const root = scratch();
  let opts = null;
  runProbe(entry(), {
    root,
    cwd: root,
    env: { HTTPS_PROXY: 'http://p', http_proxy: 'http://p', PATH: '/bin' },
    run: (_c, _a, o) => { opts = o; return { status: 0, stdout: '', stderr: '' }; },
  });
  assert.deepEqual(opts.stdio, ['ignore', 'pipe', 'pipe']);
  assert.equal(opts.env.HTTPS_PROXY, undefined);
  assert.equal(opts.env.http_proxy, undefined);
  assert.equal(opts.env.no_proxy, '*');
  assert.equal(opts.env.ADVERSE_NO_TELEMETRY, '1');
});

// ---------- declining is free ------------------------------------------------

test('a declined probe carries its reason and confirms nothing', () => {
  const p = declinedProbe(entry(), 'the plan does not offer probes on this run');
  assert.equal(p.source, 'declined');
  assert.equal(p.status, 'inconclusive');
  assert.equal(p.confirmed, false);
  assert.equal(p.why, 'the plan does not offer probes on this run');
  assert.equal(p.ran, null);
});

// ---------- the join back to a finding ---------------------------------------

test('the join key normalizes a title the way the synthesizer does', () => {
  assert.equal(probeKey('auditor', 'Mean returns   NaN.'), probeKey('auditor', 'mean returns nan'));
  assert.notEqual(probeKey('auditor', 'x'), probeKey('steward', 'x'));
});

// The two sides of this join see the same title in two states: a finding is
// keyed after `buildFinding` trimmed it, a probe record carries what its
// payload wrote. Without the trim inside the one function both call, a title
// with stray whitespace keys two ways and the probe silently never attaches —
// no error, no missing field, just a finding that is never `demonstrated`.
test('a title trimmed on one side of the join still matches the untrimmed one', () => {
  assert.equal(probeKey('auditor', '  mean returns nan  '), probeKey('auditor', 'mean returns nan'));
});

// A lane that filed two probes under one title filed one finding twice, and the
// second cannot add evidence the first did not.
test('the first record under a key wins', () => {
  const a = { persona: 'auditor', title: 'x', confirmed: true };
  const b = { persona: 'auditor', title: 'X', confirmed: false };
  assert.equal(indexProbes([a, b]).get(probeKey('auditor', 'x')), a);
});

test('a record that is not an object is skipped rather than indexed', () => {
  assert.equal(indexProbes([null, 'x', 1]).size, 0);
  assert.equal(indexProbes(undefined).size, 0);
});

// ---------- reading a written record back ------------------------------------

const recordFile = (over = {}) => ({
  enabled: true,
  head: HEAD,
  isolation: { sandbox: null },
  probes: [{
    persona: 'auditor',
    agent: 'auditor',
    title: 'x',
    claim: { script: 'p.sh', expect: '', observed: '', outcome: 'reproduced' },
    source: 'measured',
    status: 'reproduced',
    ran: { exitCode: 0, output: '' },
    why: '',
  }],
  ...over,
});

test('a measured record bound to the reviewed head reads back confirmed', () => {
  const n = normalizeProbes(recordFile(), { head: HEAD });
  assert.equal(n.probes[0].confirmed, true);
});

// Staleness is only knowable against the tree actually under review, which is
// the same argument normalizeGate makes. A convergence loop makes it concrete:
// Phase 9 lands fix commits and loops back through the same run directory.
test('a record bound to a different commit confirms nothing', () => {
  const n = normalizeProbes(recordFile(), { head: OTHER });
  assert.equal(n.probes[0].confirmed, false);
  assert.equal(n.probes[0].source, 'declined');
  assert.match(n.probes[0].why, /not the tree under review/);
});

test('a record bound to no commit at all confirms nothing', () => {
  const n = normalizeProbes(recordFile({ head: null }), { head: HEAD });
  assert.equal(n.probes[0].confirmed, false);
  assert.match(n.probes[0].why, /not bound to a commit/);
});

// The operator's own flag, and the reason it is stored rather than inferred: a
// file describing runs nobody authorized must not confirm anything, however
// green its exit codes were.
test('a record whose run never enabled execution confirms nothing', () => {
  const n = normalizeProbes(recordFile({ enabled: false }), { head: HEAD });
  assert.equal(n.probes[0].confirmed, false);
  assert.match(n.probes[0].why, /not enabled for this run/);
});

// `confirmed` is recomputed here rather than trusted, because a file is the one
// place an agent can write to.
test('a stored `confirmed` is recomputed, not believed', () => {
  const forged = recordFile();
  forged.probes[0].source = 'declined';
  forged.probes[0].confirmed = true;
  assert.equal(normalizeProbes(forged, { head: HEAD }).probes[0].confirmed, false);
});

test('an off-vocabulary source or status normalizes to the state that claims nothing', () => {
  const odd = recordFile();
  odd.probes[0].source = 'asserted';
  odd.probes[0].status = 'demonstrated';
  const p = normalizeProbes(odd, { head: HEAD }).probes[0];
  assert.equal(p.source, 'declined');
  assert.equal(p.status, 'inconclusive');
  assert.equal(p.confirmed, false);
});

test('no record, or one that is not a record, is null rather than an empty confirmation', () => {
  assert.equal(normalizeProbes(null), null);
  assert.equal(normalizeProbes([]), null);
  assert.equal(normalizeProbes('probes.json'), null);
});

test('a record with no head is taken as given when the caller names no head either', () => {
  const n = normalizeProbes(recordFile({ head: null }));
  assert.equal(n.probes[0].confirmed, true);
});
