// Tests for skills/adverse-review/scripts/bridge-io.mjs — the shared write
// queue every bridge flushes its output through.
//
// The queue's ordering guarantee ("nothing is published until every payload has
// been judged") is covered where it is used, in the regression, verify and
// repair bridge tests. What is here is the guarantee that belongs to the WRITE
// itself, because it cannot be tested through a bridge: the bridge refuses a
// bad destination before it queues anything, so reaching the write with a
// hostile path means queuing first and planting the path afterwards — which is
// exactly the window a check-before-write leaves open.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync,
  symlinkSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

const { makeWriteQueue, writeOutput } = await import(
  new URL('../skills/adverse-review/scripts/bridge-io.mjs', import.meta.url));

// `writeOutput` and `flush` both exit the process on a write failure, so an
// assertion has to be on what is left on disk and what was said, not on a
// thrown error: the process would be gone.
function catchExit(run) {
  const exit = process.exit;
  const stderr = process.stderr.write;
  const seen = { code: null, said: '' };
  process.exit = (c) => { seen.code = c; throw new Error('exited'); };
  process.stderr.write = (text) => { seen.said += text; return true; };
  try {
    run();
  } catch (e) {
    if (e.message !== 'exited') throw e;
  } finally {
    process.exit = exit;
    process.stderr.write = stderr;
  }
  return seen;
}

const here = path.dirname(new URL(import.meta.url).pathname);

const BRIDGES = ['collect', 'combine', 'converge', 'decisions', 'plan',
  'repair', 'regression', 'triage', 'validate', 'verify'];
const bridgePath = (name) =>
  path.join(here, '..', 'skills', 'adverse-review', 'scripts', `${name}.mjs`);

function freshTmp() {
  return mkdtempSync(path.join(tmpdir(), 'adverse-bridge-io-'));
}

test('the write refuses a symlink planted after the destination was judged', () => {
  // regression.mjs refuses a destination `lstatSync` says is not a regular
  // file. CodeQL flagged that as `js/file-system-race` and was right: a check
  // is not a defense on its own, because anything that can write in the run
  // directory can plant the link between the check and the write. Measured
  // control, with the plain `writeFileSync` this replaced: the link is followed
  // and the target is silently clobbered.
  //
  // The queue call stands in for "the bridge has finished judging", so the link
  // below is planted inside the race window rather than before it.
  const dir = freshTmp();
  try {
    const target = path.join(dir, 'not-ours.json');
    const dest = path.join(dir, 'out.json');
    writeFileSync(target, '{"keep":"me"}');

    const queue = makeWriteQueue('probe');
    queue.queue(dest, 'payload.json', '{"written":true}');
    symlinkSync(target, dest);

    // `flush` exits the process on a write failure, so the assertion is on the
    // target rather than on a thrown error: the process would be gone.
    const exit = process.exit;
    const stderr = process.stderr.write;
    let code = null;
    let said = '';
    process.exit = (c) => { code = c; throw new Error('exited'); };
    process.stderr.write = (s) => { said += s; return true; };
    try {
      queue.flush('wrote');
    } catch (e) {
      if (e.message !== 'exited') throw e;
    } finally {
      process.exit = exit;
      process.stderr.write = stderr;
    }

    assert.equal(code, 2, 'a write that could not happen is exit 2, not a review claim');
    assert.match(said, /ELOOP/, 'the kernel refused to resolve the link');
    assert.match(said, /nothing was written/);
    assert.equal(readFileSync(target, 'utf-8'), '{"keep":"me"}',
      'the link target must not be written through');
    assert.equal(lstatSync(dest).isSymbolicLink(), true,
      'the queue never opened it either, so it leaves it alone');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The single-output half of the same rule. Six bridges wrote a caller-supplied
// `--out` with a plain `writeFileSync` while the queue above had opened with
// O_NOFOLLOW since it was written — and unlike the queue's case, no claim or
// check precedes those writes, so the link does not even have to be planted
// inside a race: it can simply be there.
test('a single output refuses a symlink at its destination', () => {
  const dir = freshTmp();
  try {
    const target = path.join(dir, 'not-ours.json');
    const dest = path.join(dir, 'out.json');
    writeFileSync(target, '{"keep":"me"}');
    symlinkSync(target, dest);

    const seen = catchExit(() => writeOutput('triage', dest, '{"written":true}'));

    assert.equal(seen.code, 2, 'a write that could not happen is exit 2');
    assert.match(seen.said, /ELOOP/, 'the kernel refused to resolve the link');
    assert.equal(readFileSync(target, 'utf-8'), '{"keep":"me"}',
      'the link target must not be written through');
    // And the link itself is still there. This assertion read `existsSync(dest)
    // === false` when it was written, which is the defect stated as a
    // requirement: a refused OPEN has touched nothing, and a run that wrote
    // nothing does not get to delete what it found. `--out` here is a path an
    // operator chose — the previous iteration's output, or their own
    // `latest.json` — and unlink permission comes from the DIRECTORY, so
    // cleaning up after every error removes files this run was never allowed to
    // open.
    assert.equal(lstatSync(dest).isSymbolicLink(), true,
      'a refusal that wrote nothing leaves the destination as it found it');
    assert.match(seen.said, /nothing was written, and what was there is unchanged/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The same rule where the destination is an ordinary file this run may simply
// not open. Measured against the single `writeFileSync` this replaced: a
// mode-0444 `out.json` in a writable directory refuses with EACCES having
// written nothing, and the recovery unlinked it anyway. That is a complete
// document destroyed by a run that could not open it.
test('a destination it could not open is left exactly as it was', () => {
  const dir = freshTmp();
  try {
    const dest = path.join(dir, 'out.json');
    writeFileSync(dest, '{"the previous iteration":true}');
    chmodSync(dest, 0o444);

    const seen = catchExit(() => writeOutput('decisions', dest, '{"written":true}'));

    assert.equal(seen.code, 2, seen.said);
    assert.match(seen.said, /cannot be written/);
    assert.equal(readFileSync(dest, 'utf-8'), '{"the previous iteration":true}',
      'a refused open must neither remove nor truncate what it found');
    assert.match(seen.said, /nothing was written, and what was there is unchanged/,
      'and the refusal says so, because ELOOP versus ENOSPC is not the operator\'s'
      + ' question — whether their file is still there is');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The other half of the split, and the half where the destination IS gone: the
// open succeeded, so O_TRUNC already emptied the file, and the write then
// failed. ENOSPC, EDQUOT and EIO are the failures that matter here and none of
// them has a portable fixture, so this reaches the same branch with a body
// `writeFileSync` refuses — the point being what is left on disk and what is
// said about it, not which errno got there.
test('a write that fails after the open clears what the open truncated', () => {
  const dir = freshTmp();
  try {
    const dest = path.join(dir, 'out.json');
    writeFileSync(dest, '{"the previous iteration":true}');

    const seen = catchExit(() => writeOutput('probe', dest, { not: 'a string' }));

    assert.equal(seen.code, 2, seen.said);
    assert.equal(existsSync(dest), false,
      'a truncated file at an output path is worse than no file: the next glob'
      + ' reads a prefix of a JSON document as a whole one');
    assert.match(seen.said, /the write had already truncated it, so it was cleared/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Static, because the point is that there is ONE implementation. Six copies of
// this line is how six of them came to be missing a flag the seventh had.
//
// Over the directory rather than over `BRIDGES` above: that list is the bridges
// whose `--help` exits 0, which is a different question, and three of the six
// that were missing the flag are not on it. A bridge added later is covered
// here without this file being edited, which is the only version of this rule
// worth having.
//
// Over every way of opening a file for writing, not just the one spelling the
// six offenders happened to share. `writeFileSync(values.out, …)` is what they
// wrote; `appendFileSync`, `createWriteStream` and a bare `openSync` reach the
// same destination with the same missing flag, and a name bound from `values` a
// few lines above the write is the same code with a variable in it — which is
// what anyone reads this rule and then writes.
const OPENS_FOR_WRITING =
  /\b(?:appendFile|appendFileSync|createWriteStream|openSync|writeFile|writeFileSync)\(\s*([^,)]{0,120})/g;

// Locals holding a destination this run was handed: `const dest = values.out`,
// `const { out } = values`.
function destNames(src) {
  const names = new Set();
  for (const m of src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=[^;\n]*\bvalues[.[]/g)) {
    names.add(m[1]);
  }
  for (const m of src.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=\s*values\b/g)) {
    for (const part of m[1].split(',')) {
      const bound = /([A-Za-z_$][\w$]*)\s*$/.exec(part.split(':').pop() ?? '');
      if (bound) names.add(bound[1]);
    }
  }
  return [...names];
}

test('no bridge writes a caller-supplied destination itself', () => {
  const dir = path.join(here, '..', 'skills', 'adverse-review', 'scripts');
  const offenders = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.mjs')).sort()) {
    if (file === 'bridge-io.mjs') continue;
    const src = readFileSync(path.join(dir, file), 'utf-8');
    const handed = destNames(src);
    for (const m of src.matchAll(OPENS_FOR_WRITING)) {
      const dest = m[1];
      if (!/\bvalues[.[]/.test(dest) && !handed.some((n) => new RegExp(`\\b${n}\\b`).test(dest))) {
        continue;
      }
      offenders.push(`${file}:${src.slice(0, m.index).split('\n').length}: ${m[0].trim()}`);
    }
  }
  assert.deepEqual(offenders, [],
    `these open an output path themselves instead of going through bridge-io:\n  `
    + `${offenders.join('\n  ')}\n`
    + 'Use writeOutput, or makeWriteQueue for a bridge with more than one output:'
    + ' both carry the flags and the exit code.');
});

// The queue's collision refusal, reached through a bridge, because that is
// where it earns its keep: collect.mjs takes `--out` and `--files-out` from the
// caller and nothing stops them being the same path. Written one after the
// other — which is what it did — the file list silently landed where the source
// block was promised, and the exit code said the run succeeded.
test('a bridge whose two outputs name one file writes neither', () => {
  const dir = freshTmp();
  try {
    const dest = path.join(dir, 'both.json');
    writeFileSync(path.join(dir, 'reviewable.mjs'), 'export const x = 1;\n');
    const r = spawnSync(process.execPath,
      [bridgePath('collect'), '--target', dir, '--out', dest, '--files-out', dest],
      { encoding: 'utf-8' });

    assert.equal(r.status, 1, `exit ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /refuses to overwrite/, r.stderr);
    assert.equal(existsSync(dest), false,
      'the second claim is refused before the first write, not after it');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an ordinary destination is still written', () => {
  // The control for the test above: the flag must not refuse the honest case.
  const dir = freshTmp();
  try {
    const dest = path.join(dir, 'out.json');
    const queue = makeWriteQueue('probe');
    queue.queue(dest, 'payload.json', '{"written":true}');
    queue.flush('wrote');

    assert.equal(readFileSync(dest, 'utf-8'), '{"written":true}');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Every bridge parses strictly, so before parseBridgeArgs existed the first
// thing anyone types at an unfamiliar CLI (`--help`) was an uncaught Node
// stack trace at exit 1 — which under the exit-code contract claims a payload
// failed its schema. The per-bridge probe below proves each bridge routes
// through the shared wrapper; the two parse-refusal shapes are then pinned on
// one bridge, because the path is the same shared function for all ten.

test('--help prints usage at exit 0 on every bridge', () => {
  for (const name of BRIDGES) {
    const r = spawnSync(process.execPath, [bridgePath(name), '--help'],
      { encoding: 'utf-8' });
    assert.equal(r.status, 0, `${name}: ${r.stderr}`);
    assert.match(r.stdout, /^Usage:/, `${name} stdout: ${r.stdout}`);
    assert.equal(r.stderr, '', `${name} wrote to stderr on --help`);
  }
});

test('a parse refusal is the usage text at exit 2, never a stack trace', () => {
  for (const argv of [['--no-such-flag'], ['--json=true']]) {
    const r = spawnSync(process.execPath, [bridgePath('plan'), ...argv],
      { encoding: 'utf-8' });
    assert.equal(r.status, 2, `${argv}: exit ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /^plan: /, `${argv} names the bridge`);
    assert.match(r.stderr, /Usage: plan\.mjs/, `${argv} prints usage`);
    assert.doesNotMatch(r.stderr, /at .*parse_args/, `${argv} stack-traced`);
  }
});
