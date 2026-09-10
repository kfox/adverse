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
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, symlinkSync, writeFileSync,
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
    // Two sentences, about two different files. "Nothing was written" answered
    // for both, so a destination the failed write had truncated and could not
    // clear sat under a line saying nothing had been written to it.
    assert.match(said, /this run opened nothing at that path/, said);
    assert.match(said, /no other file was written/, said);
    assert.doesNotMatch(said, /^\s+nothing was written$/m,
      'the sentence about the other files must not answer for this one');
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
    assert.match(seen.said, /this run opened nothing at that path/);
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
    assert.match(seen.said, /this run opened nothing at that path/,
      'and the refusal says so, because ELOOP versus ENOSPC is not the operator\'s'
      + ' question — what this run did to the file is');
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
// And the case where the clear itself fails, which is not a corner: `O_TRUNC`
// needs permission on the FILE and unlink needs it on the DIRECTORY, so a
// writable file in a write-protected directory truncates and then will not be
// removed. The first version of this said "it was cleared" over the operator's
// document sitting at zero bytes — an announcement that the one outcome this
// block exists to prevent had been prevented, while it was happening.
test('a clear that fails is not reported as a clear', { skip: process.getuid?.() === 0 }, () => {
  const dir = freshTmp();
  try {
    const walled = path.join(dir, 'walled');
    mkdirSync(walled);
    const dest = path.join(walled, 'out.json');
    writeFileSync(dest, '{"the previous iteration":true}');
    chmodSync(walled, 0o555);

    const seen = catchExit(() => writeOutput('probe', dest, { not: 'a string' }));

    assert.equal(seen.code, 2, seen.said);
    assert.match(seen.said, /could not be cleared, so a partial file is at that path/,
      seen.said);
    assert.equal(existsSync(dest), true, 'and it really is still there');
    assert.equal(readFileSync(dest, 'utf-8'), '', 'at zero bytes, which is the point');
  } finally {
    chmodSync(path.join(dir, 'walled'), 0o700);
    rmSync(dir, { recursive: true, force: true });
  }
});

//
// Over every way of REPLACING a file, not just the one spelling the six
// offenders happened to share. `writeFileSync(values.out, …)` is what they
// wrote; `appendFileSync`, `createWriteStream` and a bare `openSync` reach the
// same destination with the same missing flag, and `copyFileSync`/`renameSync`
// from a temporary file is the natural next thing to write here — an "atomic"
// output whose destination nobody opened with these flags either.
//
// Which argument is the destination is part of the answer: it is the first one
// for a write and the SECOND for a copy or a rename, and only that argument is
// read. Searching the whole call instead flagged
// `writeFileSync(patchFile, patch, 'utf-8')` in probe.mjs, where `patch` is a
// diff that came from a `values`-derived path and `patchFile` is probe.mjs's own
// mkdtemp — a rule that cannot tell a destination from a payload needs an
// allow-list within the week.
const DESTINATION_ARG = {
  appendFile: 0,
  appendFileSync: 0,
  copyFile: 1,
  copyFileSync: 1,
  createWriteStream: 0,
  openSync: 0,
  rename: 1,
  renameSync: 1,
  writeFile: 0,
  writeFileSync: 0,
};
const CALLS = new RegExp(`\\b(${Object.keys(DESTINATION_ARG).join('|')})\\s*\\(`, 'g');

// Reading is not this rule's business, and `openSync(dest, 'r')` is the one
// spelling of these that is a read.
const READ_MODE = /^(['"])r\1$/;

// `\b` is no use here: `$` is legal in an identifier and is a non-word
// character, so `\b$out\b` matches nothing at all and the check passes
// silently.
const boundary = (name) =>
  new RegExp(`(?<![\\w$])${name.replace(/\$/g, '\\$')}(?![\\w$])`);

// Text with its string literals emptied, for asking whether an expression reads
// a caller-supplied path. A tainted NAME inside a literal is not a tainted
// value: probe.mjs builds its patch file under `'adverse-probe-patch.'`, and
// `patch` is a tainted name, so the literal tainted `patchFile` and `patchFile`
// then flagged probe.mjs's own mkdtemp write. `values['files-out']` survives
// this, because the bracket is what the check reads and not the key.
function withoutStrings(text) {
  return text.replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g, "''");
}

// From the open paren to the paren that closes it, so a nested call in the first
// argument does not truncate the second. Quoted text is skipped, because a
// bracket inside a string is not a bracket — `writeFileSync(values.out, '(' +
// body)` never returns to depth 0 otherwise.
//
// Returns null when it cannot find the close, and the caller reports that as an
// offender rather than skipping it. A regex literal still defeats this (`\(` in
// `body.replace(/\(/g, '')`), and where one failure mode is silent and the other
// noisy the answer is not "skip the call this rule exists to read".
function callArgs(src, open) {
  const depths = [];
  let quote = null;
  for (let i = open; i < src.length; i += 1) {
    const c = src[i];
    if (quote) {
      if (c === '\\') i += 1;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '\'' || c === '"' || c === '`') quote = c;
    else if ('([{'.includes(c)) depths.push(c);
    else if (')]}'.includes(c)) {
      depths.pop();
      if (!depths.length) return splitArgs(src.slice(open + 1, i));
    }
  }
  return null;
}

function splitArgs(text) {
  const args = [''];
  let depth = 0;
  let quote = null;
  for (const c of text) {
    if (quote) {
      args[args.length - 1] += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === '\'' || c === '"' || c === '`') quote = c;
    else if ('([{'.includes(c)) depth += 1;
    else if (')]}'.includes(c)) depth -= 1;
    if (c === ',' && depth === 0) args.push('');
    else args[args.length - 1] += c;
  }
  return args.map((a) => a.trim());
}

// Every local that holds, or is built from, a destination this run was handed:
// `values.out`, `const dest = values.out`, `const dir = values.outdir` and then
// `path.join(dir, name)`. To a fixed point, because one indirection is not a
// number anyone should have picked.
//
// Assignments as well as declarations. `let dest = null; dest = values.out;` is
// a shape probe.mjs already writes for its patch file, and following only
// declarators left it invisible — one keyword away from the hole this closes.
// A name bound to `values` ITSELF is tracked too, since `opts.out` off
// `const opts = values` is the same claim spelled through another object.
function destNames(src) {
  const names = new Set();
  const objects = new Set(['values']);
  for (const m of src.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=\s*values\b/g)) {
    for (const part of m[1].split(',')) {
      const bound = /([A-Za-z_$][\w$]*)\s*$/.exec(part.split(':').pop() ?? '');
      if (bound) names.add(bound[1]);
    }
  }
  const bindings = [
    ...src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=([^;\n]*)/g),
    ...src.matchAll(/^\s*([A-Za-z_$][\w$]*)\s*=(?!=)([^;\n]*)/gm),
  ].map((m) => [m[1], m[2]]);
  for (const [name, init] of bindings) {
    if (init.trim() === 'values') objects.add(name);
  }

  const handed = (raw) => {
    const text = withoutStrings(raw);
    return [...objects].some((o) => new RegExp(`\\b${o}[.[]`).test(text))
      || [...names].some((n) => boundary(n).test(text));
  };
  for (let pass = 0; pass <= bindings.length; pass += 1) {
    const before = names.size;
    for (const [name, init] of bindings) {
      if (handed(init)) names.add(name);
    }
    if (names.size === before) break;
  }
  return { names: [...names], handed };
}

function selfWrittenDestinations(src) {
  const { handed } = destNames(src);
  const found = [];
  for (const m of src.matchAll(CALLS)) {
    const line = src.slice(0, m.index).split('\n').length;
    const args = callArgs(src, m.index + m[0].length - 1);
    if (args === null) {
      found.push({ line, call: `${m[1]}(…) — this rule could not read its arguments` });
      continue;
    }
    const dest = args[DESTINATION_ARG[m[1]]];
    if (dest === undefined) continue;
    if (m[1] === 'openSync' && args.slice(1).some((a) => READ_MODE.test(a))) continue;
    if (!handed(dest)) continue;
    found.push({ line, call: `${m[1]}(${dest}, …)` });
  }
  return found;
}

test('no bridge writes a caller-supplied destination itself', () => {
  const dir = path.join(here, '..', 'skills', 'adverse-review', 'scripts');
  const offenders = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.mjs')).sort()) {
    if (file === 'bridge-io.mjs') continue;
    const src = readFileSync(path.join(dir, file), 'utf-8');
    for (const { line, call } of selfWrittenDestinations(src)) {
      offenders.push(`${file}:${line}: ${call}`);
    }
  }
  assert.deepEqual(offenders, [],
    `these replace a file at an output path instead of going through bridge-io:\n  `
    + `${offenders.join('\n  ')}\n`
    + 'Use writeOutput, or makeWriteQueue for a bridge with more than one output:'
    + ' both carry the flags and the exit code.');
});

// collect.mjs is the first bridge whose two destinations come from argv
// independently, and it wrote the source block and then replaced it with the
// file list, at exit 0. Both spellings, because the first version of this
// compared the two strings and `./` walked straight through it — as would a
// `..` that cancels, a doubled slash, or a trailing dot.
for (const [label, filesOut] of [
  ['the same path twice', (dir) => path.join(dir, 'both.json')],
  // Assembled by hand, because `path.join` would normalize it away — and argv
  // does not come from `path.join`.
  ['one path spelled two ways', (dir) => `${dir}/./sub/../both.json`],
]) {
  test(`--out and --files-out naming one file is refused: ${label}`, () => {
    const dir = freshTmp();
    try {
      const dest = path.join(dir, 'both.json');
      writeFileSync(path.join(dir, 'reviewable.mjs'), 'export const x = 1;\n');
      const r = spawnSync(process.execPath,
        [bridgePath('collect'), '--target', dir, '--out', dest,
          '--files-out', filesOut(dir)],
        { encoding: 'utf-8' });

      assert.equal(r.status, 2, `exit ${r.status}: ${r.stdout}${r.stderr}`);
      assert.match(r.stderr, /--out and --files-out name one file/, r.stderr);
      assert.doesNotMatch(r.stderr, /persona/,
        'an argv contradiction is not a payload claiming a persona');
      assert.equal(existsSync(dest), false, 'and neither output is written');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

// And the guard underneath, on the same question. Its callers build their
// destinations from a persona name, so they do not vary the spelling today;
// what makes this worth a line is that the answer must not depend on how the
// caller spelled the directory it joined them onto.
test('the queue compares destinations as paths, not as text', () => {
  const dir = freshTmp();
  try {
    const queue = makeWriteQueue('verify');
    queue.queue(path.join(dir, 'round1-auditor.verified.json'), 'verify-auditor.json', '{}');

    const seen = catchExit(() => queue.queue(
      `${dir}/./sub/../round1-auditor.verified.json`, 'verify-auditor-stale.json', '{}'));

    assert.equal(seen.code, 1, seen.said);
    assert.match(seen.said, /already claimed this run/, seen.said);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The queue's version of the two sentences, in the case where they disagreed
// most: the write fails after its open, the clear fails too, and the outdir
// holds nothing else. Measured before this: `…could not be cleared, so a partial
// file is at that path` immediately followed by `nothing was written`, over a
// file really sitting there at zero bytes. The commit that split those two
// outcomes tested `writeOutput` and not the queue, which is how the queue kept
// the old sentence.
test('the queue does not answer for this file with a sentence about the others',
  { skip: process.getuid?.() === 0 }, () => {
    const dir = freshTmp();
    try {
      const walled = path.join(dir, 'walled');
      mkdirSync(walled);
      const dest = path.join(walled, 'out.json');
      writeFileSync(dest, '{"the previous iteration":true}');
      chmodSync(walled, 0o555);

      const queue = makeWriteQueue('regression');
      queue.queue(dest, 'round1-auditor.json', { not: 'a string' });
      const seen = catchExit(() => queue.flush('wrote'));

      assert.equal(seen.code, 2, seen.said);
      assert.match(seen.said, /could not be cleared, so a partial file is at that path/,
        seen.said);
      assert.match(seen.said, /no other file was written/, seen.said);
      assert.equal(readFileSync(dest, 'utf-8'), '',
        'and that is what is at the path the first sentence is about');
    } finally {
      chmodSync(path.join(dir, 'walled'), 0o700);
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
