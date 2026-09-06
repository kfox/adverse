// Tests for src/triage.mjs — claim-checking, kind-anchoring, and clustering,
// exercised directly rather than through a subprocess. `checkKind`,
// `clusterFindings`, and `crossReferenceFindings` are pure over plain finding
// objects and need no repo at all; `makeClaimChecker` needs a real git repo
// because its answers come from `git diff`, so it gets one small fixture
// shared by that section only.
//
// The bridge's own contract (argument parsing, persona validation, ledger
// wiring, the output file) is covered separately in
// tests/triage-bridge.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  MAX_CONFIRMABLE_MEMBERS, checkKind, clusterFindings, crossReferenceFindings, groupFindings,
  makeClaimChecker,
} from '../src/triage.mjs';

// --- checkKind ---------------------------------------------------------------

test('checkKind: a defect naming a file and a line passes', () => {
  assert.equal(checkKind('defect', 'a.py', 10, null).status, 'ok');
});

test('checkKind: a defect with no line is under-anchored', () => {
  const kc = checkKind('defect', 'a.py', null, null);
  assert.equal(kc.status, 'UNDER-ANCHORED');
  assert.deepEqual(kc.missing, ['line']);
});

test('checkKind: a contract with no counterpart is under-anchored', () => {
  const kc = checkKind('contract', 'a.py', null, null);
  assert.deepEqual(kc.missing, ['counterpart']);
});

test('checkKind: a contract naming both paths passes', () => {
  assert.equal(checkKind('contract', 'a.py', null, 'b.py').status, 'ok');
});

test('checkKind: design needs no anchor', () => {
  assert.equal(checkKind('design', null, null, null).status, 'ok');
});

test('checkKind: a missing kind is reported, not silently accepted', () => {
  assert.equal(checkKind(undefined, 'a.py', 1, null).status, 'MISSING');
  assert.equal(checkKind(null, 'a.py', 1, null).status, 'MISSING');
  assert.equal(checkKind('', 'a.py', 1, null).status, 'MISSING');
});

test('checkKind: an unrecognized kind is reported as unknown', () => {
  const kc = checkKind('vibes', 'a.py', 1, null);
  assert.equal(kc.status, 'UNKNOWN');
  assert.equal(kc.kind, 'vibes');
});

test('checkKind: advisory is read from the injected set, not hardcoded', () => {
  const advisoryKinds = new Set(['design']);
  assert.equal(checkKind('design', null, null, null, { advisoryKinds }).advisory, true);
  assert.equal(checkKind('defect', 'a.py', 1, null, { advisoryKinds }).advisory, false);
});

test('checkKind: with no advisoryKinds injected, advisory is left undefined rather than guessed', () => {
  assert.equal(checkKind('design', null, null, null).advisory, undefined);
});

// --- clusterFindings ----------------------------------------------------------

const f = (over = {}) => ({ id: 'F?', reporter: 'auditor', file: 'a.py', line: 10, title: 't', ...over });

test('clusterFindings: two reporters near the same line cluster', () => {
  const clusters = clusterFindings([
    f({ id: 'F1', reporter: 'auditor', line: 20 }),
    f({ id: 'F2', reporter: 'adversary', line: 25 }),
  ]);
  assert.equal(clusters.length, 1);
  assert.deepEqual(clusters[0].ids, ['F1', 'F2']);
});

test('clusterFindings: one reporter twice is not consensus', () => {
  const clusters = clusterFindings([
    f({ id: 'F1', reporter: 'auditor', line: 20 }),
    f({ id: 'F2', reporter: 'auditor', line: 25 }),
  ]);
  assert.equal(clusters.length, 0);
});

test('clusterFindings: findings far apart in the same file do not cluster', () => {
  const clusters = clusterFindings([
    f({ id: 'F1', reporter: 'auditor', line: 2 }),
    f({ id: 'F2', reporter: 'adversary', line: 38 }),
  ]);
  assert.equal(clusters.length, 0);
});

test('clusterFindings: findings in different files never cluster', () => {
  const clusters = clusterFindings([
    f({ id: 'F1', reporter: 'auditor', file: 'a.py', line: 20 }),
    f({ id: 'F2', reporter: 'adversary', file: 'b.py', line: 20 }),
  ]);
  assert.equal(clusters.length, 0);
});

test('clusterFindings: windowLines is configurable', () => {
  const findings = [
    f({ id: 'F1', reporter: 'auditor', line: 10 }),
    f({ id: 'F2', reporter: 'adversary', line: 30 }),
  ];
  assert.equal(clusterFindings(findings).length, 0, 'default window (15) is too narrow');
  assert.equal(clusterFindings(findings, { windowLines: 25 }).length, 1);
});

// --- crossReferenceFindings ----------------------------------------------------

test('crossReferenceFindings: one finding citing another reporter\'s file is a cross-reference', () => {
  const findings = [
    f({ id: 'F1', reporter: 'auditor', file: 'app.py', line: 20 }),
    f({ id: 'F2', reporter: 'steward', file: 'docs/app.md', line: 1,
        detail: 'app.py line 20 disagrees with this' }),
  ];
  const xref = crossReferenceFindings(findings).find((x) => x.from === 'F2' && x.to === 'F1');
  assert.ok(xref, 'expected F2 -> F1 co-citation');
  assert.equal(xref.lineEchoed, true);
});

test('crossReferenceFindings: a reviewer citing its own file is not a cross-reference', () => {
  const findings = [
    f({ id: 'F1', reporter: 'auditor', file: 'app.py' }),
    f({ id: 'F2', reporter: 'auditor', file: 'app.py', detail: 'see app.py' }),
  ];
  assert.equal(crossReferenceFindings(findings).length, 0);
});

// --- groupFindings ------------------------------------------------------------

const ADVISORY = new Set(['design']);

// Two clusters sharing a finding, plus a co-citation reaching a third file:
// the transitive shape that left three findings to remediate separately.
const chained = () => {
  const findings = [
    f({ id: 'F1', reporter: 'auditor', file: 'a.py', line: 10, severity: 'warning', kind: 'defect',
        title: 'guard is unreachable' }),
    f({ id: 'F2', reporter: 'adversary', file: 'a.py', line: 14, severity: 'critical', kind: 'defect',
        title: 'the unreachable guard is an auth bypass' }),
    f({ id: 'F3', reporter: 'steward', file: 'docs/a.md', line: 3, severity: 'info', kind: 'contract',
        title: 'docs still promise the guard', detail: 'a.py line 10 no longer does this' }),
  ];
  return {
    findings,
    clusters: clusterFindings(findings),
    crossReferences: crossReferenceFindings(findings),
  };
};

test('groupFindings: a cluster and a co-citation chain into one root cause', () => {
  const { findings, clusters, crossReferences } = chained();
  const groups = groupFindings(findings, { clusters, crossReferences, advisoryKinds: ADVISORY });
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].members, ['F1', 'F2', 'F3']);
  assert.deepEqual(groups[0].via, ['cluster', 'co-citation']);
});

test('groupFindings: the canonical statement is the worst-severity member', () => {
  const { findings, clusters, crossReferences } = chained();
  const [g] = groupFindings(findings, { clusters, crossReferences, advisoryKinds: ADVISORY });
  assert.equal(g.title, 'the unreachable guard is an auth bypass');
  assert.equal(g.severity, 'critical');
});

test('groupFindings: an advisory member never becomes the canonical statement', () => {
  const findings = [
    f({ id: 'F1', reporter: 'pragmatist', line: 10, severity: 'warning', kind: 'design', title: 'this module is doing too much' }),
    f({ id: 'F2', reporter: 'auditor', line: 12, severity: 'warning', kind: 'defect', title: 'off-by-one in the bounds check' }),
  ];
  const [g] = groupFindings(findings, { clusters: clusterFindings(findings), advisoryKinds: ADVISORY });
  assert.equal(g.title, 'off-by-one in the bounds check');
});

test('groupFindings: every member rides along as a citation with its own anchor', () => {
  const { findings, clusters, crossReferences } = chained();
  const [g] = groupFindings(findings, { clusters, crossReferences, advisoryKinds: ADVISORY });
  assert.deepEqual(g.citations.map((c) => [c.id, c.reporter, c.kind, c.severity, c.file, c.line]), [
    ['F1', 'auditor', 'defect', 'warning', 'a.py', 10],
    ['F2', 'adversary', 'defect', 'critical', 'a.py', 14],
    ['F3', 'steward', 'contract', 'info', 'docs/a.md', 3],
  ]);
  assert.deepEqual(g.files, ['a.py', 'docs/a.md']);
  assert.deepEqual(g.kinds, ['defect', 'contract']);
});

test('groupFindings: reporters are distinct personas, so one lane cannot sound like three', () => {
  // Three findings, two reporters: the auditor reported the same region twice.
  const findings = [
    f({ id: 'F1', reporter: 'auditor', line: 10 }),
    f({ id: 'F2', reporter: 'auditor', line: 12 }),
    f({ id: 'F3', reporter: 'steward', line: 14 }),
  ];
  const [g] = groupFindings(findings, { clusters: clusterFindings(findings) });
  assert.equal(g.members.length, 3);
  assert.deepEqual(g.reporters, ['auditor', 'steward']);
});

test('groupFindings: a lone finding is not a group', () => {
  const findings = [f({ id: 'F1', reporter: 'auditor', line: 10 })];
  assert.deepEqual(groupFindings(findings, { clusters: [], crossReferences: [] }), []);
});

test('groupFindings: no edges means no groups, however many findings', () => {
  const findings = [
    f({ id: 'F1', reporter: 'auditor', file: 'a.py', line: 10 }),
    f({ id: 'F2', reporter: 'steward', file: 'b.py', line: 900 }),
  ];
  assert.deepEqual(groupFindings(findings, { clusters: [], crossReferences: [] }), []);
});

test('groupFindings: an edge naming an unknown id is ignored, not crashed on', () => {
  const findings = [f({ id: 'F1', reporter: 'auditor' }), f({ id: 'F2', reporter: 'steward' })];
  const groups = groupFindings(findings, { crossReferences: [{ from: 'F9', to: 'F1' }] });
  assert.deepEqual(groups, []);
});

test('groupFindings: a component past MAX_CONFIRMABLE_MEMBERS is reported but marked oversized', () => {
  // A chain of co-citations, alternating reporters, one longer than the cap.
  const n = MAX_CONFIRMABLE_MEMBERS + 1;
  const findings = Array.from({ length: n }, (_, i) =>
    f({ id: `F${i + 1}`, reporter: i % 2 ? 'steward' : 'auditor', file: `f${i}.py`, line: i }));
  const crossReferences = findings.slice(1).map((x, i) => ({ from: x.id, to: findings[i].id }));
  const [g] = groupFindings(findings, { crossReferences });
  assert.equal(g.members.length, n);
  assert.equal(g.oversized, true);
});

test('groupFindings: a component at the cap is not oversized', () => {
  const n = MAX_CONFIRMABLE_MEMBERS;
  const findings = Array.from({ length: n }, (_, i) =>
    f({ id: `F${i + 1}`, reporter: i % 2 ? 'steward' : 'auditor', file: `f${i}.py`, line: i }));
  const crossReferences = findings.slice(1).map((x, i) => ({ from: x.id, to: findings[i].id }));
  const [g] = groupFindings(findings, { crossReferences });
  assert.equal(g.oversized, false);
});

// --- makeClaimChecker ---------------------------------------------------------
// Needs a real repo: changedRanges shells out to `git diff`.

function git(cwd, ...args) {
  execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: 'pipe' });
}

function makeRepo() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'adverse-triage-lib-'));
  git(dir, 'init', '-q', '-b', 'base');
  git(dir, 'config', 'user.email', 'test@example.invalid');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  writeFileSync(path.join(dir, 'a.py'), Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n') + '\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'base');

  git(dir, 'checkout', '-q', '-b', 'work');
  const lines = readFileSync(path.join(dir, 'a.py'), 'utf-8').split('\n');
  lines[19] = 'line 20 CHANGED';
  writeFileSync(path.join(dir, 'a.py'), lines.join('\n'));
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'work');
  return dir;
}

let repo;
let checker;
test.before(() => {
  repo = makeRepo();
  checker = makeClaimChecker({ repo, base: 'base' });
});
test.after(() => rmSync(repo, { recursive: true, force: true }));

test('checkClaim: a line inside the diff is marked inside, with its text captured', () => {
  const c = checker.checkClaim('a.py', 20);
  assert.equal(c.status, 'ok');
  assert.equal(c.inDiff, 'inside');
  assert.equal(c.citedLine, 'line 20 CHANGED');
});

test('checkClaim: a line outside the diff is annotated, never disproved', () => {
  const c = checker.checkClaim('a.py', 3);
  assert.equal(c.status, 'ok');
  assert.equal(c.inDiff, 'outside');
  assert.match(c.note, /legitimate/);
});

test('checkClaim: a missing file is disproved', () => {
  assert.equal(checker.checkClaim('nope.py', 1).status, 'DISPROVED');
});

test('checkClaim: a line past EOF is disproved', () => {
  assert.equal(checker.checkClaim('a.py', 9999).status, 'DISPROVED');
});

test('checkClaim: a path escaping the checkout is disproved, not read', () => {
  const outside = mkdtempSync(path.join(os.tmpdir(), 'adverse-triage-lib-escape-'));
  const secret = path.join(outside, 'secret.txt');
  writeFileSync(secret, 'SENTINEL-DO-NOT-EXFILTRATE\n', 'utf-8');
  try {
    const rel = path.relative(repo, secret);
    const c = checker.checkClaim(rel, 1);
    assert.equal(c.status, 'DISPROVED');
    assert.match(c.why, /escapes the checkout/);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test('checkClaim: an in-tree symlink pointing out of the tree is disproved, not followed', () => {
  const outside = mkdtempSync(path.join(os.tmpdir(), 'adverse-triage-lib-outside-'));
  const secret = path.join(outside, 'id_rsa');
  writeFileSync(secret, 'SSH-SENTINEL-DO-NOT-EXFILTRATE\n', 'utf-8');
  const link = path.join(repo, 'lib_link.py');
  try {
    symlinkSync(secret, link);
  } catch {
    rmSync(outside, { recursive: true, force: true });
    return; // no symlink support on this platform; nothing to assert
  }
  try {
    const c = checker.checkClaim('lib_link.py', 1);
    assert.equal(c.status, 'DISPROVED');
  } finally {
    unlinkSync(link);
    rmSync(outside, { recursive: true, force: true });
  }
});

test('checkCounterpart: an existing file passes', () => {
  assert.equal(checker.checkCounterpart('a.py').status, 'ok');
});

test('checkCounterpart: a missing file is disproved', () => {
  assert.equal(checker.checkCounterpart('nope.py').status, 'DISPROVED');
});

test('checkCounterpart: null is not a claim at all', () => {
  assert.equal(checker.checkCounterpart(null), null);
});
