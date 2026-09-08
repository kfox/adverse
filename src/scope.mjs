// Does this change have a trust boundary in it?
//
// The Adversary's yield is lumpy in a way the other lanes' is not. On a change
// that touches a control plane it is the most valuable reviewer on the panel;
// on a pure rendering or refactoring change it has nothing to look at and
// spends two model calls saying so. Deciding that mechanically is what pays
// for a fourth persona.
//
// The bias is deliberate and one-directional: a false positive costs two model
// calls, a false negative ships a vulnerability nobody looked for. So this
// recommends running unless it can find NO evidence at all, the patterns are
// deliberately over-broad, and anything unreadable counts as evidence.
//
// It is a budget hint, never a security judgment. It cannot know that an
// innocuous-looking helper is called from an auth path. The orchestrator must
// say out loud when a lane was skipped, and the report must show it — an
// unmentioned skipped lane reads exactly like a clean review.

import { refuseDirectRun } from './entryGuard.mjs';

refuseDirectRun(import.meta.url);

// Path fragments that put a change near a boundary. Matched against the whole
// repo-relative path, lowercased.
//
// Pruned hard, and the pruning is the point. The first cut of this list held
// `file`, `path`, `parse`, `user`, and `db`, which match most paths in most
// repositories — and a signal that fires on every change carries no
// information, it just launders "always run" into something that looks like a
// decision. Everything here names a boundary rather than a common noun.
const PATH_SIGNALS = [
  'auth', 'login', 'logout', 'session', 'credential', 'password', 'secret', 'token',
  'crypto', 'cipher', 'cert', 'tls', 'ssl', 'signature',
  'permission', 'privile', 'acl', 'admin', 'tenant',
  'cors', 'csrf', 'cookie', 'header', 'sandbox',
  'server', 'route', 'handler', 'endpoint', 'socket', 'http',
  'upload', 'download', 'sanitiz', 'escap',
  'sql', 'deserial', 'pickle', 'subprocess', 'shell',
];

// Content patterns, matched against ADDED and REMOVED lines — an UNCHANGED
// sink is somebody else's review, but a removed line is this change's doing:
// deleting `if (!authorized) throw` is a three-line diff that removes a guard,
// and the false positive on the other side (removing a sink, a security
// improvement) costs two model calls under the stated bias. Same pruning rule: `open(`, `exec(`, `readFile`,
// `JSON.parse`, and a bare `../` all fired on essentially every diff, the last
// three on ordinary imports, so they are gone. What remains either names a
// dangerous sink or names a security concept outright.
const CONTENT_SIGNALS = [
  /\bsubprocess\b/i, /\bos\.system\b/, /\bpopen\b/i, /\bchild_process\b/,
  /\bexecFile(Sync)?\b/, /\bspawn(Sync)?\b/, /\bshell\s*[:=]\s*True\b/i,
  /\beval\s*\(/, /\bnew\s+Function\b/, /\bvm\.run/,
  /\bpickle\b/i, /yaml\.(unsafe_)?load\b/, /\bObjectInputStream\b/, /\bMarshal\.load\b/,
  /innerHTML/, /dangerouslySetInnerHTML/, /document\.write/, /\bv-html\b/,
  // `SELECT\s+.*\s+FROM` backtracks catastrophically: three adjacent
  // quantifiers over overlapping classes, so a line of 4,000 spaces after
  // SELECT (and no FROM) took 34 seconds, growing ~8x per doubling. The diff
  // this scans is attacker-influenced and unbounded, so the shape is the bug.
  // A bounded, non-overlapping span between two literals is linear enough.
  /\bSELECT\b.{0,200}?\bFROM\b/is,
  /\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|DROP\s+TABLE)\b/i,
  /\bcursor\.execute\b/, /\bdb\.(query|execute)\b/, /\braw\s*\(/,
  /\burlopen\b/, /\brequests\.(get|post|put|delete|patch)\b/, /\baxios\./,
  /\bsocket\.(socket|connect|accept)\b/, /\bcreateServer\b/,
  /\bpassword\b/i, /\bsecret\b/i, /\bapi[_-]?key\b/i, /\bbearer\b/i,
  /\baccess[_-]?token\b/i, /\bprivate[_-]?key\b/i,
  /\bhmac\b/i, /\bhashlib\b/, /\bmd5\b/i, /\bsha1\b/i, /\bcompare_digest\b/,
  /Content-Security-Policy/i, /Access-Control-/i, /X-Frame-Options/i, /SameSite/i,
  /\bchmod\b/, /\bchown\b/, /\bsetuid\b/, /\bsudo\b/,
  // `[^)]*` is the same unbounded-span-before-a-required-literal shape as the
  // two bounded signals in REMOVED_LINE_SIGNALS below, and it is quadratic for
  // the same reason: on `os.path.join(` repeated with no `)` and no argument
  // name, every one of those prefixes retries the whole tail. Measured alone:
  // 64 KB 0.5 s, 128 KB 1.9 s, 256 KB 7.8 s. Worse exposure than its two
  // siblings, because CONTENT_SIGNALS is scanned against ADDED lines as well
  // as removed ones.
  /\bos\.path\.join\s*\([^)]{0,200}?\b(request|input|arg|param|user)/i,
  // No leading \b: these have to match camelCase call sites too, and
  // `\bpermission` does not match `hasPermission`.
  /authenticat/i, /authoriz/i, /permission/i, /sanitiz/i, /credential/i,
];

// Signals scanned against REMOVED lines only. CONTENT_SIGNALS names sinks and
// security vocabulary, but a deleted guard needs neither: `if (!u.perm[i])
// throw` removes enforcement without naming a single concept on that list,
// and the attacker picks the vocabulary. These match the SHAPE of enforcement
// instead — a negated-condition check, a one-line guard, a thrown refusal, an
// assertion, refusal words, HTTP deny codes — because removing enforcement is
// exactly the Adversary's business regardless of what the guard was called.
// They stay off the added-line scan, where `if (!x) return` is most of
// ordinary code and the signal would launder "always run" into a decision.
// No static list survives a determined author — the deleted-lines floor and
// the pins are the backstops — but shape is what the author cannot cheaply
// rename away.
const REMOVED_LINE_SIGNALS = [
  // Negated-condition check, in the mainstream spellings: `if (!x` (C
  // family), `if !ok` (Go, no parens), `if not x` (Python), and the
  // keyword-inverted forms — Ruby's `unless` and Swift's `guard … else` ARE
  // negated conditionals with no `!`/`not` token to match. `(?!=)` keeps a
  // plain `if (a != b)` comparison from reading as a negated guard; the
  // paren-required version alone missed the Python and Go guards verbatim.
  //
  // ONE class where this read `\s*\(?\s*`. Two quantifiers over the same
  // characters with a nullable atom between them is the "adjacent quantifiers
  // over overlapping classes" the SQL signal above was rewritten for: the
  // engine can split one run of padding N+1 ways and rescan the tail from each
  // split, so a removed line of `if` plus padding cost 0.4 s at 16 KB, 1.7 s at
  // 32 KB, 6.7 s at 64 KB and 26.9 s at 128 KB — 4x per doubling.
  //
  // It was NOT, as an earlier revision of this comment claimed, "the worst
  // instance in this file": the `if (…) throw` span below carried the identical
  // `\)\s*\{?\s*` tail and measured the same 4x curve on the same input shape
  // (420 ms / 1672 ms / 6690 ms / 26756 ms at 16/32/64/128 KB, end to end
  // through assessScope) until it was collapsed the same way. Both are fixed
  // here; a static shape check in tests/scope.test.mjs now enumerates the whole
  // file for the pattern instead of trusting a claim like that one.
  //
  // One class has one greedy path, so it needs no ceiling at all — 512 KB of
  // padding costs 2 ms unbounded. The `{0,16}` an earlier fix added alongside
  // the class was therefore pure false negative: `if` + 16 spaces + `(!ok)`
  // needs 17 characters from the class and so stopped counting as a signal at
  // all, which turns a slow `run` into a fast `skip` and inverts the bias this
  // module is built on.
  /\bif[\s(]*(!(?!=)|not\b)/,
  /\bunless\b/,
  // Bounded spans, for the reason the SQL signal above gives and by the same
  // shape: an unanchored `.*` before a required literal retries from every
  // position the prefix matches, so both of these were quadratic in line
  // length. Measured on `if (` repeated as ONE removed line — 64 KB 2.2 s,
  // 128 KB 6.9 s, 256 KB 26.7 s, 512 KB 107.4 s, a clean 4x per doubling with
  // execFileSync's 1 MiB maxBuffer the only ceiling. That is minutes of CPU
  // per fix commit inside the Phase 9 loop, on bytes a PR author picks: a
  // commit deleting a vendored or minified file puts them straight onto the
  // removed-line scan. 200 characters is the SQL signal's window, and a line
  // long enough for that window to hide something is caught by
  // SPAN_LIMIT_CHARS below instead, so the bound costs model calls rather than
  // detection.
  /\bguard\b.{0,200}?\belse\b/,
  // The tail is one class, `\)[\s{]*`, and not `\)\s*\{?\s*`, for the reason
  // the negated-condition signal above gives: bounding the span in FRONT of
  // `\)` does nothing about a nullable atom between two whitespace quantifiers
  // behind it. Measured end to end through assessScope on `'if ()' +
  // ' '.repeat(N)` as one removed line: 16 KB 420 ms, 32 KB 1672 ms, 64 KB
  // 6690 ms, 128 KB 26756 ms. The single class is 2 ms at 512 KB and matches
  // strictly more than the old tail (any run of braces and space, not one
  // brace), which is the direction the bias wants.
  /\bif\s*\([^\n]{0,200}?\)[\s{]*(throw|return|raise)\b/,
  // The enforcement consequence, at line start (multi-line guard body) or
  // right after an opening brace (`else { throw … }`, `if !ok { return … }`).
  /^\s*(throw|raise)\b/,
  /\{\s*(throw|raise|return)\b/,
  /\bassert\w*\s*\(/i,
  /\b(deny|denied|forbid|forbidden|reject)/i,
  /\b40[13]\b/,
  /\bperms?\b/i, /\brole\b/i, /\badmin/i, /\bowner/i,
];

// The widest span any signal above can read end to end. Those `{0,200}` bounds
// are what keep the spans linear on bytes a PR author picks, and the price of
// every one of them is the same blind spot: a guard whose two halves sit
// further apart than this matches nothing, so a padded or minified line reads
// back as "no signal" — a slow `run` quietly converted into a fast `skip`,
// which inverts the one-directional bias this whole module is built on.
//
// So a line too long for the bounds to read is evidence in its own right
// ("anything unreadable counts as evidence", at the top of this file). That
// closes the class rather than any one bound: exceeding ANY span limit can
// now only cost model calls, never silence, whichever pattern the line
// defeated. It is deliberately the noisy direction, and cheaply so: 52 lines
// of this repository's own tracked files run past 200 characters, 34 of them
// in one README, while a commit deleting a vendored or minified file — the
// case where the bounds really do go blind — is exactly the one where nobody
// can claim to have looked.
//
// It is evidence of its OWN kind, though, and not one more boundary signal.
// Reported as `content` it was counted into "trust-boundary signals present (0
// in paths, 1 in added code, 0 in removed code)", which src/regression.mjs
// rendered to an operator as "the fix diff crosses a trust boundary" — for a
// README-only commit whose single added line was 211 characters of ordinary
// prose. Both halves of that sentence were false, and a gate that fires on 39
// lines of this repository's own README cannot be allowed to assert a boundary
// on any of them: that is the same laundering of "always run" into a decision
// that PATH_SIGNALS above was pruned to avoid.
const SPAN_LIMIT_CHARS = 200;
const UNREADABLE_LINE_SIGNAL =
  `line over ${SPAN_LIMIT_CHARS} chars — longer than any bounded span can read end to end`;

// Which of the gate's several reasons for its answer this one is — the
// machine-readable half of `reason`, because `reason` now carries more than
// one claim and a consumer that wants to word them differently should not have
// to re-derive the difference from a prose string or from `evidence`.
//
// `boundary` and `unreadable` are the distinction this exists for: a boundary
// signal is a positive fact about the change, an unreadable line is only the
// absence of knowledge about one. `no-file-list` is a third, wider absence —
// nothing was read at all, not even a path. All three recommend `run`; only
// the first is a boundary.
export const SCOPE_TRIGGER = Object.freeze({
  boundary: 'boundary',
  unreadable: 'unreadable',
  noFileList: 'no-file-list',
  none: 'none',
});

// The two halves of `evidence`: kinds that name a trust-boundary signal, and
// kinds that name a line no bounded span could read. The counts in the boundary
// `reason` are taken over the first, so an unreadable line cannot inflate them.
//
// Both are written out, rather than one being the complement of the other,
// because each single list is a different silent failure for a kind somebody
// adds later and forgets: as an allowlist of boundary kinds, a stray kind falls
// out of both counts and can return `skip` over non-empty evidence — the
// silence this whole module is built against; as a denylist it is reported as a
// trust-boundary signal, which is exactly the claim this change removed. With
// both, the partition is checked and a stray kind is loud.
const BOUNDARY_KINDS = Object.freeze(['path', 'content', 'content-removed']);
const UNREADABLE_KINDS = Object.freeze(['unreadable', 'unreadable-removed']);

// Lines a unified diff adds. The `+++ b/path` header is not an added line —
// but `+++i;` IS, and matching the bare `+++` prefix silently dropped every
// added line starting with `++`, which is exactly what an attacker would
// indent their payload with. The header always has the trailing space.
//
// The whole line is scanned. An earlier version truncated here at 2,000
// characters, which quietly recreated the same class of false negative it was
// added alongside: a dangerous sink past column 2,000 of a minified or bundled
// line — precisely where a payload would sit — was never shown to the Adversary
// lane. This module's bias is one-directional on purpose (a false positive
// costs two model calls; a false negative ships a vulnerability nobody looked
// for), so cost control belongs in the patterns, not in dropping input. Every
// pattern that was super-linear is bounded by shape now, and SPAN_LIMIT_CHARS
// above keeps those bounds from silently costing detection.
export function addedLines(diffText) {
  return String(diffText).split('\n')
    .filter((l) => l.startsWith('+') && !l.startsWith('+++ '))
    .map((l) => l.slice(1));
}

// Same header rule on the minus side: `--- a/path` always has the trailing
// space, `---x` is a removed line.
export function removedLines(diffText) {
  return String(diffText).split('\n')
    .filter((l) => l.startsWith('-') && !l.startsWith('--- '))
    .map((l) => l.slice(1));
}

export function assessScope({ files = [], diff = '' } = {}) {
  const evidence = [];

  for (const file of files) {
    const lower = String(file).toLowerCase();
    for (const signal of PATH_SIGNALS) {
      if (lower.includes(signal)) {
        evidence.push({ kind: 'path', signal, file });
        break;
      }
    }
  }

  const seen = new Set();
  const record = (kind, signal, line, key = signal) => {
    if (seen.has(key)) return;
    seen.add(key);
    evidence.push({ kind, signal, sample: line.trim().slice(0, 120) });
  };
  // Every line over the limit is counted, not just the first — `record`
  // deduplicates on the key, so `evidence` holds at most one unreadable
  // entry per scan and a reason built from its length could only ever say
  // "1 line". The comparison is already made per line, so the count is free.
  // The length signal keys per KIND where the patterns key globally: a removed
  // over-long line is the bulk-deletion case the backstop exists for, and an
  // added one earlier in the diff must not swallow it.
  let unreadable = 0;
  const scan = (lines, { kind, unreadableKind, signals }) => {
    for (const line of lines) {
      if (line.length > SPAN_LIMIT_CHARS) {
        unreadable += 1;
        record(unreadableKind, UNREADABLE_LINE_SIGNAL, line,
          `${unreadableKind}:${UNREADABLE_LINE_SIGNAL}`);
      }
      for (const re of signals) {
        // A pattern that already fired cannot add evidence, and re-running it
        // down every remaining line of a minified diff is the bulk of the cost.
        if (!seen.has(re.source) && re.test(line)) record(kind, re.source, line);
      }
    }
  };
  scan(addedLines(diff), {
    kind: 'content', unreadableKind: 'unreadable', signals: CONTENT_SIGNALS,
  });
  scan(removedLines(diff), {
    kind: 'content-removed',
    unreadableKind: 'unreadable-removed',
    signals: [...CONTENT_SIGNALS, ...REMOVED_LINE_SIGNALS],
  });

  // No files at all means we were handed nothing to reason about, which is not
  // the same as having looked and found nothing.
  if (!files.length) {
    return {
      recommend: 'run',
      trigger: SCOPE_TRIGGER.noFileList,
      reason: 'no file list to assess; defaulting to run',
      evidence: [],
    };
  }

  const stray = evidence.find(
    (e) => !BOUNDARY_KINDS.includes(e.kind) && !UNREADABLE_KINDS.includes(e.kind));
  /* c8 ignore next 4 */
  if (stray) {
    throw new Error(`scope: evidence kind ${JSON.stringify(stray.kind)} is neither a`
      + ' trust-boundary signal nor an unreadable line, so it can be neither counted nor'
      + ' reported');
  }

  const boundaries = evidence.filter((e) => BOUNDARY_KINDS.includes(e.kind));
  const unreadableClause = unreadable
    ? `; ${unreadable} line(s) also ran past the ${SPAN_LIMIT_CHARS}-character span limit`
    : '';

  if (boundaries.length) {
    const paths = boundaries.filter((e) => e.kind === 'path').length;
    const content = boundaries.filter((e) => e.kind === 'content').length;
    const removed = boundaries.filter((e) => e.kind === 'content-removed').length;
    return {
      recommend: 'run',
      trigger: SCOPE_TRIGGER.boundary,
      reason: `trust-boundary signals present (${paths} in paths, ${content} in added code,`
        + ` ${removed} in removed code)${unreadableClause}`,
      evidence,
    };
  }

  // The backstop and nothing else. Still `run` — that part of the change was
  // right, and an unreadable line is evidence in its own right — but the reason
  // says which of the gate's two claims this is, so no consumer has to guess
  // and none of them can print the other one.
  if (unreadable) {
    return {
      recommend: 'run',
      trigger: SCOPE_TRIGGER.unreadable,
      reason: `no trust-boundary signal, but ${unreadable} line(s) ran past the`
        + ` ${SPAN_LIMIT_CHARS}-character span limit and could not be read end to end`,
      evidence,
    };
  }

  return {
    recommend: 'skip',
    trigger: SCOPE_TRIGGER.none,
    reason: 'no trust-boundary signal in the changed paths, the added lines, or the removed lines',
    evidence: [],
  };
}
