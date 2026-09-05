// Tests for the Skill's round-1 triage bridge.
//
// triage.mjs is the deterministic layer the panel trusts most: it decides
// which claims are already dead, which are under-anchored, and which pairs of
// findings are candidates for one root cause. None of that involves a model,
// so all of it is testable — and worth testing, because a wrong answer here is
// invisible downstream. It runs as a subprocess against a real throwaway git
// repo, since half its answers come from `git diff`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const TRIAGE = path.join(here, '..', 'skills', 'adverse-review', 'scripts', 'triage.mjs');

function git(cwd, ...args) {
  execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: 'pipe' });
}

// A repo with one commit on `base` and one changed file on HEAD, so the
// in-diff / outside-diff distinction has something real to answer against.
function makeRepo() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'adverse-triage-'));
  git(dir, 'init', '-q', '-b', 'base');
  git(dir, 'config', 'user.email', 'test@example.invalid');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
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

function runTriage(dir, reviews) {
  const files = reviews.map((r, i) => {
    const p = path.join(dir, `round1-${i}.json`);
    writeFileSync(p, JSON.stringify(r), 'utf-8');
    return p;
  });
  const out = path.join(dir, 'briefing.json');
  const args = [TRIAGE];
  for (const f of files) args.push('--round1', f);
  args.push('--repo', dir, '--base', 'base', '--out', out);
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

test('a line inside the diff is marked inside, and its text is captured', () => {
  const { briefing } = runTriage(repo, [review('auditor', [finding()])]);
  const f = briefing.findings[0];
  assert.equal(f.claimCheck.status, 'ok');
  assert.equal(f.claimCheck.inDiff, 'inside');
  assert.equal(f.claimCheck.citedLine, 'line 20 CHANGED');
});

test('a line outside the diff is annotated, never disproved', () => {
  const { briefing } = runTriage(repo, [review('auditor', [finding({ line: 3 })])]);
  const f = briefing.findings[0];
  assert.equal(f.claimCheck.status, 'ok');
  assert.equal(f.claimCheck.inDiff, 'outside');
  assert.match(f.claimCheck.note, /legitimate/);
});

test('a missing file and a line past EOF are both disproved', () => {
  const { briefing } = runTriage(repo, [review('auditor', [
    finding({ file: 'nope.py' }),
    finding({ line: 9999 }),
  ])]);
  assert.equal(briefing.findings[0].claimCheck.status, 'DISPROVED');
  assert.equal(briefing.findings[1].claimCheck.status, 'DISPROVED');
});

test('kindCheck: a defect with no line is under-anchored', () => {
  const { briefing } = runTriage(repo, [review('auditor', [finding({ line: null })])]);
  const kc = briefing.findings[0].kindCheck;
  assert.equal(kc.status, 'UNDER-ANCHORED');
  assert.deepEqual(kc.missing, ['line']);
});

test('kindCheck: a contract finding with no counterpart is under-anchored', () => {
  const { briefing } = runTriage(repo, [review('auditor', [finding({ kind: 'contract' })])]);
  assert.deepEqual(briefing.findings[0].kindCheck.missing, ['counterpart']);
});

test('kindCheck: a contract finding naming both paths passes', () => {
  const { briefing } = runTriage(repo, [review('auditor', [
    finding({ kind: 'contract', counterpart: 'docs/app.md' }),
  ])]);
  assert.equal(briefing.findings[0].kindCheck.status, 'ok');
  assert.equal(briefing.findings[0].counterpartCheck.status, 'ok');
});

test('a counterpart that does not exist disproves the contradiction', () => {
  const { briefing, stdout } = runTriage(repo, [review('auditor', [
    finding({ kind: 'contract', counterpart: 'docs/ghost.md' }),
  ])]);
  assert.equal(briefing.findings[0].counterpartCheck.status, 'DISPROVED');
  assert.match(stdout, /claim-check disproved: 1/);
});

test('kindCheck: design needs no anchor and is flagged advisory', () => {
  const { briefing, stdout } = runTriage(repo, [review('pragmatist', [
    finding({ kind: 'design', file: null, line: null }),
  ])]);
  assert.equal(briefing.findings[0].kindCheck.status, 'ok');
  assert.equal(briefing.findings[0].kindCheck.advisory, true);
  assert.match(stdout, /advisory \(design — cannot block\): 1/);
});

test('kindCheck: a missing kind is reported, not silently accepted', () => {
  const f = finding();
  delete f.kind;
  const { briefing } = runTriage(repo, [review('auditor', [f])]);
  assert.equal(briefing.findings[0].kindCheck.status, 'MISSING');
});

test('kindCheck: an unrecognized kind is reported as unknown', () => {
  const { briefing } = runTriage(repo, [review('auditor', [finding({ kind: 'vibes' })])]);
  assert.equal(briefing.findings[0].kindCheck.status, 'UNKNOWN');
});

test('ids are assigned across reviewers in order', () => {
  const { briefing } = runTriage(repo, [
    review('auditor', [finding({ title: 'a' })]),
    review('adversary', [finding({ title: 'b' })]),
  ]);
  assert.deepEqual(briefing.findings.map((f) => f.id), ['F1', 'F2']);
});

test('two reporters near the same line cluster; one reporter does not', () => {
  const two = runTriage(repo, [
    review('auditor', [finding({ title: 'a', line: 20 })]),
    review('adversary', [finding({ title: 'b', line: 25 })]),
  ]).briefing;
  assert.equal(two.clusters.length, 1);
  assert.deepEqual(two.clusters[0].ids, ['F1', 'F2']);

  const one = runTriage(repo, [
    review('auditor', [finding({ title: 'a', line: 20 }), finding({ title: 'b', line: 25 })]),
  ]).briefing;
  assert.equal(one.clusters.length, 0, 'one reporter twice is not consensus');
});

test('findings far apart in the same file do not cluster', () => {
  const { briefing } = runTriage(repo, [
    review('auditor', [finding({ title: 'a', line: 2 })]),
    review('adversary', [finding({ title: 'b', line: 38 })]),
  ]);
  assert.equal(briefing.clusters.length, 0);
});

test('one finding citing another reporter\'s file is a cross-reference', () => {
  const { briefing } = runTriage(repo, [
    review('auditor', [finding({ title: 'a', file: 'app.py', line: 20 })]),
    review('steward', [finding({ title: 'b', file: 'docs/app.md', line: 1,
      detail: 'app.py line 20 disagrees with this' })]),
  ]);
  const xref = briefing.crossReferences.find((x) => x.from === 'F2' && x.to === 'F1');
  assert.ok(xref, 'expected F2 -> F1 co-citation');
  assert.equal(xref.lineEchoed, true);
});

test('a reviewer citing its own file is not a cross-reference', () => {
  const { briefing } = runTriage(repo, [
    review('auditor', [
      finding({ title: 'a', file: 'app.py' }),
      finding({ title: 'b', file: 'app.py', detail: 'see app.py' }),
    ]),
  ]);
  assert.equal(briefing.crossReferences.length, 0);
});

test('the gate summary is carried into the briefing verbatim', () => {
  const p = path.join(repo, 'r.json');
  writeFileSync(p, JSON.stringify(review('auditor', [])), 'utf-8');
  const out = path.join(repo, 'b.json');
  execFileSync(process.execPath, [TRIAGE, '--round1', p, '--repo', repo,
    '--base', 'base', '--gate', 'make test: green', '--out', out], { encoding: 'utf-8' });
  assert.equal(JSON.parse(readFileSync(out, 'utf-8')).gate, 'make test: green');
});
