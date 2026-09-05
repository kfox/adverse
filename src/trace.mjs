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

function git(repo, args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
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
  refCache.set(key, sha);
  return sha;
}

// Tests that build a repo, resolve a ref, then rewrite history need this.
export function clearRefCache() {
  refCache.clear();
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
