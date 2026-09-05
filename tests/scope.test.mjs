// Tests for src/scope.mjs — the Adversary lane's budget gate.
//
// The property that matters is the asymmetry: a false positive costs two model
// calls, a false negative ships a vulnerability nobody looked for. So most of
// these check that it errs toward running, and one checks that it can still
// actually skip — a gate that never skips is just an expensive way to say yes.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { assessScope } from '../src/scope.mjs';

const diffOf = (...added) =>
  ['diff --git a/x b/x', '--- a/x', '+++ b/x', '@@ -1 +1 @@', ...added.map((l) => `+${l}`)].join('\n');

test('a diff with no boundary anywhere near it skips', () => {
  const r = assessScope({
    files: ['src/render/palette.mjs', 'src/render/dither.mjs'],
    diff: diffOf('const gamma = 2.2;', 'return pixels.map((p) => p * gamma);'),
  });
  assert.equal(r.recommend, 'skip');
  assert.deepEqual(r.evidence, []);
});

test('a boundary in the path is enough on its own', () => {
  const r = assessScope({ files: ['src/auth/session.js'], diff: diffOf('const x = 1;') });
  assert.equal(r.recommend, 'run');
  assert.equal(r.evidence[0].kind, 'path');
});

test('a dangerous sink in added code is enough on its own', () => {
  const r = assessScope({ files: ['src/render/palette.mjs'], diff: diffOf('el.innerHTML = name;') });
  assert.equal(r.recommend, 'run');
  assert.equal(r.evidence[0].kind, 'content');
});

test('a sink in a REMOVED line does not count — that is somebody else\'s review', () => {
  const diff = ['diff --git a/x b/x', '--- a/x', '+++ b/x', '@@ -1 +1 @@',
                '-el.innerHTML = name;', '+el.textContent = name;'].join('\n');
  assert.equal(assessScope({ files: ['src/render/x.js'], diff }).recommend, 'skip');
});

test('the +++ header is not mistaken for an added line', () => {
  const diff = ['diff --git a/auth b/auth', '--- a/subprocess.js', '+++ b/subprocess.js',
                '@@ -1 +1 @@', '+const x = 1;'].join('\n');
  const r = assessScope({ files: ['renderer.js'], diff });
  assert.equal(r.evidence.filter((e) => e.kind === 'content').length, 0);
});

test('an empty file list defaults to running rather than to skipping', () => {
  const r = assessScope({ files: [], diff: '' });
  assert.equal(r.recommend, 'run');
  assert.match(r.reason, /defaulting to run/);
});

test('each path contributes at most one piece of evidence', () => {
  // "auth" and "session" and "cookie" all match this one path.
  const r = assessScope({ files: ['src/auth/session-cookie.js'], diff: '' });
  assert.equal(r.evidence.length, 1);
});

test('each content pattern reports once, however often it fires', () => {
  const r = assessScope({
    files: ['x.js'],
    diff: diffOf('el.innerHTML = a;', 'el.innerHTML = b;', 'el.innerHTML = c;'),
  });
  assert.equal(r.evidence.length, 1);
});

test('the pruned-out common nouns really are gone', () => {
  // These fired on nearly every diff in the first cut. A signal that always
  // fires is not a signal, and this is the test that keeps them from creeping
  // back in.
  const r = assessScope({
    files: ['src/util/files.mjs', 'src/util/paths.mjs', 'src/parse.mjs'],
    diff: diffOf(
      "import { readFileSync, writeFileSync } from 'node:fs';",
      "const data = JSON.parse(readFileSync(f, 'utf-8'));",
      "const m = RE.exec(line);",
      "import { thing } from '../lib/thing.mjs';",
      'const id = crypto.randomUUID();',
    ),
  });
  assert.equal(r.recommend, 'skip', `unexpected evidence: ${JSON.stringify(r.evidence)}`);
});

test('security concepts named outright count, even without a sink', () => {
  for (const line of ['# authenticate the caller', 'const CSP = "Content-Security-Policy";',
                      'const apiKey = env.KEY;', 'if (!hasPermission(u)) return;']) {
    assert.equal(assessScope({ files: ['x.js'], diff: diffOf(line) }).recommend, 'run', line);
  }
});

// --- what the signal scanner must not miss, and must not hang on -------------

test('an added line beginning with ++ is scanned, not mistaken for a header', () => {
  // `+++ b/path` is a header; `+++i;` is the added line `++i;`. Matching the
  // bare `+++` prefix dropped every added line starting with `++` — a silent
  // false negative, and the indentation an attacker would reach for.
  const diff = [
    '--- a/db.js', '+++ b/db.js', '@@ -1 +1,2 @@',
    '+++i; const q = "SELECT " + name + " FROM users";',
  ].join('\n');
  const r = assessScope({ files: ['db.js'], diff });
  assert.equal(r.recommend, 'run');
  assert.ok(r.evidence.some((e) => e.sample.includes('++i;')),
    'the ++ line must reach the scanner');
});

test('the SQL signal does not backtrack catastrophically', () => {
  // `SELECT\s+.*\s+FROM` took 34s on 4,000 spaces and grew ~8x per doubling.
  // The diff is unbounded and attacker-influenced, so this is a real stall.
  const diff = `--- a/x.js\n+++ b/x.js\n@@ -1 +1 @@\n+SELECT${' '.repeat(20000)}\n`;
  const started = Date.now();
  assessScope({ files: ['x.js'], diff });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 1000, `scan took ${elapsed}ms — the regex is backtracking again`);
});

test('the SQL signal still fires on a real query', () => {
  const diff = '--- a/db.js\n+++ b/db.js\n@@ -1 +1 @@\n+  rows = q("SELECT id FROM users WHERE n=" + n)\n';
  const r = assessScope({ files: ['db.js'], diff });
  assert.equal(r.recommend, 'run');
});

test('a sink past column 2000 is still found', () => {
  // The ReDoS fix briefly truncated each scanned line at 2,000 characters,
  // which recreated exactly the false-negative class the `++` fix had just
  // closed: a minified or bundled line is where a payload would sit, and this
  // module's bias is one-directional on purpose — a false positive costs two
  // model calls, a false negative ships a vulnerability nobody looked for.
  const line = 'x'.repeat(3000) + ' child_process.exec(userInput)';
  const diff = `--- a/b.js\n+++ b/b.js\n@@ -1 +1 @@\n+${line}\n`;
  const r = assessScope({ files: ['b.js'], diff });
  assert.equal(r.recommend, 'run');
  assert.ok(r.evidence.length > 0);
  assert.ok(r.evidence[0].sample.length <= 130, 'the recorded sample is still clipped');
});

test('scanning a very long line is still fast', () => {
  // Cost control belongs in the patterns, not in dropping input.
  const diff = `--- a/x.js\n+++ b/x.js\n@@ -1 +1 @@\n+SELECT${' '.repeat(200000)}\n`;
  const started = Date.now();
  assessScope({ files: ['x.js'], diff });
  assert.ok(Date.now() - started < 1000, 'a 200k-character line must not stall the scan');
});
