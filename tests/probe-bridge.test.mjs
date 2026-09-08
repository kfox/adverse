// Tests for skills/adverse-review/scripts/probe.mjs — the Phase 2.5 bridge.
//
// The predicates are proven in-process in tests/probe.test.mjs and are not
// repeated here. What only exists at the process boundary is the part below:
// that scripts actually run and their exit codes decide the record, that a
// probe runs against the tree under review rather than whatever HEAD happens
// to hold, that the worktrees this makes are torn down, that the two gates
// (the operator's `--allow-execute` and the plan's policy) each independently
// refuse, and that the exit code is 0 whatever the probes said — a
// reproduction that failed is a fact about a finding, never a verdict on the
// change.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PROBE = path.join(here, '..', 'skills', 'adverse-review', 'scripts', 'probe.mjs');

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };

// A repository whose committed `value.txt` says `committed`, plus a run
// directory laid out the way Phase 2 lays one out: one subdirectory per agent,
// its payload in it, and any script it wrote beside the payload.
function fixture({ scripts = {}, findings = [], persona = 'auditor', uncommitted = null } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'adverse-probe-bridge-'));
  const repo = path.join(root, 'repo');
  const run = path.join(root, 'run', persona);
  mkdirSync(repo);
  mkdirSync(run, { recursive: true });

  const git = (...args) => execFileSync('git', args, { cwd: repo, env: GIT_ENV, encoding: 'utf-8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  writeFileSync(path.join(repo, 'value.txt'), 'committed\n');
  git('add', '.');
  git('commit', '-qm', 'one');
  if (uncommitted !== null) writeFileSync(path.join(repo, 'value.txt'), uncommitted);

  for (const [rel, body] of Object.entries(scripts)) {
    const at = path.join(run, rel);
    mkdirSync(path.dirname(at), { recursive: true });
    writeFileSync(at, body);
  }

  const payload = path.join(run, `round1-${persona}.json`);
  writeFileSync(payload, JSON.stringify({
    persona, verdict: 'conditional', summary: 's', findings,
  }));

  return { root, repo, run, payload, out: path.join(root, 'probes.json'), git };
}

const finding = (title, probe) => ({
  severity: 'critical', kind: 'behavioral', file: 'value.txt', line: 1,
  counterpart: null, title, detail: 'd', fix: null, probe,
});

const claim = (script, outcome = 'reproduced') =>
  ({ script, expect: 'e', observed: 'o', outcome });

const run = (args, cwd) =>
  spawnSync(process.execPath, [PROBE, ...args], { cwd, encoding: 'utf-8', env: GIT_ENV });

const record = (f) => JSON.parse(readFileSync(f, 'utf-8'));

// ---------- the two gates -----------------------------------------------------

// A probe runs code out of the diff under review. Turning it on takes an
// operator who confirmed in Phase 0 that a worktree here can run anything at
// all, and the flag is how that yes is expressed.
test('without --allow-execute nothing runs, and every probe says so', () => {
  const fx = fixture({
    scripts: { 'probes/F1.sh': 'exit 0\n' },
    findings: [finding('boom', claim('probes/F1.sh'))],
  });
  const r = run(['--round1', fx.payload, '--repo', fx.repo, '--out', fx.out], fx.root);

  assert.equal(r.status, 0);
  const rec = record(fx.out);
  assert.equal(rec.enabled, false);
  assert.equal(rec.probes[0].source, 'declined');
  assert.equal(rec.probes[0].confirmed, false);
  assert.match(rec.probes[0].why, /not enabled for this run/);
});

// The plan's own policy is the other yes, and it refuses independently: an
// operator's flag alone cannot turn probes on for a run the plan planned
// without them.
test('a plan that does not offer probes refuses even with --allow-execute', () => {
  const fx = fixture({
    scripts: { 'probes/F1.sh': 'exit 0\n' },
    findings: [finding('boom', claim('probes/F1.sh'))],
  });
  const plan = path.join(fx.root, 'plan.json');
  writeFileSync(plan, JSON.stringify({
    lanes: [{ persona: 'auditor', run: true, agents: 1 }],
    probes: { allowed: false, perLane: 0, reason: 'a cheap pass' },
  }));

  const r = run(['--round1', fx.payload, '--repo', fx.repo, '--plan', plan,
    '--allow-execute', '--out', fx.out], fx.root);

  assert.equal(r.status, 0);
  const rec = record(fx.out);
  assert.equal(rec.enabled, false);
  assert.equal(rec.probes[0].confirmed, false);
  assert.match(rec.probes[0].why, /does not offer probes/);
});

// The two gates are independent, and this is what proves it rather than
// assuming it: `--max-per-lane` overrides the cap the policy would have set, so
// with that flag the policy check is the only thing left standing between a
// disallowing plan and a running script. Without the check, the mutation is
// silent — the cap coincidentally reads 0 on every other path.
test('an explicit cap does not override the plan\'s refusal', () => {
  const fx = fixture({
    scripts: { 'probes/F1.sh': 'exit 0\n' },
    findings: [finding('boom', claim('probes/F1.sh'))],
  });
  const plan = path.join(fx.root, 'plan.json');
  writeFileSync(plan, JSON.stringify({
    lanes: [{ persona: 'auditor', run: true, agents: 1 }],
    probes: { allowed: false, perLane: 0, reason: 'a cheap pass' },
  }));

  const r = run(['--round1', fx.payload, '--repo', fx.repo, '--plan', plan,
    '--allow-execute', '--max-per-lane', '5', '--out', fx.out], fx.root);

  assert.equal(r.status, 0);
  const rec = record(fx.out);
  assert.equal(rec.enabled, false);
  assert.equal(rec.probes[0].source, 'declined');
  assert.match(rec.probes[0].why, /does not offer probes/);
});

// ---------- whose probes may run ----------------------------------------------

// The roster check triage.mjs makes one phase later, applied here where it
// matters more: there a phantom lane shapes a prompt, here it names a script
// this process is about to SPAWN. A probe from a lane nobody spawned could
// never have attached to a finding anyway — the join is (lane, title), and
// synthesis only looks up lanes that reported — so this refuses code that
// could not have changed the report even if it ran.
test('a payload from a lane that is not a persona has its probe refused, not spawned', () => {
  const fx = fixture({
    persona: 'referee',
    scripts: { 'probes/F1.sh': 'exit 0\n' },
    findings: [finding('boom', claim('probes/F1.sh'))],
  });
  const r = run(['--round1', fx.payload, '--repo', fx.repo, '--allow-execute', '--out', fx.out], fx.root);

  assert.equal(r.status, 0);
  const rec = record(fx.out);
  assert.equal(rec.probes[0].source, 'declined');
  assert.equal(rec.probes[0].ran, null, 'nothing may have been spawned');
  assert.match(rec.probes[0].why, /no lane named "referee" is part of this run/);
});

test('a plan that ruled a lane out refuses that lane\'s probes too', () => {
  const fx = fixture({
    scripts: { 'probes/F1.sh': 'exit 0\n' },
    findings: [finding('boom', claim('probes/F1.sh'))],
  });
  const plan = path.join(fx.root, 'plan.json');
  writeFileSync(plan, JSON.stringify({
    lanes: [{ persona: 'auditor', run: false, agents: 0 },
      { persona: 'steward', run: true, agents: 1 }],
    probes: { allowed: true, perLane: 2, reason: 'ok' },
  }));

  const r = run(['--round1', fx.payload, '--repo', fx.repo, '--plan', plan,
    '--allow-execute', '--out', fx.out], fx.root);

  assert.equal(r.status, 0);
  const rec = record(fx.out);
  assert.equal(rec.probes[0].ran, null);
  assert.match(rec.probes[0].why, /no lane named "auditor" is part of this run/);
});

// ---------- what running one establishes --------------------------------------

test('a script that exits 0 on a claimed reproduction confirms, bound to HEAD', () => {
  const fx = fixture({
    scripts: { 'probes/F1.sh': 'grep -q committed value.txt\n' },
    findings: [finding('boom', claim('probes/F1.sh'))],
  });
  const head = fx.git('rev-parse', 'HEAD').trim();
  const r = run(['--round1', fx.payload, '--repo', fx.repo, '--allow-execute', '--out', fx.out], fx.root);

  assert.equal(r.status, 0);
  const rec = record(fx.out);
  assert.equal(rec.enabled, true);
  assert.equal(rec.head, head);
  assert.equal(rec.probes[0].source, 'measured');
  assert.equal(rec.probes[0].status, 'reproduced');
  assert.equal(rec.probes[0].confirmed, true);
  assert.equal(rec.probes[0].ran.exitCode, 0);
  assert.match(r.stdout, /reproduced under re-run \(buys `demonstrated`\): 1/);
});

// A reproduction that fails to reproduce is the worst news this bridge can
// carry, and it is a fact ABOUT a finding rather than a verdict on the change.
// Under the bridge exit-code contract that is not exit 1.
test('a reproduction that did not reproduce is reported on stderr and still exits 0', () => {
  const fx = fixture({
    scripts: { 'probes/F1.sh': 'exit 3\n' },
    findings: [finding('boom', claim('probes/F1.sh'))],
  });
  const r = run(['--round1', fx.payload, '--repo', fx.repo, '--allow-execute', '--out', fx.out], fx.root);

  assert.equal(r.status, 0);
  const rec = record(fx.out);
  assert.equal(rec.probes[0].status, 'not-reproduced');
  assert.equal(rec.probes[0].confirmed, false);
  assert.equal(rec.probes[0].ran.exitCode, 3);
  assert.match(r.stderr, /boom: the reporter recorded a reproduction/);
  assert.match(r.stdout, /never disproved/);
});

// Phase 0's second scope rule reviews UNCOMMITTED changes, so a worktree
// detached at HEAD alone does not contain the code under review — and a probe
// re-run there would be answering about a tree that never had the behavior.
test('a probe runs against the uncommitted tree, not merely HEAD', () => {
  const fx = fixture({
    uncommitted: 'edited\n',
    scripts: { 'probes/F1.sh': 'grep -q edited value.txt\n' },
    findings: [finding('boom', claim('probes/F1.sh'))],
  });
  const r = run(['--round1', fx.payload, '--repo', fx.repo, '--allow-execute', '--out', fx.out], fx.root);

  assert.equal(r.status, 0);
  const rec = record(fx.out);
  assert.equal(rec.isolation.uncommitted, 'applied');
  assert.equal(rec.probes[0].confirmed, true, 'the probe must see the tree under review');
});

// A reproduction is allowed — expected, even — to mutate the tree it runs in.
// Reusing one worktree would let probe 1's mutations decide probe 2's exit code.
test('each probe gets its own checkout, and one probe\'s mutations do not reach the next', () => {
  const fx = fixture({
    scripts: {
      'probes/F1.sh': 'echo mutated > value.txt\n',
      'probes/F2.sh': 'grep -q committed value.txt\n',
    },
    findings: [
      finding('first', claim('probes/F1.sh')),
      finding('second', claim('probes/F2.sh')),
    ],
  });
  const r = run(['--round1', fx.payload, '--repo', fx.repo, '--allow-execute', '--out', fx.out], fx.root);

  assert.equal(r.status, 0);
  assert.deepEqual(record(fx.out).probes.map((p) => p.confirmed), [true, true]);
});

// SKILL.md Phase 10 exists because `git worktree add` registers state in the
// repository that nothing reaps; one campaign left about sixty stale rows. A
// bridge that makes its own worktrees has to remove its own worktrees.
test('the worktrees it makes are torn down, and the user\'s checkout is untouched', () => {
  const fx = fixture({
    scripts: { 'probes/F1.sh': 'echo mutated > value.txt\n' },
    findings: [finding('boom', claim('probes/F1.sh'))],
  });
  run(['--round1', fx.payload, '--repo', fx.repo, '--allow-execute', '--out', fx.out], fx.root);

  const listed = fx.git('worktree', 'list').trim().split('\n');
  assert.equal(listed.length, 1, `left behind: ${listed.join(' | ')}`);
  assert.equal(readFileSync(path.join(fx.repo, 'value.txt'), 'utf-8'), 'committed\n');
});

test('a probe that hangs is killed by the timeout and settles nothing', () => {
  const fx = fixture({
    scripts: { 'probes/F1.sh': 'sleep 30\n' },
    findings: [finding('boom', claim('probes/F1.sh'))],
  });
  const r = run(['--round1', fx.payload, '--repo', fx.repo, '--allow-execute',
    '--timeout', '300', '--out', fx.out], fx.root);

  assert.equal(r.status, 0);
  const rec = record(fx.out);
  assert.equal(rec.probes[0].status, 'inconclusive');
  assert.equal(rec.probes[0].confirmed, false);
});

// ---------- the cap -----------------------------------------------------------

// Enforced here rather than in the prompt: a cap a reviewer is asked to respect
// is a cap that holds until a reviewer does not. The excess is recorded as
// unrun, which costs those findings nothing and keeps every one of them.
test('probes past the lane\'s cap are recorded unrun, and the findings survive', () => {
  const fx = fixture({
    scripts: { 'probes/F1.sh': 'exit 0\n', 'probes/F2.sh': 'exit 0\n', 'probes/F3.sh': 'exit 0\n' },
    findings: [
      finding('one', claim('probes/F1.sh')),
      finding('two', claim('probes/F2.sh')),
      finding('three', claim('probes/F3.sh')),
    ],
  });
  const r = run(['--round1', fx.payload, '--repo', fx.repo, '--allow-execute',
    '--max-per-lane', '2', '--out', fx.out], fx.root);

  const rec = record(fx.out);
  assert.equal(rec.probes.length, 3);
  assert.deepEqual(rec.probes.map((p) => p.confirmed), [true, true, false]);
  assert.match(rec.probes[2].why, /attached more than 2 probe\(s\)/);
  assert.equal(r.status, 0);
});

// ---------- what it will not run ----------------------------------------------

test('a script naming a path outside the reporter\'s directory is declined, not run', () => {
  const fx = fixture({ findings: [finding('boom', claim('../../../etc/hosts.sh'))] });
  const r = run(['--round1', fx.payload, '--repo', fx.repo, '--allow-execute', '--out', fx.out], fx.root);

  assert.equal(r.status, 0);
  assert.match(record(fx.out).probes[0].why, /escapes the reporter's own directory/);
});

test('a finding with no probe contributes nothing to the record', () => {
  const fx = fixture({ findings: [finding('boom', null), finding('quiet', undefined)] });
  const r = run(['--round1', fx.payload, '--repo', fx.repo, '--allow-execute', '--out', fx.out], fx.root);

  assert.equal(r.status, 0);
  const rec = record(fx.out);
  assert.deepEqual(rec.probes, []);
  assert.equal(rec.enabled, true, 'the operator said yes; there was simply nothing to run');
});

// ---------- what the record says about itself ---------------------------------

// The record reports what was APPLIED, never what was intended. Node cannot
// unshare a network namespace, and a tool that printed "no network" without one
// would be making the same unmeasured promise src/gate.mjs refuses.
test('the record says the network was inherited when no sandbox was supplied', () => {
  const fx = fixture({
    scripts: { 'probes/F1.sh': 'exit 0\n' },
    findings: [finding('boom', claim('probes/F1.sh'))],
  });
  run(['--round1', fx.payload, '--repo', fx.repo, '--allow-execute', '--out', fx.out], fx.root);

  const { isolation } = record(fx.out);
  assert.equal(isolation.sandbox, null);
  assert.equal(isolation.network, 'inherited');
  assert.match(isolation.worktree, /one per probe/);
});

test('an operator-supplied sandbox is applied and recorded', () => {
  const fx = fixture({
    scripts: { 'probes/F1.sh': 'exit 0\n' },
    findings: [finding('boom', claim('probes/F1.sh'))],
  });
  // `env -u NOPE` is a portable stand-in for a containment wrapper: it is a
  // real prefix that execs what follows it, so a run that confirms proves the
  // prefix was applied rather than dropped.
  run(['--round1', fx.payload, '--repo', fx.repo, '--allow-execute',
    '--sandbox', 'env -u NOPE', '--out', fx.out], fx.root);

  const rec = record(fx.out);
  assert.equal(rec.isolation.sandbox, 'env -u NOPE');
  assert.equal(rec.isolation.network, 'delegated to the sandbox');
  assert.equal(rec.probes[0].confirmed, true);
});

// ---------- argv and the exit-code contract -----------------------------------

test('missing required arguments is a usage error', () => {
  const fx = fixture();
  for (const args of [[], ['--repo', fx.repo], ['--round1', fx.payload, '--repo', fx.repo]]) {
    assert.equal(run(args, fx.root).status, 2);
  }
});

test('an unreadable payload is exit 2 — this run never read an input', () => {
  const fx = fixture();
  const r = run(['--round1', path.join(fx.root, 'gone.json'), '--repo', fx.repo,
    '--out', fx.out], fx.root);
  assert.equal(r.status, 2);
});

test('a repo whose HEAD cannot be resolved refuses rather than writing an unbound record', () => {
  const fx = fixture();
  const bare = mkdtempSync(path.join(os.tmpdir(), 'adverse-probe-norepo-'));
  const r = run(['--round1', fx.payload, '--repo', bare, '--out', fx.out], fx.root);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /cannot resolve HEAD/);
});

test('a non-numeric timeout or cap is a usage error, not a silent default', () => {
  const fx = fixture();
  for (const args of [['--timeout', 'soon'], ['--timeout', '0'], ['--max-per-lane', '-1']]) {
    const r = run(['--round1', fx.payload, '--repo', fx.repo, ...args, '--out', fx.out], fx.root);
    assert.equal(r.status, 2, args.join(' '));
  }
});

// The shell expands `--round1 run/*/round1-*.json`, and with strict parsing the
// second and later paths arrive as positionals. Same accommodation triage.mjs
// and combine.mjs make.
test('shell-expanded payload paths arrive as positionals and are still read', () => {
  const fx = fixture({
    scripts: { 'probes/F1.sh': 'exit 0\n' },
    findings: [finding('boom', claim('probes/F1.sh'))],
  });
  const r = run([fx.payload, '--repo', fx.repo, '--allow-execute', '--out', fx.out], fx.root);
  assert.equal(r.status, 0);
  assert.equal(record(fx.out).probes.length, 1);
});
