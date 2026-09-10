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
// silently. `.` is the other half, in both directions: a tracked name can be a
// property path (`state.out`), where an unescaped dot is a wildcard, and a dot
// BEFORE the name means it belongs to some other object — `\bvalues[.[]`
// matched `other.values.out`, which is not a destination this run was handed.
const quoted = (name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const boundary = (name) => new RegExp(`(?<![\\w$.])${quoted(name)}(?![\\w$])`);
const memberOf = (name) => new RegExp(`(?<![\\w$.])${quoted(name)}\\s*[.[]`);

// Text with its string literals emptied, for asking whether an expression reads
// a caller-supplied path. A tainted NAME inside a literal is not a tainted
// value: probe.mjs builds its patch file under `'adverse-probe-patch.'`, and
// `patch` is a tainted name, so the literal tainted `patchFile` and `patchFile`
// then flagged probe.mjs's own mkdtemp write. `values['files-out']` survives
// this, because the bracket is what the check reads and not the key.
//
// A template literal keeps its INTERPOLATIONS, which are code and not text.
// Emptying one wholesale was the same silent pass in the other direction, on
// the spelling the bridges actually use: repair.mjs, verify.mjs and
// regression.mjs each build a destination as
// `` `${values.outdir}/round2-${agent}.json` ``, so a bare `writeFileSync` of
// one of those — the precise regression this rule exists to catch, and the
// shape six of seven bridges had — read as a constant.
function withoutStrings(text) {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const open = text[i];
    if (open !== '\'' && open !== '"' && open !== '`') {
      out += open;
      continue;
    }
    out += "''";
    for (i += 1; i < text.length; i += 1) {
      if (text[i] === '\\') {
        i += 1;
      } else if (text[i] === open) {
        break;
      } else if (open === '`' && text[i] === '$' && text[i + 1] === '{') {
        // The expression, spaced so it cannot glue itself to a neighbor. Not
        // rescanned: a string inside it is part of the expression, and
        // `values['files-out']` has to survive with its bracket.
        const start = i + 2;
        let depth = 0;
        // Quoted text skipped here too, for the same reason `callArgs` skips
        // it: a brace inside a string is not a brace. Counting them raw,
        // `` `${x['}'] + values.out}` `` closed the interpolation at the quoted
        // `}` and truncated the expression to a constant — which is the silent
        // pass this whole function exists to remove.
        let inner = null;
        for (i += 1; i < text.length; i += 1) {
          if (inner) {
            if (text[i] === '\\') i += 1;
            else if (text[i] === inner) inner = null;
          } else if (text[i] === '\'' || text[i] === '"' || text[i] === '`') {
            inner = text[i];
          } else if (text[i] === '{') {
            depth += 1;
          } else if (text[i] === '}') {
            depth -= 1;
            if (!depth) break;
          }
        }
        out += ` ${text.slice(start, i)} `;
      }
    }
  }
  return out;
}

// The same source with every comment and every regex literal turned to spaces
// — same length, same line breaks, so an offender's line number is still its
// line number — plus the lines where a `/` could not be resolved at all.
//
// Every scan below reads the source as text, and three things in a .mjs file
// look exactly like code without being it. Comments cost two silent passes in
// one commit: one quoting `dest = values.out` above an innocent temporary
// tainted the name, and a comma inside one shifted the destination index, so
// `copyFileSync(tmp, /* to, atomically */ values.out)` reported nothing while
// the same call without the comment was flagged.
//
// A regex literal costs a worse one, because it desynchronizes the scan rather
// than misreading one call. `plan.mjs:85` writes `` `'${s.replace(/'/g,
// "'\\''")}'` ``, and the `'` inside `/'/g` read as a string opener: from that
// line to the end of the file nothing was blanked at all — 39 comment lines in
// that one file — and both directions above went live again after it.
//
// `/` is division after a value and starts a regex everywhere else, and THAT
// discrimination is a heuristic no matter how many cases it lists. Two were
// missing and each was silent: a keyword ends in a word character, so
// `return /'/.test(q)` read as division and desynchronized exactly as
// plan.mjs did; and `i++ / 2` ends in `+`, so a real division started a
// phantom regex that blanked to the end of the file.
//
// So the answer is not only a longer list. A regex literal cannot contain a
// newline — that is a syntax error, not a rare spelling — so a scan that
// reaches one was NOT reading a regex. It stops there, blanks only that line,
// and REPORTS it. That bounds the damage a misreading can do to the line it is
// on, and makes the misreadings nothing closes on that line loud. It does not
// make all of them loud: a phantom regex that finds a second `/` further along
// the same line closes, and blanks what is between in silence. That is the
// residue, and it is why the discrimination is built on the last CODE token
// rather than on a window over the blanked output — see `remember` below.
//
// The list is still worth getting right, because a report on correct code is a
// rule nobody can keep green, and division after `++`, `--` and a decimal
// point is correct code.
const VALUE_BEFORE_SLASH = /(?:[\w$)\]'"`]|\+\+|--|\.)\s*$/;
const KEYWORD_BEFORE_SLASH = /(?<![\w$])(?:return|typeof|case|delete|void|yield|await|new|do|else|in|of|instanceof|throw)\s*$/;

function blankNonCode(src) {
  let out = '';
  const unresolved = [];
  const boundaries = [];
  const lineAt = (i) => src.slice(0, i).split('\n').length;

  // What the last code token was, which is the only question the `/` test
  // asks. NOT a window over `out`: comments blank to same-LENGTH runs of
  // spaces, so any comment of about two dozen characters between a value and a
  // `/` pushed the value out of the window, and a real division read as a
  // regex. Measured both directions on `const half = width /* the halfway
  // point */ / 2;` — a report on correct code, which the real-bridge rule
  // fails on — and on
  // `const rate = count /* per second */ / elapsed; // ops/sec`, where the
  // line comment's `//` closed the phantom and the statement's `;` was blanked
  // in silence.
  //
  // So the tail is built from the characters that ARE code: a blanked comment
  // contributes nothing to it, a run of whitespace contributes one space — so
  // that `a in /re/` is still a keyword and not the word `ain` — and a literal
  // contributes a quote, which the value test accepts because a literal is a
  // value.
  let tail = '';
  const remember = (c) => {
    const t = /\s/.test(c) ? (tail.endsWith(' ') ? '' : ' ') : c;
    tail = (tail + t).slice(-24);
  };
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    if (c === '\'' || c === '"' || c === '`') {
      out += c;
      for (i += 1; i < src.length; i += 1) {
        out += src[i];
        if (src[i] === '\\') {
          out += src[i + 1] ?? '';
          i += 1;
        } else if (src[i] === c) {
          break;
        }
      }
      remember('\'');
      continue;
    }
    // A shebang is a line comment as far as this is concerned, and its slashes
    // are neither operators nor regex delimiters. Every bridge opens with one,
    // so the noisy branch below reported all fifteen of them the moment it
    // existed — which is the branch doing its job on the one input that is not
    // JavaScript at all.
    if ((c === '/' && src[i + 1] === '/') || (i === 0 && c === '#' && src[1] === '!')) {
      while (i < src.length && src[i] !== '\n') {
        out += ' ';
        i += 1;
      }
      out += src[i] ?? '';
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      for (; i < src.length; i += 1) {
        out += src[i] === '\n' ? '\n' : ' ';
        if (src[i] === '*' && src[i + 1] === '/') {
          out += ' ';
          i += 1;
          break;
        }
      }
      continue;
    }
    if (c === '/'
      && (KEYWORD_BEFORE_SLASH.test(tail) || !VALUE_BEFORE_SLASH.test(tail))) {
      const opened = i;
      let inClass = false;
      let closed = false;
      for (; i < src.length && src[i] !== '\n'; i += 1) {
        out += ' ';
        if (src[i] === '\\' && i > opened) {
          out += ' ';
          i += 1;
        } else if (src[i] === '[') {
          inClass = true;
        } else if (src[i] === ']') {
          inClass = false;
        } else if (src[i] === '/' && i > opened && !inClass) {
          closed = true;
          break;
        }
      }
      if (closed) {
        while (/[a-z]/.test(src[i + 1] ?? '')) {
          out += ' ';
          i += 1;
        }
        remember('\'');
      } else {
        // A newline or the end of the file, inside what was read as a regex.
        // No regex reaches either, so this `/` was something else — and the
        // line it is on has just been blanked, so whatever it held is gone
        // from every scan below. Reported, at the line, rather than left to be
        // a hole nobody can see.
        unresolved.push(lineAt(opened));
        i -= 1;
      }
      continue;
    }
    // A statement boundary, as far as anything here needs one: a `;` that is
    // code. Recorded here and nowhere else, which is what keeps the `;` inside
    // a string or a template out — a `;` in a literal is not a boundary, and
    // reading one as a boundary truncated a template-literal right-hand side
    // at its own text.
    if (c === ';') boundaries.push(out.length);
    out += c;
    remember(c);
  }
  let from = 0;
  const statements = [];
  for (const at of boundaries) {
    statements.push(out.slice(from, at));
    from = at + 1;
  }
  statements.push(out.slice(from));
  return { code: out, unresolved, statements };
}

// From the open paren to the paren that closes it, so a nested call in the first
// argument does not truncate the second. Quoted text is skipped, because a
// bracket inside a string is not a bracket — `writeFileSync(values.out, '(' +
// body)` never returns to depth 0 otherwise.
//
// Returns null when it cannot find the close, and the caller reports that as an
// offender rather than skipping it — where one failure mode is silent and the
// other noisy, the answer is not "skip the call this rule exists to read". The
// shape that used to reach it, a regex holding a bracket (`body.replace(/\(/g,
// '')`), is blanked before this ever sees it.
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

// Escapes as well as quotes, which `callArgs` got and this did not: `'it\\'s'`
// closed early, re-opened on the trailing quote and swallowed the comma after
// it, so `renameSync('it\\'s.tmp', values.out)` came back as ONE argument and
// the destination was `undefined`. That is the silent branch — an argument list
// `callArgs` cannot read is reported, one this mis-splits was skipped — and it
// can hide `'r'` from the read-mode exemption as well.
function splitArgs(text) {
  const args = [''];
  let depth = 0;
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quote) {
      args[args.length - 1] += c;
      if (c === '\\') {
        args[args.length - 1] += text[i + 1] ?? '';
        i += 1;
      } else if (c === quote) {
        quote = null;
      }
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
//
// Anchoring the assignment at the start of a line closed that instance and
// left the class: `if (x) { dest = values.out; }`, `} else dest = values.out;`
// and `f(); dest = values.out;` were all still invisible, and so was a
// PROPERTY target — `state.out = values.out` followed by
// `writeFileSync(state.out, body)` — which is why the tracked name may be a
// dotted path. `(?![=>])` keeps `==`, `===` and an arrow out; a `!=` or `<=`
// cannot match, since the character before the `=` must end an identifier.
// Bare destructuring assignment (`({ out } = values)`) is the same claim
// without a keyword, so the keyword is optional.
// A name being given a value, in any of the spellings this repo writes.
//
//   const dest = values.out;          a declaration
//   dest = values.out;                anywhere, not only at a line start
//   dest ||= values.out;              a compound assignment
//   state.out = values.out;           a property target
//   outs[0] = values.out;             a computed-member target
//   const dest = path.join(           a right-hand side that wraps, which
//     values.outdir, name);           this repo does at 80-120 columns
//   const a = 1, dest = values.out;   the second declarator of a list
//   const dest = `${values.outdir}`;  a template literal, which is how this
//                                     directory usually spells a destination
//
// The right-hand side is the hard half, and every wrong answer here has been a
// question about where it ENDS. One unbounded pattern swallowed the statement
// after any `=` not terminated by a `;` — every `for` header's third clause,
// every `while ((m = re.exec(s)) !== null)` — so the binding on the NEXT line
// went untracked, and `triage.mjs` lost two names to one `for` header that
// way. Bounding it at a newline instead lost a right-hand side that wraps.
// Bounding it at a `;`, `{` or `}` in the blanked text lost every right-hand
// side holding one of those inside a literal — a template literal truncated at
// its own `${`, an object literal at its own brace — and that cost 25 tracked
// names across the eight bridges with none gained, which is 25 destinations
// this rule stopped being able to see.
//
// So a right-hand side ends where its STATEMENT does, `blankNonCode` decides
// what a statement is (a `;` that is code, never one inside a literal), and
// every `=` in a statement is read with the rest of that statement as its
// value. Nothing is bounded at a comma or a newline any more.
//
// Reading the rest of the statement over-taints: on
// `const a = 1, dest = values.out` it binds `a` to everything after it, so `a`
// carries `dest`'s value. That is a false offender at worst and it is the
// direction to fail in — the alternative, a comma-bounded right-hand side, was
// the pattern that could not see `path.join(tmpdir(), values.out)` at all.
// What it costs today, measured over the real bridges: `i` in triage.mjs — a
// loop counter, from `for (let i = 0; i < reviews.length; i += 1)` — and `n`
// in converge.mjs, from `const n = Number(rawMax)`. Both tracked, neither a
// path, and no bridge is reported.
//
// One match per `=`, and a `g` regex with a greedy tail could not do that: it
// consumed the statement, so only the FIRST `=` in it was ever read and the
// two shapes above in one line — `const a = 1, dest = path.join(tmpdir(),
// values.out);` — passed silently. The match is the target alone; the value is
// sliced from where the match ends.
//
// `(?![=>])` keeps `==`, `===` and an arrow out. A `!=`, `<=` or `>=` cannot
// match either, because what precedes the `=` must end a name or be one of the
// compound operators listed.
const ASSIGNMENT = new RegExp('(?:(?:const|let|var)\\s+)?'
  + '([A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*|\\[[^\\]\\n]*\\])*)'
  + '\\s*(?:\\|\\||&&|\\?\\?|\\*\\*|<<|>>>?|[-+*/%&|^])?=(?![=>])', 'g');

function destNames(src, statements) {
  const names = new Set();
  const objects = new Set(['values']);
  for (const m of src.matchAll(/(?:const|let|var)?\s*\{([^}]*)\}\s*=\s*values\b/g)) {
    for (const part of m[1].split(',')) {
      // The default goes before the rename does: `const { out = 'x' } = values`
      // ends in a string literal, so reading the trailing identifier bound
      // nothing at all and a bridge spelling its own default got a free pass.
      const named = part.split('=')[0].split(':').pop() ?? '';
      const bound = /([A-Za-z_$][\w$]*)\s*$/.exec(named);
      if (bound) names.add(bound[1]);
    }
  }
  const bindings = statements.flatMap((statement) => [...statement.matchAll(ASSIGNMENT)]
    .map((m) => [m[1], statement.slice(m.index + m[0].length)]));
  for (const [name, init] of bindings) {
    if (init.trim() === 'values') objects.add(name);
  }

  const handed = (raw) => {
    const text = withoutStrings(raw);
    return [...objects].some((o) => memberOf(o).test(text))
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

function selfWrittenDestinations(source) {
  // Every scan below reads this, not `source`: see `blankNonCode`.
  const { code: src, unresolved, statements } = blankNonCode(source);
  const { handed } = destNames(src, statements);
  const found = unresolved.map((line) => ({
    line,
    call: 'a `/` on this line could not be read as a regex or a division,'
      + ' so the line was blanked and nothing on it was scanned',
  }));
  for (const m of src.matchAll(CALLS)) {
    const line = src.slice(0, m.index).split('\n').length;
    const args = callArgs(src, m.index + m[0].length - 1);
    if (args === null) {
      found.push({ line, call: `${m[1]}(…) — this rule could not read its arguments` });
      continue;
    }
    const dest = args[DESTINATION_ARG[m[1]]];
    if (dest === undefined) {
      // Not a skip: this rule knows which argument is the destination, so a
      // call that has no such argument is a call it did not understand, and
      // the direction to fail in is the one that says so.
      found.push({ line, call: `${m[1]}(…) — this rule found no destination argument` });
      continue;
    }
    if (m[1] === 'openSync' && args.slice(1).some((a) => READ_MODE.test(a))) continue;
    if (!handed(dest)) continue;
    found.push({ line, call: `${m[1]}(${dest}, …)` });
  }
  // In line order, whichever scan found them. The unresolved lines are seeded
  // first and the calls appended, so an offender on line 3 was printed above
  // one on line 1 — in a message whose whole purpose is to send someone to a
  // line.
  return found.sort((a, b) => a.line - b.line);
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

// The rule above asserts an empty list over the real bridges, which is exactly
// as strong as the rule's reading and no stronger — a spelling it cannot read
// renders identically to a bridge that does not write its own destination. So
// each source below writes a caller-supplied destination in a spelling that
// once passed, and the rule has to name it.
//
// Named, not merely counted: the third column is the destination the offender
// must be reported as. An argument list this rule mis-parses lands on the
// "no destination argument" branch, which is an offender too — so a count
// alone reads a mis-parse as a catch.
for (const [label, src, dest] of [
  ['a template-literal destination',
    'writeFileSync(`${values.out}`, body, \'utf-8\');', 'values.out'],
  ['a template literal joined onto a destructured outdir',
    'const { outdir } = values;\nwriteFileSync(`${outdir}/round2-x.json`, body);', 'outdir'],
  ['a stream opened on a template literal',
    'createWriteStream(`${values.out}`);', 'values.out'],
  ['a destination after an argument holding an escaped quote',
    'renameSync(\'it\\\'s.tmp\', values.out);', 'values.out'],
  ['a destination assigned inside a branch',
    'let dest = null;\nif (x) { dest = values.out; }\nwriteFileSync(dest, body);', 'dest'],
  ['a destination assigned onto a property',
    'state.out = values.out;\nwriteFileSync(state.out, body);', 'state.out'],
  ['a destination read off an alias whose name starts with $',
    'const $opts = values;\nwriteFileSync($opts.out, body, \'utf-8\');', '$opts.out'],
  ['a destination bound by a bare destructuring assignment',
    'let out;\n({ out } = values);\nwriteFileSync(out, body);', 'out'],
  ['a call whose destination argument is not there at all',
    'renameSync(tmp);', 'no destination argument'],
  // Comments are text that looks exactly like code, and every scan here reads
  // text. A comma inside one shifted which argument the rule called the
  // destination; the same call without the comment was flagged.
  ['a destination behind a comment holding a comma',
    'copyFileSync(tmp, /* to, atomically */ values.out);', 'values.out'],
  ['a destination behind a line comment holding a comma',
    'copyFileSync(tmp, // to, atomically\n  values.out);', 'values.out'],
  // A brace inside a string is not a brace, in an interpolation as anywhere
  // else: counting them raw closed the expression at the quoted `}`.
  ['a destination in an interpolation beside a quoted brace',
    'writeFileSync(`${x[\'}\'] + values.out}`, body);', 'values.out'],
  ['a right-hand side that wraps onto the next line',
    'const dest = path.join(\n  values.outdir, name);\nwriteFileSync(dest, body);', 'dest'],
  ['a compound assignment', 'dest ||= values.out;\nwriteFileSync(dest, body);', 'dest'],
  ['a computed-member target',
    'outs[0] = values.out;\nwriteFileSync(outs[0], body);', 'outs[0]'],
  ['a destructured name with a default of its own',
    'const { out = \'x\' } = values;\nwriteFileSync(out, body);', 'out'],
  // A regex literal is the third thing that looks like code without being it,
  // and the only one that desynchronizes the whole scan: the quote inside
  // `/'/g` — which plan.mjs writes — read as a string opener, and from that
  // line to the end of the file nothing was blanked at all.
  ['a destination behind a comment, after a regex holding a quote',
    'const q = s.replace(/\'/g, \'\');\n'
    + 'copyFileSync(tmp, /* to, atomically */ values.out);', 'values.out'],
  // And the bracket case, which used to be reported as an argument list this
  // rule could not read — the noisy direction, but still not the destination.
  ['a destination beside a regex holding a bracket',
    'writeFileSync(values.out, body.replace(/\\(/g, \'\'));', 'values.out'],
  // Every `=` that is not terminated by a `;` — a `for` header's third clause,
  // a `while ((m = …))` — swallowed the statement after it, so the binding on
  // the next line went untracked.
  ['a destination bound after a for header',
    'for (let i = 0; i < n; i += 1) {\n'
    + '  const dest = values.out;\n  writeFileSync(dest, body);\n}', 'dest'],
  ['a destination bound after a while header',
    'while ((m = re.exec(s)) !== null) {\n'
    + '  const dest = values.out;\n  writeFileSync(dest, body);\n}', 'dest'],
  ['the second declarator of a list',
    'const a = 1, dest = values.out;\nwriteFileSync(dest, body);', 'dest'],
  // Division, not a regex — and reading it as one blanks to the next slash,
  // which erases the binding below and every call after it.
  ['a destination bound after a division',
    'const half = values.width / 2;\n'
    + 'const dest = values.out;\nwriteFileSync(dest, half);', 'dest'],
  // A keyword ends in a word character, so `return /'/.test(q)` read as a
  // division — and then the quote inside the regex opened a string, which is
  // the plan.mjs desynchronization all over again.
  ['a destination behind a comment, after a regex following a keyword',
    'const ok = () => { return /don\'t/.test(q); };\n'
    + 'copyFileSync(tmp, /* to, atomically */ values.out);', 'values.out'],
  // And the other side of the same predicate: `i++ / 2` ends in `+`, so a real
  // division started a phantom regex that blanked to the end of the file.
  ['a destination bound after a division following an increment',
    'const half = i++ / 2;\n'
    + 'const dest = values.out;\nwriteFileSync(dest, half);', 'dest'],
  // A destination supplied as anything but the FIRST argument of its own
  // right-hand side, which is what a right-hand side bounded at a comma could
  // not reach.
  ['a destination bound past a comma in its own argument list',
    'const dest = path.join(tmpdir(), values.out);\nwriteFileSync(dest, body);', 'dest'],
  // Both of those shapes in one line. A greedy right-hand side under a `g`
  // regex consumes the statement, so only the FIRST `=` in it was ever read:
  // `a` was bound to everything after it and `dest` — the name the write uses
  // — was never bound at all.
  ['a second declarator whose value is itself past a comma',
    'const a = 1, dest = path.join(tmpdir(), values.out);\n'
    + 'writeFileSync(dest, body);', 'dest'],
  // A template literal, which is how this directory usually spells a
  // destination, and an object literal. Both were reachable until a `;`, `{`
  // or `}` in the BLANKED text became a statement boundary: `blankNonCode`
  // preserves literals verbatim, so the boundary landed inside the value and
  // truncated it — at `${` here, at the brace below. That cost 25 tracked
  // names across the eight bridges, with none gained.
  ['a destination bound to a template literal',
    'const dest = `${values.outdir}/round2-x.json`;\n'
    + 'writeFileSync(dest, body);', 'dest'],
  ['a destination bound inside an object literal',
    'const opts = { out: values.out };\nwriteFileSync(opts.out, body);', 'opts.out'],
  // And the same boundary inside a plain string, with the caller's path after
  // it — so truncating at the quoted `;` left a value that mentions nothing.
  ['a destination whose value holds a quoted semicolon before the path',
    'const dest = path.join(\'a;b\', values.out);\n'
    + 'writeFileSync(dest, body);', 'dest'],
  // A wrapped right-hand side inside a loop BODY, which is the hole that
  // bounding the right-hand side at a newline opened: every pattern missed it
  // at once. Both halves are shapes in the scanned directory.
  ['a wrapped destination bound inside a while body',
    'while ((m = re.exec(s)) !== null) {\n'
    + '  const dest = path.join(\n    values.outdir, name);\n'
    + '  writeFileSync(dest, body);\n}', 'dest'],
]) {
  test(`the rule reads ${label}`, () => {
    const calls = selfWrittenDestinations(src).map((o) => o.call);
    assert.notDeepEqual(calls, [],
      `this writes a caller-supplied destination and the rule passed it:\n${src}`);
    assert.ok(calls.some((c) => c.includes(dest)),
      `the rule flagged something other than ${dest}: ${calls.join(', ')}`);
    // Every source above is valid JavaScript whose slashes are all resolvable,
    // so the unresolved-slash report below is a wrong answer here even though
    // it is an offender — and without this line a mis-read division renders as
    // a catch, which is how two of these fixtures first passed on a rule that
    // had stopped reading their code at all.
    assert.ok(!calls.some((c) => c.includes('could not be read')),
      `the rule could not read this at all: ${calls.join(', ')}`);
  });
}

// The other side of that: a `/` the rule can resolve neither way. The source is
// deliberately not valid JavaScript, because a slash it CAN resolve is by
// definition not this branch's case. Both halves of the answer are asserted —
// the line is named, and the scan stopped at the newline, so the write below it
// was still read. Blanking on to the next `/` anywhere in the file is what
// silently erased the second one.
test('the rule reports a slash it can read as neither a regex nor a division', () => {
  const calls = selfWrittenDestinations(
    'const r = (/ 2);\n'
    + 'writeFileSync(values.out, readFileSync(\'/tmp/in\'));',
  );
  assert.deepEqual(calls.map((o) => o.line), [1, 2]);
  assert.match(calls[0].call, /could not be read as a regex or a division/);
  assert.match(calls[1].call, /values\.out/);

  // In line order whichever scan found them, which two scans and one list
  // do not give for free: the unresolved lines seed the list and the calls are
  // appended, so this was reported as line 2 above line 1 — in a message whose
  // whole purpose is to send someone to a line.
  const reversed = selfWrittenDestinations(
    'writeFileSync(values.out, body);\n'
    + 'const r = (/ 2);',
  );
  assert.deepEqual(reversed.map((o) => o.line), [1, 2]);
});

// And the other direction, because a rule that flags everything is a rule
// nobody can keep green. Each of these is a real shape in the scanned
// directory, or one line away from one.
for (const [label, src] of [
  // probe.mjs, verbatim in shape: `patch` is a tainted NAME, the mkdtemp prefix
  // is a string that contains it, and `patchFile` is probe.mjs's own temporary.
  ['a temporary named after a string that happens to contain a tainted name',
    'const patchFile = path.join(mkdtempSync(path.join(tmpdir(),'
    + ' \'adverse-probe-patch.\')), \'p.diff\');\n'
    + 'writeFileSync(patchFile, patch, \'utf-8\');'],
  ['a read of a caller-supplied path', 'openSync(values.out, \'r\');'],
  ['a destination off some other object that happens to have a `values`',
    'const notOurs = other.values.out;\nwriteFileSync(notOurs, body);'],
  ['a comparison that is not an assignment',
    'const dest = tmp;\nif (dest === values.out) return;\nwriteFileSync(dest, body);'],
  // A comment between a value and a division. Comments blank to same-LENGTH
  // runs of spaces, so a window over the blanked output could not see the
  // value past one of about two dozen characters: the division read as a
  // regex, found no closing `/` on the line, and this correct code was
  // REPORTED — which is a rule nobody can keep green.
  ['a division whose value is two dozen characters back',
    'const half = width /* the halfway point, in cells */ / 2;\n'
    + 'writeFileSync(tmp, body);'],
  // The same window, exhausted by whitespace instead of by a comment: a
  // continuation line indented past two dozen columns, which is what aligning
  // an argument list does. A run of whitespace is one space in the tail for
  // exactly this reason.
  ['a division whose value is on the line above, indented past the window',
    'const half = width\n'
    + '                           / 2;\nwriteFileSync(tmp, body);'],
  // The other direction of the same finding: a comment is not code, so an
  // assignment quoted in one taints nothing. Unanchoring the assignment scan
  // is what first let it reach inside a comment at all.
  ['a temporary whose comment quotes the shape this rule refuses',
    '// The shape this replaced: dest = values.out, written unguarded.\n'
    + 'const dest = path.join(tmpdir(), \'x\');\nwriteFileSync(dest, body);'],
  ['a block comment quoting the same shape',
    '/* was: state.out = values.out */\n'
    + 'state.out = path.join(tmpdir(), \'x\');\nwriteFileSync(state.out, body);'],
  // The other direction of the regex finding: a false positive, from the same
  // desynchronization, on the same fixture as the control two above.
  ['the same comment, after a regex holding a quote',
    'const q = s.replace(/\'/g, \'\');\n'
    + '// The shape this replaced: dest = values.out, written unguarded.\n'
    + 'const dest = path.join(tmpdir(), \'x\');\nwriteFileSync(dest, body);'],
  // A regex whose character class holds a slash. Ending the literal at that
  // slash leaves `]values.out/g, '')` standing as code, which taints the name
  // the write below uses — a false positive, and the only direction the class
  // tracking is observable in.
  ['a regex whose character class holds a slash',
    'const cleaned = p.replace(/[/]values.out/g, \'\');\n'
    + 'writeFileSync(cleaned, body);'],
]) {
  test(`the rule passes ${label}`, () => {
    assert.deepEqual(selfWrittenDestinations(src), [],
      `this writes nothing a caller supplied and the rule flagged it:\n${src}`);
  });
}

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

test('the queue will not flush a second time', () => {
  // `done` is per-call and `queued` was never drained, so a second flush
  // re-wrote every file under a fresh `done` list: one that succeeded the first
  // time and failed the second printed "no other file was written" over an
  // outdir the first call had filled. Every caller flushes once — which was a
  // comment standing over an exported factory, and a comment is not a guard.
  const dir = freshTmp();
  try {
    const dest = path.join(dir, 'out.json');
    const queue = makeWriteQueue('probe');
    queue.queue(dest, 'payload.json', '{"written":true}');
    queue.flush('wrote');

    const seen = catchExit(() => queue.flush('wrote'));

    assert.equal(seen.code, 2, seen.said);
    assert.match(seen.said, /flush\(\) twice/, seen.said);
    assert.equal(readFileSync(dest, 'utf-8'), '{"written":true}',
      'and the file the first flush wrote is untouched');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the queue refuses a payload handed to it after the flush', () => {
  // `flush` chose the noisy direction for its own second call and left this
  // one silent, which is the worse half: the entry is dropped, and a later
  // `flush` refuses with "outputs are already written" — false about exactly
  // the file nobody wrote.
  const dir = freshTmp();
  try {
    const queue = makeWriteQueue('probe');
    queue.queue(path.join(dir, 'first.json'), 'payload.json', '{}');
    queue.flush('wrote');

    const late = path.join(dir, 'late.json');
    const seen = catchExit(() => queue.queue(late, 'late.json', '{}'));

    assert.equal(seen.code, 2, seen.said);
    assert.match(seen.said, /queued after flush\(\)/, seen.said);
    assert.match(seen.said, /would never be written/, seen.said);
    assert.equal(existsSync(late), false);
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
