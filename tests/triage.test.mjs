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
  CLUSTER_WINDOW_LINES, MAX_CO_CITATIONS_PER_FINDING, MAX_CONFIRMABLE_MEMBERS, checkKind, clusterFindings,
  crossReferenceFindings, groupFindings,
  makeClaimChecker, normalizeAnchor,
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

test('checkKind: advisory defaults to the real registry, and stays a boolean', () => {
  // This used to be left `undefined` when nothing was injected, so `advisory`
  // was a boolean or absent depending on the caller — and the one consumer
  // filters on `=== true`. The option is kept for a caller that genuinely has
  // a different set; its default is the registry rather than a hole.
  assert.equal(checkKind('design', null, null, null).advisory, true);
  assert.equal(checkKind('defect', 'a.py', 1, null).advisory, false);
  // An explicit set still wins over the default.
  assert.equal(checkKind('defect', 'a.py', 1, null, { advisoryKinds: new Set(['defect']) }).advisory, true);
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
        counterpart: 'a.py',
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
  // A `contract` citation without its counterpart is a decision that can never
  // match again — half the finding's identity, dropped on the way to the ledger.
  assert.equal(g.citations[2].counterpart, 'a.py');
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

test('groupFindings: a proximity pile-up cannot merge past the cap either', () => {
  // Cluster edges were exempt from the size bound, on the premise that a
  // cluster is "already bounded evidence". It is not: one reviewer filing a
  // ladder of nits in a hot file bridged every other lane's findings into a
  // single component, and `anchorMember` handed the attacker the title for
  // free by sorting worst-severity first.
  const n = MAX_CONFIRMABLE_MEMBERS + 1;
  const findings = Array.from({ length: n }, (_, i) =>
    f({ id: `F${i + 1}`, reporter: i % 2 ? 'steward' : 'auditor', file: 'one.py', line: i }));
  const clusters = [{ file: 'one.py', ids: findings.map((x) => x.id) }];

  for (const g of groupFindings(findings, { clusters })) {
    assert.ok(g.members.length <= MAX_CONFIRMABLE_MEMBERS,
      `cluster edges must not build a ${g.members.length}-member component`);
  }
});

test('clusterFindings: a run cannot chain past the window it is named for', () => {
  // The run grew by comparing each finding to its PREDECESSOR, so ten findings
  // six lines apart spanned sixty — "within CLUSTER_WINDOW_LINES" was true of
  // every adjacent pair and false of the cluster.
  const step = Math.floor(CLUSTER_WINDOW_LINES / 2);
  const findings = Array.from({ length: 8 }, (_, i) =>
    f({ id: `F${i + 1}`, reporter: i % 2 ? 'steward' : 'auditor', file: 'a.py', line: 100 + i * step }));

  for (const c of clusterFindings(findings)) {
    const lines = c.ids.map((id) => findings.find((x) => x.id === id).line);
    assert.ok(Math.max(...lines) - Math.min(...lines) <= CLUSTER_WINDOW_LINES,
      `cluster spans ${Math.max(...lines) - Math.min(...lines)} lines, window is ${CLUSTER_WINDOW_LINES}`);
  }
});

test('groupFindings: an unknown id in the MIDDLE of a cluster does not split it', () => {
  // Chaining fixed the unknown-FIRST-id case and left this one: `merge` does
  // nothing when either id is absent, so an unknown id partway along broke the
  // chain and produced two groups where the run was one.
  const findings = [
    f({ id: 'F1', reporter: 'auditor', file: 'a.py', line: 1 }),
    f({ id: 'F2', reporter: 'steward', file: 'a.py', line: 2 }),
    f({ id: 'F3', reporter: 'adversary', file: 'a.py', line: 3 }),
  ];
  const clusters = [{ file: 'a.py', ids: ['F1', 'GHOST', 'F2', 'F3'] }];
  const groups = groupFindings(findings, { clusters });
  assert.equal(groups.length, 1, 'one unknown id must not split a real cluster');
  assert.deepEqual(groups[0].members.sort(), ['F1', 'F2', 'F3']);
});

test('groupFindings: a co-citation chain cannot grow a component past the cap', () => {
  // The cap used to be applied AFTER the closure had run, so a chain of weak
  // edges swallowed the review and `oversized` merely labelled the result. On
  // the run that filed the issue that was 34 findings in one 29-member "root
  // cause" across 10 files and all four lanes.
  const n = MAX_CONFIRMABLE_MEMBERS * 3;
  const findings = Array.from({ length: n }, (_, i) =>
    f({ id: `F${i + 1}`, reporter: i % 2 ? 'steward' : 'auditor', file: `f${i}.py`, line: i }));
  const crossReferences = findings.slice(1).map((x, i) => ({ from: x.id, to: findings[i].id }));
  const groups = groupFindings(findings, { crossReferences });

  for (const g of groups) {
    assert.ok(g.members.length <= MAX_CONFIRMABLE_MEMBERS,
      `co-citation must not build a ${g.members.length}-member component`);
    assert.equal(g.oversized, false);
  }
  // And nothing is lost: a refused edge leaves its findings individually
  // decidable, which is the pre-grouping behaviour and the safe state.
  assert.ok(groups.length > 1, 'the chain should break into several small groups');
});

test('groupFindings: an unknown first cluster id no longer discards the whole cluster', () => {
  // Edges were star-unioned from `ids[0]`, and `union` returns early when
  // either id is absent — so one unknown first id silently dropped EVERY edge
  // in the cluster, and a dropped cluster looks exactly like one never
  // proposed.
  const findings = [
    f({ id: 'F1', reporter: 'auditor', file: 'a.py', line: 1 }),
    f({ id: 'F2', reporter: 'steward', file: 'a.py', line: 2 }),
  ];
  const clusters = [{ file: 'a.py', ids: ['GHOST', 'F1', 'F2'] }];
  const [g] = groupFindings(findings, { clusters });
  assert.ok(g, 'the real members must still group');
  assert.deepEqual(g.members.sort(), ['F1', 'F2']);
});


test('groupFindings: a component at the cap is not oversized in a big enough review', () => {
  const n = MAX_CONFIRMABLE_MEMBERS;
  const findings = Array.from({ length: n }, (_, i) =>
    f({ id: `F${i + 1}`, reporter: i % 2 ? 'steward' : 'auditor', file: `f${i}.py`, line: i }));
  // Enough unrelated findings that a group of `n` is not most of the review.
  const filler = Array.from({ length: n }, (_, i) =>
    f({ id: `X${i + 1}`, reporter: 'pragmatist', file: `x${i}.py`, line: i }));
  const crossReferences = findings.slice(1).map((x, i) => ({ from: x.id, to: findings[i].id }));
  const [g] = groupFindings([...findings, ...filler], { crossReferences });
  assert.equal(g.members.length, n);
  assert.equal(g.oversized, false);
});

test('groupFindings: the cap is relative too — most of a small review cannot collapse', () => {
  // MAX_CONFIRMABLE_MEMBERS is absolute, and the invariant it is written for is
  // not: 8 of 34 findings honours "one ruling must not collapse most of a
  // review", and 7 of 10 does not — that is 70% under a single disposition.
  const findings = Array.from({ length: 10 }, (_, i) =>
    f({ id: `F${i + 1}`, reporter: i % 2 ? 'steward' : 'auditor', file: `f${i}.py`, line: i }));
  const seven = findings.slice(0, 7);
  const clusters = [{ file: 'f0.py', ids: seven.map((x) => x.id) }];
  const [g] = groupFindings(findings, { clusters });

  assert.equal(g.members.length, 7, 'still reported in full');
  assert.equal(g.oversized, true, 'but not confirmable as one disposition');
  assert.ok(7 <= MAX_CONFIRMABLE_MEMBERS, 'and the absolute cap alone would have allowed it');
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

// `.git` is inside the checkout, so every containment check admits it — and
// `actions/checkout` writes the job token into `.git/config` as an
// `http.<host>.extraheader` line. checkClaim copies the cited line into
// `citedLine`, which triage writes into briefing.json, which IS the round-2
// prompt: one citation hands the token to every later reviewer. The sentinel
// stands in for that token, and the assertion is that it is never read.
const GIT_CONFIG_SENTINEL = 'AUTHORIZATION: basic TOKEN-SENTINEL-DO-NOT-EXFILTRATE';

test('checkClaim: a path under .git/ is disproved, so its credentials are never read', () => {
  git(repo, 'config', 'http.https://github.com/.extraheader', GIT_CONFIG_SENTINEL);
  const c = checker.checkClaim('.git/config', 1);
  assert.equal(c.status, 'DISPROVED');
  assert.match(c.why, /repository metadata/);
  assert.equal(c.citedLine, undefined);
});

test('checkClaim: .git is refused through a symlink and through traversal, not just by name', () => {
  const link = path.join(repo, 'gitlink');
  try {
    symlinkSync(path.join(repo, '.git'), link);
  } catch {
    return; // no symlink support on this platform
  }
  try {
    for (const cite of ['gitlink/config', './.git/config', '.git/../.git/config']) {
      const c = checker.checkClaim(cite, 1);
      assert.equal(c.status, 'DISPROVED', cite);
      assert.equal(c.citedLine, undefined, cite);
    }
  } finally {
    unlinkSync(link);
  }
});

test('checkCounterpart: a path under .git/ is refused too, not only the primary anchor', () => {
  const c = checker.checkCounterpart('.git/config');
  assert.equal(c.status, 'DISPROVED');
  assert.match(c.why, /repository metadata/);
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

// --- untrusted anchor types --------------------------------------------------
//
// A reviewer payload is LLM output. Every case below is a value a model can
// produce by accident or on purpose, and each one used to crash the bridge,
// hang it, or come back `status: 'ok'` — a mechanically-verified anchor minted
// out of a value nothing checked.

test('normalizeAnchor: a non-integer line is rejected, and says so', () => {
  for (const line of ['.*', '(20', 0, -5, 4.5, true, null]) {
    const a = normalizeAnchor({ line, detail: 'd' });
    assert.equal(a.line, null, `line ${JSON.stringify(line)} must not survive`);
  }
  assert.deepEqual(normalizeAnchor({ line: '.*', detail: 'd' }).rejected, ['line']);
  // A line that was never supplied is not a rejection — the two must stay
  // distinguishable, which is the entire reason `rejected` exists.
  assert.deepEqual(normalizeAnchor({ line: null, detail: 'd' }).rejected, []);
  assert.equal(normalizeAnchor({ line: 12, detail: 'd' }).line, 12);
});

test('normalizeAnchor: non-string file, counterpart and detail are rejected', () => {
  const a = normalizeAnchor({ file: 42, counterpart: ['x'], detail: { s: 1 } });
  assert.equal(a.file, null);
  assert.equal(a.counterpart, null);
  assert.equal(a.detail, '');
  assert.deepEqual(a.rejected.sort(), ['counterpart', 'detail', 'file']);
});

test('checkKind: line 0 does not satisfy a defect\'s line requirement', () => {
  // `0` is neither null nor undefined, so the old presence test called this
  // fully anchored and blocking.
  const k = checkKind('defect', 'a.py', 0, null, { advisoryKinds: new Set(['design']) });
  assert.equal(k.status, 'UNDER-ANCHORED');
  assert.deepEqual(k.missing, ['line']);
});

test('crossReferenceFindings: a regex-shaped line neither throws nor hangs', () => {
  // `new RegExp(`\\b${b.line}\\b`)` threw SyntaxError on the first and
  // backtracked forever on the second, aborting triage before briefing.json.
  for (const line of ['(20', '([a-z]+)+~']) {
    const findings = [
      { id: 'F1', reporter: 'auditor', file: 'a.py', line: 10, detail: 'see b.py line 20' },
      { id: 'F2', reporter: 'adversary', file: 'b.py', line, detail: 'unrelated' },
    ];
    const started = Date.now();
    const edges = crossReferenceFindings(findings);
    assert.ok(Date.now() - started < 2000, 'must not backtrack');
    assert.equal(edges.length, 1);
    assert.equal(edges[0].lineEchoed, false, 'a malformed line cannot be echoed');
  }
});

test('crossReferenceFindings: a non-string detail is skipped, not thrown on', () => {
  const findings = [
    { id: 'F1', reporter: 'auditor', file: 'a.py', line: 1, detail: { not: 'a string' } },
    { id: 'F2', reporter: 'adversary', file: 'b.py', line: 2, detail: 'names a.py' },
  ];
  assert.equal(crossReferenceFindings(findings).length, 1);
});

test('checkClaim: a non-integer line is DISPROVED, never a forged ok', () => {
  for (const line of ['.*', 0, -5, 4.5]) {
    const c = checker.checkClaim('a.py', line);
    assert.equal(c.status, 'DISPROVED', `line ${JSON.stringify(line)} must not pass`);
  }
});

test('checkClaim: a non-string file is DISPROVED, not an uncaught TypeError', () => {
  // `path.resolve(repo, 42)` throws ERR_INVALID_ARG_TYPE; the `if (!file)`
  // guard only rejected falsy values, so every truthy non-string got through.
  for (const file of [42, true, ['a.py'], { p: 'a.py' }]) {
    const c = checker.checkClaim(file, 1);
    assert.equal(c.status, 'DISPROVED', `file ${JSON.stringify(file)} must not pass`);
  }
});

// --- co-citation bounds -------------------------------------------------------
//
// This function was named, documented, and reported to the operator as
// "cross-file", and was none of the three bounds that phrase implies. On the
// run that filed the issue it produced 95 edges over 34 findings whose
// transitive closure was a single 29-member component spanning 10 files and
// all four lanes.

const co = (id, reporter, file, line, detail) => ({ id, reporter, file, line, detail });

test('crossReferenceFindings: same-file prose is not a citation unless the line is echoed', () => {
  // Reviewers routinely write their own path in their own detail, so this
  // turned every pair of findings in one file into an edge — 900 lines apart,
  // bypassing CLUSTER_WINDOW_LINES entirely.
  const bare = crossReferenceFindings([
    co('F1', 'auditor', 'a.mjs', 10, 'the bug in a.mjs is here'),
    co('F2', 'adversary', 'a.mjs', 900, 'unrelated'),
  ]);
  assert.equal(bare.length, 0, 'naming your own file is not a citation');

  const echoed = crossReferenceFindings([
    co('F1', 'auditor', 'a.mjs', 10, 'this is the same defect as a.mjs line 900'),
    co('F2', 'adversary', 'a.mjs', 900, 'unrelated'),
  ]);
  assert.equal(echoed.length, 1, 'echoing the other finding\'s line IS a citation');
  assert.equal(echoed[0].lineEchoed, true);
});

test('crossReferenceFindings: a path must match as a whole token', () => {
  // A bare substring match made every finding in a directory a citation of
  // every finding whose filename was a suffix of another.
  assert.equal(crossReferenceFindings([
    co('F1', 'auditor', 'x.mjs', 1, 'the problem is in src/a.mjs'),
    co('F2', 'adversary', 'a.mjs', 2, 'unrelated'),
  ]).length, 0, 'src/a.mjs must not cite a different file called a.mjs');

  assert.equal(crossReferenceFindings([
    co('F1', 'auditor', 'x.mjs', 1, 'the problem is in a.mjsx'),
    co('F2', 'adversary', 'a.mjs', 2, 'unrelated'),
  ]).length, 0, 'a.mjsx must not cite a.mjs');

  // Ordinary prose still cites: trailing punctuation and backticks delimit.
  for (const detail of ['see a.mjs.', 'see `a.mjs`', 'see a.mjs and stop', 'a.mjs starts it']) {
    assert.equal(crossReferenceFindings([
      co('F1', 'auditor', 'x.mjs', 1, detail),
      co('F2', 'adversary', 'a.mjs', 2, 'unrelated'),
    ]).length, 1, `"${detail}" should cite a.mjs`);
  }
});

test('crossReferenceFindings: one finding cannot fan out across the whole panel', () => {
  // The attack the Adversary ran: one low-severity payload whose detail merely
  // name-drops several paths pulls every other lane's finding into one group.
  const targets = Array.from({ length: 10 }, (_, i) =>
    co(`F${i + 2}`, 'adversary', `t${i}.mjs`, i + 1, 'unrelated'));
  const namesThemAll = co('F1', 'pragmatist', 'p.mjs', 1,
    targets.map((t) => t.file).join(' and '));

  const edges = crossReferenceFindings([namesThemAll, ...targets]);
  const outDegree = edges.filter((e) => e.from === 'F1').length;
  assert.equal(outDegree, MAX_CO_CITATIONS_PER_FINDING);
  assert.ok(outDegree < targets.length, 'the cap must actually bind');
});

test('crossReferenceFindings: the cap keeps line-echoed edges over name-drops', () => {
  // Which three survive is not arbitrary: an edge echoing the target's line is
  // a far stronger claim of "I mean that finding" than one naming a path.
  const weak = Array.from({ length: 5 }, (_, i) =>
    co(`W${i}`, 'adversary', `w${i}.mjs`, 100 + i, 'unrelated'));
  const strong = co('S1', 'adversary', 'strong.mjs', 4242, 'unrelated');
  const source = co('F1', 'auditor', 'f.mjs', 1,
    `${weak.map((w) => w.file).join(' ')} and strong.mjs line 4242`);

  const kept = crossReferenceFindings([source, ...weak, strong]).filter((e) => e.from === 'F1');
  assert.equal(kept.length, MAX_CO_CITATIONS_PER_FINDING);
  assert.ok(kept.some((e) => e.to === 'S1' && e.lineEchoed), 'the line-echoed edge must survive');
});

// --- co-citation: what may be a citation target -------------------------------

test('crossReferenceFindings: a DISPROVED anchor cannot be a citation target', () => {
  // Nothing constrained the SHAPE of `file`, so a finding citing an ordinary
  // English word was matched as a whole token in every other reviewer's prose
  // and became the in-edge of the whole panel — a file the claim-checker had
  // already disproved, anchoring a four-lane critical root cause.
  const attacker = { id: 'F1', reporter: 'adversary', file: 'the', line: 1,
                     detail: 'x', claimCheck: { status: 'DISPROVED' } };
  const honest = Array.from({ length: 5 }, (_, i) => ({
    id: `F${i + 2}`, reporter: 'auditor', file: `h${i}.mjs`, line: i + 1,
    detail: 'the fix does not cover the whole class', claimCheck: { status: 'ok' },
  }));
  const edges = crossReferenceFindings([attacker, ...honest]);
  assert.equal(edges.filter((e) => e.to === 'F1').length, 0,
    'a disproved anchor must collect no citations');
});

test('crossReferenceFindings: in-degree is capped, not just out-degree', () => {
  // The out-degree cap bounded how far one finding could REACH and said
  // nothing about how many could reach IT, so one well-placed target still sat
  // at the centre of the component.
  const target = { id: 'T', reporter: 'adversary', file: 'hot.mjs', line: 5, detail: 'x' };
  const sources = Array.from({ length: 9 }, (_, i) => ({
    id: `S${i}`, reporter: 'auditor', file: `s${i}.mjs`, line: i + 1,
    detail: 'this is really about hot.mjs',
  }));
  const edges = crossReferenceFindings([target, ...sources]);
  assert.equal(edges.filter((e) => e.to === 'T').length, MAX_CO_CITATIONS_PER_FINDING);
});

test('crossReferenceFindings: lineEchoed needs a cited line, not any integer', () => {
  // `/\d+/g` matched every integer anywhere in the prose — digits inside
  // identifiers (SHA256 yielded 256) and any figure a reviewer quoted. Since
  // lineEchoed is what lets a SAME-FILE pair form an edge at all, a weak match
  // reopened the bypass the same-file rule closes.
  const target = { id: 'T', reporter: 'adversary', file: 'a.mjs', line: 256, detail: 'x' };
  const incidental = { id: 'S', reporter: 'auditor', file: 'a.mjs', line: 900,
                       detail: 'the SHA256 digest in a.mjs is recomputed 256 times' };
  assert.equal(crossReferenceFindings([target, incidental]).length, 0,
    'digits in prose and identifiers are not a line citation');

  const cited = { id: 'S', reporter: 'auditor', file: 'a.mjs', line: 900,
                  detail: 'this is the same defect as a.mjs:256' };
  const edges = crossReferenceFindings([target, cited]);
  assert.equal(edges.length, 1);
  assert.equal(edges[0].lineEchoed, true);
});

test('checkKind: an inherited Object.prototype key is not a known kind', () => {
  // A plain lookup object answers `constructor` and `toString` with something
  // truthy, so KIND_REQUIREMENTS[kind] found a "requirement" for a kind that
  // does not exist and skipped the UNKNOWN branch that treats it as blocking.
  for (const kind of ['constructor', 'toString', '__proto__', 'valueOf']) {
    assert.equal(checkKind(kind, 'a.py', 1, null).status, 'UNKNOWN',
      `kind ${kind} must be unrecognized`);
  }
});
