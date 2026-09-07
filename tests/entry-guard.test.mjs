// Tests for src/entryGuard.mjs — the refusal that replaced a silent exit 0.
//
// `node src/cli.mjs synthesize …` printed nothing and exited 0, which every
// consumer of an exit code reads as "it ran and it passed" (kfox/adverse#71).
// The library list below is READ FROM THE TREE rather than typed out, so the
// rule it enforces — a `.mjs` with a shebang is an entry point, one without is
// a library — covers a module added after this test was written.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = path.join('skills', 'adverse-review', 'scripts');

const { isProcessEntry, runInstead } = await import(
  pathToFileURL(path.join(ROOT, 'src', 'entryGuard.mjs')).href);

function mjsIn(dir) {
  return readdirSync(path.join(ROOT, dir))
    .filter((name) => name.endsWith('.mjs'))
    .map((name) => path.join(dir, name));
}

const hasShebang = (rel) =>
  readFileSync(path.join(ROOT, rel), 'utf-8').startsWith('#!');

// Everything but tests/, where running a file runs its tests and is not a
// no-op.
const LIBRARIES = ['bin', 'scripts', 'src', SCRIPTS]
  .flatMap(mjsIn)
  .filter((rel) => !hasShebang(rel));

const run = (rel, args = []) =>
  spawnSync(process.execPath, [path.join(ROOT, rel), ...args], { encoding: 'utf-8' });

test('every library module refuses to be run instead of exiting 0', () => {
  assert.ok(LIBRARIES.length >= 20, `expected the whole library set, got ${LIBRARIES.length}`);
  for (const rel of LIBRARIES) {
    const r = run(rel);
    assert.equal(r.status, 2, `${rel}: exit ${r.status} — a silent 0 is read as success`);
    assert.match(r.stderr, /is a library module, not an entry point/, `${rel} stderr: ${r.stderr}`);
    assert.equal(r.stdout, '', `${rel} wrote to stdout`);
    assert.doesNotMatch(r.stderr, /^\s+at /m, `${rel} stack-traced`);
  }
});

test('the refusal names the entry point the caller meant', () => {
  // The three shapes: the module the binary wraps, a module sharing its
  // basename with a runnable bridge, and one that shares its name with
  // nothing.
  assert.match(run(path.join('src', 'cli.mjs')).stderr, /node bin\/adverse\.mjs/);
  assert.match(run(path.join('src', 'triage.mjs')).stderr,
    /node skills\/adverse-review\/scripts\/triage\.mjs/);
  assert.match(run(path.join('src', 'taxonomy.mjs')).stderr,
    /entry points are bin\/adverse\.mjs and skills\/adverse-review\/scripts/);
  assert.match(run(path.join(SCRIPTS, 'package-root.mjs')).stderr,
    /bridges beside this file/);
});

test('the arguments a caller typed do not change the refusal', () => {
  // The reported invocation carried a subcommand and flags. An argument parser
  // never runs, so none of them can turn the refusal back into a 0.
  const r = run(path.join('src', 'cli.mjs'), ['synthesize', '--round1', 'x.json']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /not an entry point/);
});

test('the guard does not fire when a library is imported', () => {
  // The control. This test file is the process entry, so importing the module
  // whose guard would exit(2) proves the comparison is against argv[1] and not
  // merely against "is this file a library".
  assert.equal(isProcessEntry(pathToFileURL(path.join(ROOT, 'src', 'cli.mjs')).href), false);
  const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'adverse.mjs'), 'personas'],
    { encoding: 'utf-8' });
  assert.equal(r.status, 0, `the binary still runs: ${r.stderr}`);
  assert.match(r.stdout, /auditor/);
});

test('a suggestion is only made for a sibling that is runnable', () => {
  // `runInstead` answers from the filesystem, not from a list of bridge names
  // kept in step by hand. Two of the four cases are why it tests for a shebang
  // rather than for existence: the bridge directory holds two LIBRARIES, so a
  // src/ module named after one of them would be answered with a path that
  // refuses in exactly the same way, and bridge-io.mjs run directly would be
  // answered with itself.
  assert.match(runInstead(path.join(ROOT, 'src', 'collect.mjs')), /scripts\/collect\.mjs/);
  assert.match(runInstead(path.join(ROOT, 'src', 'package-root.mjs')), /^The entry points/);
  assert.match(runInstead(path.join(ROOT, SCRIPTS, 'bridge-io.mjs')), /^The entry points/);
  assert.match(runInstead(path.join(ROOT, 'src', 'no-such-bridge.mjs')), /^The entry points/);
});

test('a library run through a symlink is still refused', () => {
  // How the skill is normally installed: ~/.claude/skills/adverse-review is a
  // symlink into a checkout, so `node …/scripts/package-root.mjs` reaches the
  // file by a path that is not its own. Node hands the module a canonical
  // `import.meta.url` and hands the process the string the caller typed, so
  // the comparison has to resolve one of them or the guard misses exactly the
  // installed case.
  // Both guards, because package-root.mjs cannot use the shared one: it is the
  // bootstrap that locates src/.
  const dir = mkdtempSync(path.join(tmpdir(), 'adverse-entry-'));
  for (const rel of [path.join('src', 'cli.mjs'), path.join(SCRIPTS, 'package-root.mjs')]) {
    const link = path.join(dir, `link-${path.basename(path.dirname(rel))}.mjs`);
    symlinkSync(path.join(ROOT, rel), link);

    const r = spawnSync(process.execPath, [link], { encoding: 'utf-8' });
    assert.equal(r.status, 2, `${rel}: exit ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /not an entry point/, rel);
  }
});
