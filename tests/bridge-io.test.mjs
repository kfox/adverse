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
  existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync,
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
    assert.equal(existsSync(dest), false, 'and the refusal leaves nothing at the destination');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Static, because the point is that there is ONE implementation. Six copies of
// this line is how six of them came to be missing a flag the seventh had.
//
// Over the directory rather than over the list below: that list is the bridges
// whose `--help` exits 0, which is a different question, and three of the six
// that were missing the flag are not on it. A bridge added later is covered
// here without this file being edited, which is the only version of this rule
// worth having.
test('no bridge writes a caller-supplied destination itself', () => {
  const dir = path.join(here, '..', 'skills', 'adverse-review', 'scripts');
  const offenders = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.mjs')).sort()) {
    if (file === 'bridge-io.mjs') continue;
    const src = readFileSync(path.join(dir, file), 'utf-8');
    for (const m of src.matchAll(/writeFileSync\(\s*values[.[][^\n]*/g)) {
      offenders.push(`${file}:${src.slice(0, m.index).split('\n').length}: ${m[0].trim()}`);
    }
  }
  assert.deepEqual(offenders, [],
    `these write an output path themselves instead of through writeOutput:\n  `
    + `${offenders.join('\n  ')}\n`
    + 'Use writeOutput (bridge-io.mjs), which carries the flags and the exit code.');
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

const here = path.dirname(new URL(import.meta.url).pathname);
const BRIDGES = ['collect', 'combine', 'converge', 'decisions', 'plan',
  'repair', 'regression', 'triage', 'validate', 'verify'];
const bridgePath = (name) =>
  path.join(here, '..', 'skills', 'adverse-review', 'scripts', `${name}.mjs`);

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
