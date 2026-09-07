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
  /\bif\s*\(?\s*(!(?!=)|not\b)/,
  /\bunless\b/,
  // Bounded spans, for the reason the SQL signal above gives and by the same
  // shape: an unanchored `.*` before a required literal retries from every
  // position the prefix matches, so both of these were quadratic in line
  // length. Measured on `if (` repeated as ONE removed line — 64 KB 2.2 s,
  // 128 KB 6.9 s, 256 KB 26.7 s, 512 KB 107.4 s, a clean 4x per doubling with
  // execFileSync's 1 MiB maxBuffer the only ceiling. That is minutes of CPU
  // per fix commit inside the Phase 9 loop, on bytes a PR author picks: a
  // commit deleting a vendored or minified file puts them straight onto the
  // removed-line scan. 200 characters is the SQL signal's window; a guard
  // whose `else` is further away than that is not a guard a reader would
  // recognize either.
  /\bguard\b.{0,200}?\belse\b/,
  /\bif\s*\([^\n]{0,200}?\)\s*\{?\s*(throw|return|raise)\b/,
  // The enforcement consequence, at line start (multi-line guard body) or
  // right after an opening brace (`else { throw … }`, `if !ok { return … }`).
  /^\s*(throw|raise)\b/,
  /\{\s*(throw|raise|return)\b/,
  /\bassert\w*\s*\(/i,
  /\b(deny|denied|forbid|forbidden|reject)/i,
  /\b40[13]\b/,
  /\bperms?\b/i, /\brole\b/i, /\badmin/i, /\bowner/i,
];

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
// for), so cost control belongs in the patterns, not in dropping input. The SQL
// signal, the one that was actually super-linear, is bounded by shape now.
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
  const scan = (lines, kind, signals) => {
    for (const line of lines) {
      for (const re of signals) {
        const m = re.exec(line);
        if (!m || seen.has(re.source)) continue;
        seen.add(re.source);
        evidence.push({ kind, signal: re.source, sample: line.trim().slice(0, 120) });
      }
    }
  };
  scan(addedLines(diff), 'content', CONTENT_SIGNALS);
  scan(removedLines(diff), 'content-removed', [...CONTENT_SIGNALS, ...REMOVED_LINE_SIGNALS]);

  // No files at all means we were handed nothing to reason about, which is not
  // the same as having looked and found nothing.
  if (!files.length) {
    return { recommend: 'run', reason: 'no file list to assess; defaulting to run', evidence: [] };
  }

  if (evidence.length) {
    const paths = evidence.filter((e) => e.kind === 'path').length;
    const content = evidence.filter((e) => e.kind === 'content').length;
    const removed = evidence.filter((e) => e.kind === 'content-removed').length;
    return {
      recommend: 'run',
      reason: `trust-boundary signals present (${paths} in paths, ${content} in added code, ${removed} in removed code)`,
      evidence,
    };
  }

  return {
    recommend: 'skip',
    reason: 'no trust-boundary signal in the changed paths, the added lines, or the removed lines',
    evidence: [],
  };
}
