// Re-project a finding's position from the commit it was reported against to
// the commit it is being re-checked against.
//
// The problem this solves. A convergence loop reviews, fixes, and re-reviews.
// Between iterations the line numbers move, so "is F3 still open?" cannot be
// answered by comparing `file:line` — the fix itself shifted every line below
// it. Without re-projection the loop re-litigates decisions it already made and
// oscillates instead of converging.
//
// The approach is GitLab's, halved. GitLab addresses a diff comment by a "line
// code", SHA1(path) + old line + new line (gitlab-foss!7298), and then had to
// build Gitlab::Diff::PositionTracer afterward — because baking line numbers
// into the identity string makes it version-scoped by construction, which is
// why their notes go "outdated". So: keep the split between file identity and
// line position, drop the hash. The hash exists to be a DOM id; in a JSON
// ledger the path IS the key, and hashing it only makes the ledger unreadable.
//
// Position moves by hunk arithmetic over `git diff -U0`. Every status the
// tracer can return is listed here, and this list is the contract — a caller
// switching on status has to handle all of them:
//
//   touched       the line lies inside a hunk's OLD range — something changed
//                 right there, which is what a fix looks like
//   untouched     no hunk covers it; the line still exists, at L plus the net
//                 line delta of every hunk before it
//   unanchored    the finding carried no usable line number
//   not-file-bound the finding named no file at all
//   file-only     the file traced, but there was no line to project
//   file-gone     the path is absent at the target commit and no rename
//                 explains it
//   past-eof      the projection landed past the end of the file — the file is
//                 there, the arithmetic is not trustworthy
//   trace-failed  git could not answer. NOT the same as `file-gone`, and the
//                 distinction is load-bearing: a bad ref, a corrupt object, or
//                 a git that is not there at all would otherwise be reported as
//                 "the file was deleted", which reads as evidence of a fix and
//                 silently settles a finding nobody verified.
//
// `untouched` is NOT a verdict that a finding is unfixed. Reviewers cite the
// line where a problem SHOWS, which is routinely not the line where it gets
// FIXED — a caller's bad argument is fixed in the callee, a missing guard is
// fixed at the top of the function. This inherits the doctrine triage already
// applies to `inDiff: "outside"`: it annotates the verifier's question, it
// never answers it.

import { execFileSync } from 'node:child_process';

import { refuseDirectRun } from './entryGuard.mjs';

refuseDirectRun(import.meta.url);

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

// Parse `git diff -U0` output into old/new line ranges. Counts are optional in
// the header and default to 1; a count of 0 means the hunk occupies no lines on
// that side (a pure insertion or a pure deletion).
export function parseHunks(diffText) {
  const hunks = [];
  for (const line of String(diffText).split('\n')) {
    const m = HUNK_RE.exec(line);
    if (!m) continue;
    hunks.push({
      oldStart: Number(m[1]),
      oldCount: m[2] === undefined ? 1 : Number(m[2]),
      newStart: Number(m[3]),
      newCount: m[4] === undefined ? 1 : Number(m[4]),
    });
  }
  return hunks;
}

// Where a hunk ends on the old side. A zero-count hunk covers no old lines;
// its `oldStart` is the line the new content was inserted after, so it sits
// before any line greater than that.
function oldEnd(h) {
  return h.oldCount > 0 ? h.oldStart + h.oldCount - 1 : h.oldStart;
}

// Project `line` through `hunks`. Pure arithmetic — no repo access, so the
// interesting cases are unit-testable without building a git history.
export function projectLine(hunks, line) {
  if (!Number.isInteger(line) || line < 1) return { status: 'unanchored', line: null };

  let delta = 0;
  for (const h of hunks) {
    if (h.oldCount > 0 && line >= h.oldStart && line <= oldEnd(h)) {
      // A hunk that deletes the top of the file has newStart 0 — the position
      // "before line 1" — but a line number is 1-based and 0 would be read as
      // a real anchor five lines from lines 1-5 by the ledger's match window.
      return { status: 'touched', line: Math.max(1, h.newStart), hunk: h };
    }
    if (oldEnd(h) < line) delta += h.newCount - h.oldCount;
  }
  return { status: 'untouched', line: line + delta };
}

const GIT_TIMEOUT_MS = 10_000;

// `core.quotePath=false` on every call, because every path this module reads
// back gets compared against a path a finding cites. With git's default, a path
// with any byte outside ASCII comes back C-quoted and escaped —
// `"src/caf\303\251.py"` for `src/café.py` — so the comparison fails, and it
// fails in the direction that accuses: `unsupportedFixes` reported a real fix
// as touching some other file, and printed the escaped form at the operator.
// Measured. Set here rather than at the one call site that noticed, since
// `followRename` parses paths from git too.
function git(repo, args) {
  return execFileSync('git', ['-c', 'core.quotePath=false', ...args], {
    cwd: repo, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024, timeout: GIT_TIMEOUT_MS,
  });
}

// A ref is read out of the ledger, which is a JSON file on disk that the model
// writes. `git diff "$from..$to"` with a `from` of `--output=path` writes to
// that path and exits 0, so a ref reaches an argument position and has to be
// treated as untrusted input. Two independent guards, because either alone is
// one flag away from being bypassed: the pattern refuses a leading `-` (and
// anything with an `=` in it), and `--end-of-options` stops git parsing the
// value as a flag even if the pattern is later loosened.
const SAFE_REF = /^[0-9A-Za-z][0-9A-Za-z._/~^{}-]*$/;

// Resolve `ref` to a commit SHA, or null when it is unsafe or does not exist.
// Callers pass the SHA to git from then on, so nothing model-supplied reaches
// an argument position at all.
// Memoized: the from/to pair is constant for a whole run, and matchFinding
// traces every ledger entry for every finding, so an unmemoized resolve added
// two `git rev-parse` spawns to each of those. One run over a 19-entry ledger
// measured 282 git processes, 114 of them from here and 57 byte-identical.
const refCache = new Map();

export function resolveRef(repo, ref) {
  if (typeof ref !== 'string' || !SAFE_REF.test(ref)) return null;
  const key = `${repo}\u0000${ref}`;
  if (refCache.has(key)) return refCache.get(key);

  let sha = null;
  try {
    sha = git(repo, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`]).trim() || null;
  } catch {
    sha = null;
  }
  // Failures are cached too, and that reverses an earlier decision here. The
  // old rule — "a ref that does not exist yet must stay resolvable later" —
  // bought nothing any caller can use: every one is a one-shot CLI that creates
  // no ref while it runs, and this memo is process-local, so a ref that appears
  // mid-run is resolvable to the NEXT run either way. What the rule cost is
  // paid per repeat, and the repeat count is model-chosen: `filesChangedIn`
  // consults its own memo only AFTER this resolves, so N decisions naming one
  // bogus sha were N `git rev-parse` spawns. Measured on git 2.55, 300 calls
  // naming one bad sha took 4644 ms against 55 ms for 300 naming a good one.
  // `checkBinding` had already hand-rolled a per-call negative cache over this
  // very function for the same reason, which is the sign that the cache belongs
  // here rather than once per caller.
  //
  // A cached failure is also the safe direction to be wrong in: it reaches
  // `unsupportedFixes` as `unresolved`, that function's loudest branch. Nor is
  // the staleness a new kind — a positive result is already frozen at first
  // resolution, so a symbolic ref like HEAD is already stale once it moves.
  // `clearTraceCaches` is the hook for both.
  refCache.set(key, sha);
  return sha;
}

// Tests that build a repo, resolve a ref, then rewrite history need this, and
// so does any caller that outlives a ref moving or appearing. Named for the
// caches it actually empties: the resolutions above, and the file lists below
// that are keyed on those resolutions and would otherwise outlive them.
export function clearTraceCaches() {
  refCache.clear();
  filesCache.clear();
}

// The paths one commit changed, or a status saying why that cannot be read.
//
// Three-way for the same reason `followRename` is, and the reason is sharper
// here: the caller (`unsupportedFixes`) treats an EMPTY file list as evidence
// that a `fixed` claim is fictional, so every way of failing to read the list
// has to be distinguishable from genuinely having read an empty one. Collapsed
// to `[]` on error, a git that could not run would accuse every fix in the
// batch of being invented.
//
// A rename contributes BOTH of its paths, because the question every caller
// asks is "did this commit touch the file this finding cites" and a commit that
// renames `old.py` did touch `old.py` — it removed it. See `readFilesChanged`
// for how, and for why a COPY contributes only its destination.
//
// A merge is `unknown`, not `ok: []`. `git show --name-only` prints no files
// for a merge unless told which parent to diff against, and choosing one here
// would be this module inventing an answer — a merge genuinely can carry a fix
// this cannot see. The caller reports those and refuses nothing.
//
// `unresolved` is its own status and not a flavor of `failed`, because the two
// call for different things: a git that would not run is a bad afternoon, while
// a ref that names no commit in this repository is a decision that must not
// reach the ledger at all — `checkBinding` refuses the whole ledger on one of
// those from then on, and the ledger is append-only.
//
// Memoized on repo+sha. A folded group decision writes one entry per citation,
// all naming the same `fixCommit`, so a batch asking about one commit ten times
// is the ordinary case and not the pathological one. Measured on ten decisions
// naming one commit: 20 git spawns before, 3 after — the same duplication
// `refCache` above was added to kill, and keyed on the resolved sha so two
// spellings of one commit share the answer.
const filesCache = new Map();

export function filesChangedIn(repo, ref) {
  const sha = resolveRef(repo, ref);
  if (!sha) return { status: 'unresolved', why: `${ref} names no commit in this repository` };

  const key = `${repo} ${sha}`;
  if (filesCache.has(key)) return filesCache.get(key);

  const answer = readFilesChanged(repo, sha);
  // Only settled answers are cached. A git that failed once may be a transient
  // condition, and caching it would make one bad spawn permanent for the run.
  if (answer.status !== 'failed') filesCache.set(key, answer);
  return answer;
}

function readFilesChanged(repo, sha) {
  let parents;
  try {
    parents = git(repo, ['show', '--no-patch', '--format=%P', '--end-of-options', sha]);
  } catch (e) {
    return { status: 'failed', why: `git could not read ${sha}: ${e.message}` };
  }
  if (parents.trim().split(/\s+/).filter(Boolean).length > 1) {
    return { status: 'unknown', why: `${sha} is a merge commit, and its file list depends on `
      + 'which parent it is read against' };
  }

  // `--no-renames`, so that a rename lists BOTH of its paths.
  //
  // With git's rename detection — on by default since 2.9 — `--name-only`
  // prints only the post-image path: a commit that renames `old.py` to `new.py`
  // and edits it prints `new.py` and nothing else. `unsupportedFixes` then
  // answers "that commit does not touch old.py; it touches new.py" about a
  // finding cited at `old.py` whose fix RENAMED that file. That is a false
  // accusation manufactured by the check whose whole job is to catch fictional
  // fixes, which is worse than missing one. Reproduced verbatim on git 2.55.
  //
  // `--name-status` is the other candidate and carries both paths too, as
  // `R097<TAB>old.py<TAB>new.py`. `--no-renames` was taken instead, on three
  // counts, all measured on git 2.55:
  //   - it keeps the output one path per line. `--name-status` needs a parse of
  //     tab-separated rows whose arity varies with the status letter, and of a
  //     similarity score glued to that letter.
  //   - it does not leave the SHAPE of that output to the reader's
  //     `diff.renames`, which decides it three ways: `false` gives `A`/`D` rows,
  //     `true` an `R` row, `copies` `R` and `C` rows. Under `--no-renames` all
  //     three give the same `A`/`D` pair. This module already pins
  //     `core.quotePath` for exactly that reason.
  //   - it never names a path the commit did not change. Under
  //     `diff.renames=copies` a COPY is reported as
  //     `C100<TAB>src.py<TAB>copy.py`, and reading both columns of that row the
  //     way a rename's are read would rest a fix claim on a file the commit only
  //     read. Copy detection only ever draws a source from a file the commit
  //     modified, so under `--no-renames` such a file still appears — as its own
  //     `M` row, which is the truth.
  // Neither candidate prints anything at all for a merge, so neither is what
  // keeps a merge from reading as "changed no file"; the parent count above is.
  try {
    const out = git(repo, ['show', '--name-only', '--format=', '--no-renames', '--end-of-options', sha]);
    return { status: 'ok', files: out.split('\n').map((s) => s.trim()).filter(Boolean) };
  } catch (e) {
    return { status: 'failed', why: `git could not list what ${sha} changed: ${e.message}` };
  }
}

// Follow a rename across the range, so a finding survives a file being moved.
// Returns `{ status: 'ok', path }`, `{ status: 'gone' }`, or
// `{ status: 'failed', why }`. The three-way return is the point: a bare
// `catch { return null }` here reported every git failure as a deleted file,
// and a deleted file reads as evidence that a finding was fixed.
//
// Deliberately NOT pathspec-limited to `file`. Rename detection pairs a
// deletion with an addition, so limiting the diff to the old path hides the
// other half of the pair and every rename reports as a plain delete. The cost
// is a full name-status listing of the range, which is cheap next to being
// wrong about whether a finding's file still exists.
export function followRename(repo, from, to, file) {
  let out;
  try {
    out = git(repo, ['diff', '-M', '--name-status', `${from}..${to}`]);
  } catch (err) {
    return { status: 'failed', why: `git diff ${from}..${to} failed: ${err.message}` };
  }
  for (const row of out.split('\n')) {
    const cols = row.split('\t');
    if (cols.length >= 3 && /^R\d*$/.test(cols[0]) && cols[1] === file) {
      return { status: 'ok', path: cols[2] };
    }
    if (cols.length >= 2 && cols[0] === 'D' && cols[1] === file) return { status: 'gone' };
  }
  return { status: 'ok', path: file };
}

function fileAt(repo, ref, file) {
  try {
    return git(repo, ['show', `${ref}:${file}`]);
  } catch {
    return null;
  }
}

// Trace one anchor from `from` to `to`.
//
// `citedLine`, recorded when the finding was first triaged, is a free
// checksum: if the projected line still holds the same text, the arithmetic
// landed. A mismatch is reported rather than corrected — it usually means the
// line really did change, which is exactly what a verifier wants to know.
export function traceAnchor({ repo, from, to, file, line, citedLine = null }) {
  if (!file) return { status: 'not-file-bound', file: null, line: null };

  const fromSha = resolveRef(repo, from);
  const toSha = resolveRef(repo, to);
  if (fromSha === null || toSha === null) {
    const bad = fromSha === null ? from : to;
    return { status: 'trace-failed', file, line, why: `not a resolvable commit: ${bad}` };
  }

  const renamed = followRename(repo, fromSha, toSha, file);
  if (renamed.status === 'failed') {
    return { status: 'trace-failed', file, line, why: renamed.why };
  }
  if (renamed.status === 'gone') {
    return { status: 'file-gone', file, line: null,
             why: `${file} does not exist at ${to} and no rename explains it` };
  }
  const nowPath = renamed.path;

  const content = fileAt(repo, toSha, nowPath);
  if (content === null) {
    return { status: 'file-gone', file: nowPath, line: null,
             why: `${nowPath} is not readable at ${to}` };
  }

  const out = { file: nowPath, renamedFrom: nowPath === file ? null : file };

  if (line === null || line === undefined) {
    return { ...out, status: 'file-only', line: null };
  }

  let diff = '';
  try {
    diff = git(repo, ['diff', '-U0', '-M', `${fromSha}..${toSha}`, '--', file, nowPath]);
  } catch (err) {
    return { ...out, status: 'trace-failed', line, why: `git diff failed for this path: ${err.message}` };
  }

  const projected = projectLine(parseHunks(diff), line);
  const lines = content.split('\n');
  // A file ending in a newline splits to a trailing '' that is not a line.
  // Counting it made the past-end-of-file guard one line too generous.
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const nowText = projected.line !== null ? (lines[projected.line - 1] ?? null) : null;

  const result = { ...out, status: projected.status, line: projected.line, nowText };

  if (projected.line !== null && projected.line > lines.length) {
    // The file is present — only the arithmetic ran off the end. Reporting
    // that as `file-gone` told the verifier the path had been deleted.
    result.status = 'past-eof';
    result.why = `projected line ${projected.line} is past end of ${nowPath} (${lines.length} lines)`;
    return result;
  }

  if (citedLine !== null && projected.status === 'untouched') {
    result.textMatches = nowText === citedLine;
    if (!result.textMatches) {
      result.why = 'no hunk covers this line, but its text changed anyway — the '
                 + 'projection may be off, or the line moved for a reason git '
                 + 'did not attribute to this path';
    }
  }

  if (projected.status === 'untouched') {
    result.note = 'nothing changed at this line. That does NOT mean the finding is '
                + 'unfixed: reviewers cite where a problem shows, which is often not '
                + 'where it gets fixed. Judge the finding, not the line.';
  }

  return result;
}

// A `traceFor(entry)` for one run, memoized.
//
// `matchFinding` traces every ledger entry for every finding, and `traceAnchor`
// spawns three git processes per call, so the work is entries x findings: 200
// entries against 10 findings measured 602 spawns and 73.7s, with 600 of the
// spawns byte-identical. `from`/`to` are fixed for a whole run — the same
// reasoning `refCache` above already rests on — so an entry's projection is
// answered once.
//
// Both callers need this, and only one of them had it: `converge.mjs` runs once
// at the end, while `triage.mjs` runs on every review and annotates ALL
// findings rather than the blocking subset, so the uncached copy was the hotter
// path (200 entries: 6041 spawns, 191s).
//
// `citedLine` is deliberately NOT in the key: it is a text checksum that never
// influences the projection, so keying on it let entries naming one commit, one
// file and one line cost one trace each.
export function makeAnchorTracer({ repo, to }) {
  const cache = new Map();
  return (entry) => {
    if (!entry.file || !entry.atCommit) return null;
    const key = `${entry.atCommit}\u0000${entry.file}\u0000${entry.line}`;
    if (cache.has(key)) return cache.get(key);
    let traced = null;
    try {
      traced = traceAnchor({
        repo, from: entry.atCommit, to,
        file: entry.file, line: entry.line, citedLine: entry.citedLine,
      });
    } catch {
      traced = null;
    }
    cache.set(key, traced);
    return traced;
  };
}
