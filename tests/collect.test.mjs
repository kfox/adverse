// Tests for src/collect.mjs — directory walk + git-diff modes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

import { collectDirectory, collectDiff } from '../src/collect.mjs';

function freshTmp() {
  return mkdtempSync(path.join(tmpdir(), 'adverse-test-'));
}

function buildTarget() {
  const dir = freshTmp();
  mkdirSync(path.join(dir, 'src'));
  writeFileSync(path.join(dir, 'src', 'main.py'), "def hello(): return 'hi'\n");
  writeFileSync(path.join(dir, 'src', 'util.py'), 'X = 1\n');
  mkdirSync(path.join(dir, 'node_modules'));
  writeFileSync(path.join(dir, 'node_modules', 'junk.js'), 'module.exports = {};\n');
  writeFileSync(path.join(dir, 'image.png'), Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n'), Buffer.alloc(100)]));
  writeFileSync(path.join(dir, 'binary.bin'), Buffer.alloc(100));
  writeFileSync(path.join(dir, 'empty.py'), '');
  return dir;
}

test('collectDirectory includes python files', () => {
  const dir = buildTarget();
  try {
    const { files } = collectDirectory(dir);
    assert.ok(files.includes('src/main.py'));
    assert.ok(files.includes('src/util.py'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('collectDirectory excludes node_modules', () => {
  const dir = buildTarget();
  try {
    const { files } = collectDirectory(dir);
    assert.ok(!files.some((f) => f.includes('node_modules')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('collectDirectory excludes binaries', () => {
  const dir = buildTarget();
  try {
    const { files } = collectDirectory(dir);
    assert.ok(!files.includes('image.png'));
    assert.ok(!files.includes('binary.bin'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('collectDirectory skips empty files', () => {
  const dir = buildTarget();
  try {
    const { files } = collectDirectory(dir);
    assert.ok(!files.includes('empty.py'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('collectDirectory throws if no reviewable files', () => {
  const dir = freshTmp();
  mkdirSync(path.join(dir, 'node_modules'));
  writeFileSync(path.join(dir, 'node_modules', 'ignored.js'), 'x');
  try {
    assert.throws(() => collectDirectory(dir), /no reviewable source/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('collectDirectory respects max_total_chars', () => {
  const dir = freshTmp();
  for (let i = 0; i < 5; i++) writeFileSync(path.join(dir, `f${i}.py`), 'x'.repeat(1000));
  try {
    const { block, files } = collectDirectory(dir, { maxTotalChars: 2000 });
    assert.ok(files.length <= 3);
    assert.match(block, /TRUNCATED/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('collectDirectory truncates oversized file', () => {
  const dir = freshTmp();
  writeFileSync(path.join(dir, 'big.py'), 'y'.repeat(50_000));
  try {
    const { block, files } = collectDirectory(dir, { maxFileChars: 1000 });
    assert.ok(files.includes('big.py'));
    assert.match(block, /\(truncated to 1000 chars\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Git diff mode ----------------------------------------------------------

function git(repo, ...args) {
  execFileSync('git', ['-C', repo, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
}

function buildGitRepo() {
  const dir = freshTmp();
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 't@t.t');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  writeFileSync(path.join(dir, 'a.py'), 'x = 1\n');
  git(dir, 'add', 'a.py');
  git(dir, 'commit', '-q', '-m', 'initial');
  return dir;
}

test('collectDirectory does not follow a git-tracked symlink pointing outside the repo', () => {
  // `git ls-files` lists a committed symlink (mode 120000) the same as a
  // regular file; opening it by path with no defense reads and inlines
  // whatever it points to, into a block that gets sent to an LLM.
  const dir = buildGitRepo();
  const outside = freshTmp();
  const secret = path.join(outside, 'id_rsa');
  writeFileSync(secret, 'SSH-SENTINEL-DO-NOT-EXFILTRATE\n');
  try {
    try {
      symlinkSync(secret, path.join(dir, 'evil-link.txt'));
    } catch {
      return; // no symlink support on this platform; nothing to assert
    }
    git(dir, 'add', 'evil-link.txt');
    git(dir, 'commit', '-q', '-m', 'add tracked symlink');

    const { block, files } = collectDirectory(dir);
    assert.ok(!files.includes('evil-link.txt'));
    assert.ok(!block.includes('SSH-SENTINEL'),
      'the symlink target must never be inlined into the review block');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('collectDiff returns uncommitted changes', () => {
  const dir = buildGitRepo();
  try {
    writeFileSync(path.join(dir, 'a.py'), 'x = 1\ny = 2\n');
    const { block, files } = collectDiff(dir, null);
    assert.ok(files.includes('a.py'));
    assert.match(block, /\+y = 2/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('collectDiff throws on empty diff', () => {
  const dir = buildGitRepo();
  try {
    assert.throws(() => collectDiff(dir, null), /no changes/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('collectDiff against branch base', () => {
  const dir = buildGitRepo();
  try {
    git(dir, 'checkout', '-q', '-b', 'feature');
    writeFileSync(path.join(dir, 'b.py'), 'z = 3\n');
    git(dir, 'add', 'b.py');
    git(dir, 'commit', '-q', '-m', 'feature');
    // Detect default branch (main vs master)
    const branches = execFileSync('git', ['-C', dir, 'branch', '--list'], { encoding: 'utf-8' });
    const base = branches.includes('main') ? 'main' : 'master';
    const { block, files } = collectDiff(dir, base);
    assert.ok(files.includes('b.py'));
    assert.match(block, /\+z = 3/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('collectDiff requires a git repo', () => {
  const dir = freshTmp();
  try {
    assert.throws(() => collectDiff(dir, null), /not a git repository/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a base that looks like a git option is refused', () => {
  assert.throws(
    () => collectDiff(process.cwd(), '--output=/tmp/x'),
    /looks like an option/,
  );
});
