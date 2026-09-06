// Tests for src/fsSafe.mjs — the TOCTOU-safe open the claim-checker reads
// through.
//
// One branch here is deliberately NOT covered: the path where `fstatSync`
// itself throws (EIO, EBADF) on an already-open descriptor. That is the branch
// that leaked, and forcing it needs `fs.fstatSync` replaced before this module
// binds it — which an ESM named import does not allow (`mock.method` on the
// builtin namespace does not reach the binding). The fix is a try/catch that
// closes and rethrows; the leak-counting helper below covers the sibling
// branch, and the uncovered one is stated rather than implied.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { closeQuietly, openRegularFileSync } from '../src/fsSafe.mjs';

// Open descriptors for this process. /dev/fd is present on macOS and Linux;
// where it is not, the count is unavailable and the assertion is skipped.
function openDescriptors() {
  try {
    return readdirSync('/dev/fd').length;
  } catch {
    return null;
  }
}

test('a directory returns null without leaking the descriptor', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'adverse-fssafe-'));
  try {
    const before = openDescriptors();
    for (let i = 0; i < 200; i += 1) {
      assert.equal(openRegularFileSync(dir), null, 'a directory is not a regular file');
    }
    const after = openDescriptors();
    if (before !== null && after !== null) {
      assert.ok(after - before < 50,
        `descriptors grew by ${after - before} over 200 calls — the non-file path leaks`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a regular file opens, and the caller closes it', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'adverse-fssafe-'));
  try {
    const file = path.join(dir, 'a.txt');
    writeFileSync(file, 'hello\n', 'utf-8');
    const before = openDescriptors();
    for (let i = 0; i < 200; i += 1) {
      const fd = openRegularFileSync(file);
      assert.ok(typeof fd === 'number');
      closeQuietly(fd);
    }
    const after = openDescriptors();
    if (before !== null && after !== null) {
      assert.ok(after - before < 50, `descriptors grew by ${after - before} over 200 calls`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing file throws where openSync would, with no descriptor to leak', () => {
  // The absent path is inside a private `mkdtempSync` directory, not a fixed
  // name under the shared temp dir. A predictable name in a world-writable
  // directory is something any local user can create first, at which point
  // this test stops asserting what it says it does — and it is the pattern
  // `js/insecure-temporary-file` exists to catch, which is how it was found.
  const dir = mkdtempSync(path.join(os.tmpdir(), 'adverse-fssafe-'));
  try {
    assert.throws(() => openRegularFileSync(path.join(dir, 'not-created')), /ENOENT/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a FIFO is refused immediately rather than blocking forever', () => {
  // Opening a FIFO for reading blocks until a writer appears, and the paths
  // this opens come from reviewer JSON. A committed FIFO in a checkout (git
  // stores mode 010000) hung the triage bridge with no output and no timeout.
  const dir = mkdtempSync(path.join(os.tmpdir(), 'adverse-fssafe-'));
  try {
    const pipe = path.join(dir, 'pipe');
    try {
      execFileSync('mkfifo', [pipe]);
    } catch {
      return; // no mkfifo on this platform; nothing to assert
    }
    const started = Date.now();
    assert.equal(openRegularFileSync(pipe), null, 'a FIFO is not a regular file');
    assert.ok(Date.now() - started < 2000, 'must not block waiting for a writer');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
