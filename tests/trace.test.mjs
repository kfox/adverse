// Tests for src/trace.mjs — hunk arithmetic, and tracing against a real repo.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, renameSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { clearRefCache, followRename, parseHunks, projectLine, resolveRef, traceAnchor } from '../src/trace.mjs';

// --- pure arithmetic ---------------------------------------------------------

const hunks = (text) => parseHunks(text);

test('parseHunks reads counts, and defaults an omitted count to 1', () => {
  const h = hunks('@@ -10 +10 @@\n@@ -20,3 +20,5 @@\n');
  assert.deepEqual(h[0], { oldStart: 10, oldCount: 1, newStart: 10, newCount: 1 });
  assert.deepEqual(h[1], { oldStart: 20, oldCount: 3, newStart: 20, newCount: 5 });
});

test('parseHunks ignores everything that is not a hunk header', () => {
  assert.equal(hunks('diff --git a/x b/x\n--- a/x\n+++ b/x\n-gone\n+new\n').length, 0);
});

test('a line inside a hunk is touched', () => {
  const r = projectLine(hunks('@@ -20,3 +20,5 @@'), 21);
  assert.equal(r.status, 'touched');
});

test('a line below an insertion shifts down by the number of lines added', () => {
  const r = projectLine(hunks('@@ -10,0 +11,3 @@'), 50);
  assert.equal(r.status, 'untouched');
  assert.equal(r.line, 53);
});

test('a line below a deletion shifts up', () => {
  const r = projectLine(hunks('@@ -10,4 +10,0 @@'), 50);
  assert.equal(r.status, 'untouched');
  assert.equal(r.line, 46);
});

test('a line above every hunk does not move', () => {
  const r = projectLine(hunks('@@ -30,2 +30,9 @@'), 5);
  assert.equal(r.status, 'untouched');
  assert.equal(r.line, 5);
});

test('deltas accumulate across several hunks', () => {
  const r = projectLine(hunks('@@ -5,1 +5,3 @@\n@@ -20,4 +22,1 @@\n'), 60);
  // +2 from the first hunk, -3 from the second.
  assert.equal(r.line, 59);
});

test('a zero-count insertion exactly at the line inserts above it', () => {
  // `-40,0` means "inserted after old line 40", so line 41 shifts.
  assert.equal(projectLine(hunks('@@ -40,0 +41,2 @@'), 41).line, 43);
  assert.equal(projectLine(hunks('@@ -40,0 +41,2 @@'), 40).line, 40);
});

test('a non-integer or absent line is unanchored, not silently zero', () => {
  assert.equal(projectLine([], null).status, 'unanchored');
  assert.equal(projectLine([], 0).status, 'unanchored');
});

// --- against a real repo -----------------------------------------------------

// Fixture repos must not inherit the developer's global git config: signing,
// commit templates, and hooks all leak in and fail in ways that have nothing to
// do with the code under test.
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };

function git(cwd, ...args) {
  execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: 'pipe', env: GIT_ENV });
}

const body = (n, marker = null) =>
  Array.from({ length: n }, (_, i) => (i + 1 === marker ? `line ${i + 1} MARKED` : `line ${i + 1}`))
    .join('\n') + '\n';

let repo;
test.before(() => {
  repo = mkdtempSync(path.join(os.tmpdir(), 'adverse-trace-'));
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.invalid');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'commit.gpgsign', 'false');
  git(repo, 'config', 'tag.gpgSign', 'false');
  writeFileSync(path.join(repo, 'app.py'), body(40, 30));
  writeFileSync(path.join(repo, 'keep.py'), body(10));
  writeFileSync(path.join(repo, 'doomed.py'), body(5));
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'v1');
  git(repo, 'tag', 'v1');

  // v2: insert 3 lines near the top, edit line 10, rename one file, delete another.
  const lines = body(40, 30).split('\n');
  lines[9] = 'line 10 FIXED';
  lines.splice(2, 0, 'added a', 'added b', 'added c');
  writeFileSync(path.join(repo, 'app.py'), lines.join('\n'));
  renameSync(path.join(repo, 'keep.py'), path.join(repo, 'moved.py'));
  unlinkSync(path.join(repo, 'doomed.py'));
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'v2');
  git(repo, 'tag', 'v2');
});
test.after(() => rmSync(repo, { recursive: true, force: true }));

const trace = (over) => traceAnchor({ repo, from: 'v1', to: 'v2', ...over });

test('a line the fix landed on comes back touched', () => {
  assert.equal(trace({ file: 'app.py', line: 10 }).status, 'touched');
});

test('a line below the change is untouched and shifts by the insertion', () => {
  const r = trace({ file: 'app.py', line: 30, citedLine: 'line 30 MARKED' });
  assert.equal(r.status, 'untouched');
  assert.equal(r.line, 33);
  assert.equal(r.nowText, 'line 30 MARKED');
  assert.equal(r.textMatches, true);
});

test('untouched carries the warning that it is not a verdict', () => {
  assert.match(trace({ file: 'app.py', line: 30 }).note, /not.*unfixed/i);
});

test('a stale citedLine is reported, not quietly corrected', () => {
  const r = trace({ file: 'app.py', line: 30, citedLine: 'something else entirely' });
  assert.equal(r.textMatches, false);
  assert.match(r.why, /projection may be off/);
});

test('a renamed file is followed, and the new path is reported', () => {
  const r = trace({ file: 'keep.py', line: 4 });
  assert.equal(r.file, 'moved.py');
  assert.equal(r.renamedFrom, 'keep.py');
  assert.notEqual(r.status, 'file-gone');
});

test('followRename returns the new path directly', () => {
  assert.deepEqual(followRename(repo, 'v1', 'v2', 'keep.py'), { status: 'ok', path: 'moved.py' });
  assert.deepEqual(followRename(repo, 'v1', 'v2', 'app.py'), { status: 'ok', path: 'app.py' });
});

test('followRename separates a deleted file from a git failure', () => {
  assert.deepEqual(followRename(repo, 'v1', 'v2', 'doomed.py'), { status: 'gone' });

  const failed = followRename(repo, 'v1', 'no-such-ref-at-all', 'app.py');
  assert.equal(failed.status, 'failed');
  assert.match(failed.why, /failed/);
});

test('a deleted file is file-gone', () => {
  const r = trace({ file: 'doomed.py', line: 2 });
  assert.equal(r.status, 'file-gone');
  assert.equal(r.line, null);
});

test('a finding with no file traces to not-file-bound rather than throwing', () => {
  assert.equal(trace({ file: null, line: null }).status, 'not-file-bound');
});

test('a file-bound finding with no line traces the file only', () => {
  const r = trace({ file: 'app.py', line: null });
  assert.equal(r.status, 'file-only');
  assert.equal(r.line, null);
});

test('tracing is an identity when nothing changed between the refs', () => {
  const r = traceAnchor({ repo, from: 'v2', to: 'v2', file: 'app.py', line: 30 });
  assert.equal(r.status, 'untouched');
  assert.equal(r.line, 30);
});

// --- the states a caller must be able to tell apart --------------------------
// Each of these used to come back as `file-gone`, which reads as "the file was
// deleted" — evidence a finding was fixed. A tracer that cannot answer has to
// say so.

test('an unresolvable ref is trace-failed, not file-gone', () => {
  const r = traceAnchor({ repo, from: 'v1', to: 'no-such-ref', file: 'app.py', line: 30 });
  assert.equal(r.status, 'trace-failed');
  assert.match(r.why, /not a resolvable commit: no-such-ref/);
});

test('a ref that could be read as a git flag is refused before it reaches git', () => {
  // `git diff --output=FILE..HEAD` exits 0 and writes FILE. A ref arrives from
  // a JSON ledger on disk, so it is untrusted input in an argument position.
  for (const evil of ['--output=/tmp/pwned', '-x', '--upload-pack=touch /tmp/x']) {
    assert.equal(resolveRef(repo, evil), null, `${evil} must not resolve`);
    const r = traceAnchor({ repo, from: evil, to: 'v2', file: 'app.py', line: 1 });
    assert.equal(r.status, 'trace-failed');
  }
});

test('resolveRef accepts the ref spellings a ledger legitimately carries', () => {
  assert.ok(resolveRef(repo, 'v2'));
  assert.ok(resolveRef(repo, 'HEAD'));
  assert.equal(resolveRef(repo, 'HEAD'), resolveRef(repo, resolveRef(repo, 'HEAD')));
});

test('projectLine never returns line 0 when a hunk deletes the top of the file', () => {
  // `@@ -1,2 +0,0 @@` deletes the first two lines: newStart is the position
  // *before* line 1. Line 0 is not a line, and the ledger's +/-5 match window
  // would read it as an anchor five lines from lines 1-5.
  const r = projectLine(parseHunks('@@ -1,2 +0,0 @@'), 1);
  assert.equal(r.status, 'touched');
  assert.equal(r.line, 1);
});

test('resolveRef caches resolutions but not failures, and clears on demand', () => {
  // A ref that does not exist YET must not be remembered as unresolvable, or a
  // long-lived process could never see it appear. Positive results are cached,
  // which is safe for the one-shot CLIs that call this — but a symbolic ref is
  // frozen at first resolution, so the invalidation hook has to work.
  clearRefCache();
  assert.equal(resolveRef(repo, 'not-a-ref-yet'), null);
  execFileSync('git', ['tag', 'not-a-ref-yet', 'v1'], { cwd: repo, env: GIT_ENV });
  assert.ok(resolveRef(repo, 'not-a-ref-yet'), 'a negative result must not be cached');

  const first = resolveRef(repo, 'HEAD');
  clearRefCache();
  assert.equal(resolveRef(repo, 'HEAD'), first, 'clearRefCache re-resolves rather than breaking');
});
