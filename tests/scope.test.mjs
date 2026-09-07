// Tests for src/scope.mjs — the Adversary lane's budget gate.
//
// The property that matters is the asymmetry: a false positive costs two model
// calls, a false negative ships a vulnerability nobody looked for. So most of
// these check that it errs toward running, and one checks that it can still
// actually skip — a gate that never skips is just an expensive way to say yes.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { assessScope } from '../src/scope.mjs';

const diffOf = (...added) =>
  ['diff --git a/x b/x', '--- a/x', '+++ b/x', '@@ -1 +1 @@', ...added.map((l) => `+${l}`)].join('\n');

test('a diff with no boundary anywhere near it skips', () => {
  const r = assessScope({
    files: ['src/render/palette.mjs', 'src/render/dither.mjs'],
    diff: diffOf('const gamma = 2.2;', 'return pixels.map((p) => p * gamma);'),
  });
  assert.equal(r.recommend, 'skip');
  assert.deepEqual(r.evidence, []);
});

test('a boundary in the path is enough on its own', () => {
  const r = assessScope({ files: ['src/auth/session.js'], diff: diffOf('const x = 1;') });
  assert.equal(r.recommend, 'run');
  assert.equal(r.evidence[0].kind, 'path');
});

test('a dangerous sink in added code is enough on its own', () => {
  const r = assessScope({ files: ['src/render/palette.mjs'], diff: diffOf('el.innerHTML = name;') });
  assert.equal(r.recommend, 'run');
  assert.equal(r.evidence[0].kind, 'content');
});

test('a signal in a REMOVED line counts — a deleted guard is this change\'s doing', () => {
  // Inverted from "a removed sink is somebody else's review": deleting
  // `if (!authorized) throw` is a three-line diff that removes a guard, and a
  // review that skips the Adversary there asserts absence about lines nobody
  // scanned. The cost — this fixture is a security IMPROVEMENT (innerHTML ->
  // textContent) and still runs the lane — is two model calls, the direction
  // the module's bias accepts.
  const diff = ['diff --git a/x b/x', '--- a/x', '+++ b/x', '@@ -1 +1 @@',
                '-el.innerHTML = name;', '+el.textContent = name;'].join('\n');
  const r = assessScope({ files: ['src/render/x.js'], diff });
  assert.equal(r.recommend, 'run');
  assert.equal(r.evidence[0].kind, 'content-removed');
});

test('a removed guard runs the lane on SHAPE, not vocabulary — the attacker picks the vocabulary', () => {
  // The panel's live repros: none names a CONTENT_SIGNALS concept (`perm` is
  // not `permission`), and the first fix's test was caught having been rewritten
  // to fit the pattern list instead of the attack. Shape is what a guard's
  // author cannot cheaply rename away.
  const removedDiff = (...removed) =>
    ['diff --git a/x b/x', '--- a/x', '+++ b/x', '@@ -1 +1 @@', ...removed.map((l) => `-${l}`)].join('\n');
  for (const line of [
    'if (!u.perm[i]) throw new Error(i);',
    'if (!isAdmin(req.user)) return res.status(403).end();',
    'assertOwner(req.user, doc);',
    'if (req.user.role !== "root") return deny();',
    'if (!ok(x)) bail(x);',
    'if not user.can_edit(doc):',
    '    raise Nope()',
    'if !ok { return errNo }',
    'return unless user.can_edit?(doc)',
    'guard user.canEdit(doc) else { throw Nope() }',
  ]) {
    const r = assessScope({ files: ['src/render/widget.js'], diff: removedDiff(line) });
    assert.equal(r.recommend, 'run', line);
    assert.equal(r.evidence[0].kind, 'content-removed', line);
  }
});

test('a removed plain comparison is not a negated guard — `!=` does not read as `!`', () => {
  const removedDiff = (l) =>
    ['diff --git a/x b/x', '--- a/x', '+++ b/x', '@@ -1 +1 @@', `-${l}`].join('\n');
  const r = assessScope({ files: ['src/render/widget.js'], diff: removedDiff('if (a != b) recompute(a);') });
  assert.equal(r.recommend, 'skip', JSON.stringify(r.evidence));
});

test('the guard shapes are minus-side only — added early returns are most of ordinary code', () => {
  const r = assessScope({ files: ['src/render/widget.js'], diff: diffOf('if (!ok(x)) bail(x);') });
  assert.equal(r.recommend, 'skip', JSON.stringify(r.evidence));
});

test('the --- header is not mistaken for a removed line', () => {
  const diff = ['diff --git a/x b/x', '--- a/subprocess.js', '+++ b/x',
                '@@ -1 +1 @@', '-const x = 1;', '+const x = 2;'].join('\n');
  const r = assessScope({ files: ['renderer.js'], diff });
  assert.equal(r.evidence.length, 0);
});

test('the +++ header is not mistaken for an added line', () => {
  const diff = ['diff --git a/auth b/auth', '--- a/subprocess.js', '+++ b/subprocess.js',
                '@@ -1 +1 @@', '+const x = 1;'].join('\n');
  const r = assessScope({ files: ['renderer.js'], diff });
  assert.equal(r.evidence.filter((e) => e.kind === 'content').length, 0);
});

test('an empty file list defaults to running rather than to skipping', () => {
  const r = assessScope({ files: [], diff: '' });
  assert.equal(r.recommend, 'run');
  assert.match(r.reason, /defaulting to run/);
});

test('each path contributes at most one piece of evidence', () => {
  // "auth" and "session" and "cookie" all match this one path.
  const r = assessScope({ files: ['src/auth/session-cookie.js'], diff: '' });
  assert.equal(r.evidence.length, 1);
});

test('each content pattern reports once, however often it fires', () => {
  const r = assessScope({
    files: ['x.js'],
    diff: diffOf('el.innerHTML = a;', 'el.innerHTML = b;', 'el.innerHTML = c;'),
  });
  assert.equal(r.evidence.length, 1);
});

test('the pruned-out common nouns really are gone', () => {
  // These fired on nearly every diff in the first cut. A signal that always
  // fires is not a signal, and this is the test that keeps them from creeping
  // back in.
  const r = assessScope({
    files: ['src/util/files.mjs', 'src/util/paths.mjs', 'src/parse.mjs'],
    diff: diffOf(
      "import { readFileSync, writeFileSync } from 'node:fs';",
      "const data = JSON.parse(readFileSync(f, 'utf-8'));",
      "const m = RE.exec(line);",
      "import { thing } from '../lib/thing.mjs';",
      'const id = crypto.randomUUID();',
    ),
  });
  assert.equal(r.recommend, 'skip', `unexpected evidence: ${JSON.stringify(r.evidence)}`);
});

test('security concepts named outright count, even without a sink', () => {
  for (const line of ['# authenticate the caller', 'const CSP = "Content-Security-Policy";',
                      'const apiKey = env.KEY;', 'if (!hasPermission(u)) return;']) {
    assert.equal(assessScope({ files: ['x.js'], diff: diffOf(line) }).recommend, 'run', line);
  }
});

// --- what the signal scanner must not miss, and must not hang on -------------

test('an added line beginning with ++ is scanned, not mistaken for a header', () => {
  // `+++ b/path` is a header; `+++i;` is the added line `++i;`. Matching the
  // bare `+++` prefix dropped every added line starting with `++` — a silent
  // false negative, and the indentation an attacker would reach for.
  const diff = [
    '--- a/db.js', '+++ b/db.js', '@@ -1 +1,2 @@',
    '+++i; const q = "SELECT " + name + " FROM users";',
  ].join('\n');
  const r = assessScope({ files: ['db.js'], diff });
  assert.equal(r.recommend, 'run');
  assert.ok(r.evidence.some((e) => e.sample.includes('++i;')),
    'the ++ line must reach the scanner');
});

test('the SQL signal does not backtrack catastrophically', () => {
  // `SELECT\s+.*\s+FROM` took 34s on 4,000 spaces and grew ~8x per doubling.
  // The diff is unbounded and attacker-influenced, so this is a real stall.
  const diff = `--- a/x.js\n+++ b/x.js\n@@ -1 +1 @@\n+SELECT${' '.repeat(20000)}\n`;
  const started = Date.now();
  assessScope({ files: ['x.js'], diff });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 1000, `scan took ${elapsed}ms — the regex is backtracking again`);
});

test('the SQL signal still fires on a real query', () => {
  const diff = '--- a/db.js\n+++ b/db.js\n@@ -1 +1 @@\n+  rows = q("SELECT id FROM users WHERE n=" + n)\n';
  const r = assessScope({ files: ['db.js'], diff });
  assert.equal(r.recommend, 'run');
});

test('a sink past column 2000 is still found', () => {
  // The ReDoS fix briefly truncated each scanned line at 2,000 characters,
  // which recreated exactly the false-negative class the `++` fix had just
  // closed: a minified or bundled line is where a payload would sit, and this
  // module's bias is one-directional on purpose — a false positive costs two
  // model calls, a false negative ships a vulnerability nobody looked for.
  const line = 'x'.repeat(3000) + ' child_process.exec(userInput)';
  const diff = `--- a/b.js\n+++ b/b.js\n@@ -1 +1 @@\n+${line}\n`;
  const r = assessScope({ files: ['b.js'], diff });
  assert.equal(r.recommend, 'run');
  // The SINK, by name. `run` and a non-empty `evidence` stopped discriminating
  // when the length backstop landed: 3,000 x's satisfy both on their own, so
  // this test passed with the 2,000-character truncation reintroduced and the
  // `child_process` sink never found — verified by mutation. A test that
  // survives the mutation it exists to catch is worse than no test.
  assert.ok(r.evidence.some((e) => String(e.signal).includes('child_process')),
    'the sink past column 2000 was not found — only the line-length backstop fired');
  assert.ok(r.evidence.every((e) => e.sample.length <= 130),
    'every recorded sample is still clipped');
});

test('scanning a very long line is still fast', () => {
  // Cost control belongs in the patterns, not in dropping input.
  const diff = `--- a/x.js\n+++ b/x.js\n@@ -1 +1 @@\n+SELECT${' '.repeat(200000)}\n`;
  const started = Date.now();
  assessScope({ files: ['x.js'], diff });
  assert.ok(Date.now() - started < 1000, 'a 200k-character line must not stall the scan');
});

// --- the SQL signal was not the only unbounded span --------------------------
// Three more patterns had `.*`/`[^)]*` before a required literal, which is the
// same quadratic shape. Measured on this tree, `if (` repeated as ONE removed
// line: 64 KB 2.2 s, 128 KB 6.9 s, 256 KB 26.7 s, 512 KB 107.4 s — a clean 4x
// per doubling, with execFileSync's 1 MiB maxBuffer the only ceiling, inside a
// loop that runs this per fix commit. A commit deleting a vendored or minified
// file puts a PR author's own bytes on the removed-line scan.

const removedLine = (line) => `--- a/x.js\n+++ b/x.js\n@@ -1 +1 @@\n-${line}\n`;

test('the removed-guard spans do not backtrack catastrophically', () => {
  // Every unit here is repeated to 512 KB as ONE removed line. The second half
  // of the list is one entry per span-bearing pattern, each followed by the
  // padding that makes its own tail ambiguous — because the shape is what
  // repeats, and a list holding only the input somebody happened to report is
  // how `if (…) throw` shipped with the identical bug the entry above it was
  // added for.
  for (const [name, unit] of [
    ['if (…) return', 'if ('],          // the reporter's input, verbatim
    ['guard … else', 'guard x '],
    ['os.path.join(…)', 'os.path.join('],
    // Not a `.*` span but the same class: two quantifiers over the same
    // characters with a nullable atom between them. `\s*\(?\s*` cost 26.9 s at
    // 128 KB of `if` plus padding, and 439 s for the pattern alone at 512 KB.
    ['if + padding', 'if' + ' '.repeat(4095)],
    // The tail of `if (…) throw` was `\)\s*\{?\s*` — the same shape, one
    // pattern lower in the file, and it survived the fix above because the fix
    // only looked at the line it was reported on. 512 KB of this took 3.4 s.
    ['if () + padding', 'if ()' + ' '.repeat(4091)],
    ['guard + padding', 'guard x else' + ' '.repeat(4084)],
    ['os.path.join() + padding', 'os.path.join()' + ' '.repeat(4082)],
    ['SELECT + padding', 'SELECT' + ' '.repeat(4090)],
    ['{ + padding', '{' + ' '.repeat(4095)],
    ['assert + padding', 'assert' + ' '.repeat(4090)],
    ['shell= + padding', 'shell=' + ' '.repeat(4090)],
    ['UPDATE x SET + padding', 'UPDATE x' + ' '.repeat(4088)],
  ]) {
    const body = unit.repeat((512 * 1024) / unit.length);
    const started = Date.now();
    assessScope({ files: ['x.js'], diff: removedLine(body) });
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 1000, `${name}: 512 KB took ${elapsed}ms — the span is unbounded again`);
  }
});

test('the negated-condition signal still reads every spelling it was written for', () => {
  // The bound replaced `\s*\(?\s*` with one class, so the shapes it has to keep
  // matching are worth naming rather than trusting: C family, C family with no
  // space, Go with no parens, Python's keyword, and an indented paren form.
  for (const line of ['if (!ok)', 'if(!ok)', 'if !ok {', 'if not ok:', 'if   (   !ok)']) {
    const r = assessScope({ files: ['src/render/widget.js'], diff: removedLine(line) });
    assert.equal(r.recommend, 'run', line);
    assert.ok(r.evidence.some((e) => e.signal.includes('!(?!=)|not')), line);
  }
  // And still not a plain comparison — `(?!=)` is what makes that hold, and a
  // fixture without it cannot tell this pattern from `/\bif\s*\(/`.
  const plain = assessScope({
    files: ['src/render/widget.js'], diff: removedLine('if (a != b) recompute(a);'),
  });
  assert.equal(plain.recommend, 'skip', JSON.stringify(plain.evidence));
});

test('each bounded span still fires on the guard it was written for, alone', () => {
  // Discriminating fixtures, and that is the whole point of them: every line in
  // the shape test above also trips a second signal (`!`, `{ throw`, `role`,
  // `deny`, `403`), so none of them could tell a bounded pattern from a deleted
  // one. Each line here matches exactly one pattern, named beside it.
  // The expected `signal` is a fragment of the pattern's own source, matched as
  // a plain substring. It names the pattern without quoting the bound, so this
  // test stays about detection and the timing test above stays about the bound.
  // `if\s*\(` alone would be ambiguous — the negated-condition signal
  // `\bif[\s(]*(!…)` contains it too. The fingerprint below is the alternation
  // rather than the span: `\{\s*(throw|raise|return)` orders the same three
  // words differently, so `(throw|return|raise)` names exactly one pattern
  // while quoting neither a bound nor the whitespace tail — both of which have
  // now been rewritten once under this test.
  for (const [line, signal] of [
    ['if (isStale(c)) return cached(c);', '(throw|return|raise)'],
    ['guard let c = cache[k] else fallback(k)', '\\bguard\\b'],
    ['p = os.path.join(base, request.args["f"])', 'os\\.path\\.join'],
  ]) {
    const r = assessScope({ files: ['src/render/widget.js'], diff: removedLine(line) });
    assert.equal(r.recommend, 'run', line);
    assert.equal(r.evidence.length, 1, `${line} must trip exactly one signal, not two`);
    assert.ok(r.evidence[0].signal.includes(signal),
      `${line} tripped ${r.evidence[0].signal}, expected the bounded ${signal}`);
  }
});

// --- the class, read off the file instead of timed --------------------------
// Timing tests pin the inputs somebody thought of. This one pins the shape:
// it parses every regex literal in src/scope.mjs and rejects any where two
// repeatable quantifiers sit over intersecting character sets with nothing but
// nullable atoms between them. That is the whole bug, twice: `\s*\(?\s*` and
// `\)\s*\{?\s*` both let the engine split one run of padding N+1 ways and
// rescan the tail from each split. It is the check that was missing when a
// commit fixed the first and called it "the worst instance in this file" while
// the second sat 14 lines below.

// One representative character per class the patterns use. Set membership is
// computed by running the atom itself, so this never has to reimplement what
// `\s` or `[^)]` means.
const PROBES = [' ', '\t', '\n', 'a', 'A', '0', '_', '(', ')', '{', '}', '[', ']',
                '!', '=', '-', '.', ':', ';', ',', '/', '\\', '"', "'", '*', '?', '<', '>'];

const scopeSource = readFileSync(new URL('../src/scope.mjs', import.meta.url), 'utf-8');

// Regex literals in the signal arrays: indented array elements, comments out.
// The branches must stay disjoint — each excludes what the others admit — or
// extraction itself backtracks exponentially; the child-process test pins it.
const REGEX_LITERAL = /\/(?:\\.|\[(?:\\.|[^\\\]])*\]|[^/\\\s\[])+\/[dgimsuvy]*(?=\s*,|\s*$)/g;

function regexLiterals(source) {
  const found = [];
  for (const line of source.split('\n')) {
    if (!line.startsWith('  ') || line.trimStart().startsWith('//')) continue;
    for (const m of line.matchAll(REGEX_LITERAL)) {
      found.push(m[0]);
    }
  }
  return found;
}

// Split a pattern body into atoms, each carrying its quantifier bounds. A
// group or a lookaround is one opaque atom: these patterns never put a
// quantified group next to a quantified class, and treating one as opaque
// fails toward "not flagged", which the tests above would then catch by timing.
function atomsOf(body) {
  const atoms = [];
  let i = 0;
  while (i < body.length) {
    const start = i;
    const c = body[i];
    if (c === '\\') i += 2;
    else if (c === '[') {
      i += 1;
      if (body[i] === '^') i += 1;
      if (body[i] === ']') i += 1;
      while (i < body.length && body[i] !== ']') i += body[i] === '\\' ? 2 : 1;
      i += 1;
    } else if (c === '(') {
      let depth = 0;
      do {
        if (body[i] === '\\') { i += 2; continue; }
        if (body[i] === '(') depth += 1;
        if (body[i] === ')') depth -= 1;
        i += 1;
      } while (i < body.length && depth > 0);
    } else i += 1;
    const source = body.slice(start, i);
    const quantifierAt = i;

    let min = 1;
    let max = 1;
    const q = /^(?:(\*)|(\+)|(\?)|\{(\d+)(,(\d*))?\})/.exec(body.slice(i));
    if (q) {
      i += q[0].length;
      if (body[i] === '?' || body[i] === '+') i += 1;
      if (q[1]) { min = 0; max = Infinity; }
      else if (q[2]) { min = 1; max = Infinity; }
      else if (q[3]) { min = 0; max = 1; }
      else {
        min = Number(q[4]);
        max = q[5] === undefined ? min : (q[6] === '' ? Infinity : Number(q[6]));
      }
    }
    atoms.push({ source, text: source + body.slice(quantifierAt, i), min, max });
  }
  return atoms;
}

// The set of PROBES a one-character atom matches, or null if the atom is not a
// one-character matcher (a group, or a zero-width assertion).
function charSet(source, flags) {
  if (/^\\[bB]$/.test(source) || source === '^' || source === '$' || source.startsWith('(')) return null;
  const probe = new RegExp(`^(?:${source})$`, flags.replace(/[gy]/g, ''));
  const set = new Set(PROBES.filter((ch) => probe.test(ch)));
  return set.size ? set : null;
}

// The finding: A and B both repeatable, over intersecting sets, with only
// nullable atoms between them.
function ambiguousPairs(literal) {
  const cut = literal.lastIndexOf('/');
  const atoms = atomsOf(literal.slice(1, cut));
  const flags = literal.slice(cut + 1);
  const hits = [];
  for (let a = 0; a < atoms.length; a += 1) {
    const setA = atoms[a].max > 1 ? charSet(atoms[a].source, flags) : null;
    if (!setA) continue;
    for (let b = a + 1; b < atoms.length; b += 1) {
      const between = atoms.slice(a + 1, b);
      if (between.some((x) => x.min > 0)) break;
      const setB = atoms[b].max > 1 ? charSet(atoms[b].source, flags) : null;
      if (setB && [...setA].some((ch) => setB.has(ch))) {
        hits.push(atoms.slice(a, b + 1).map((x) => x.text).join(''));
      }
    }
  }
  return hits;
}

test('the shape checker finds the bug it exists for, and clears the fixed form', () => {
  // Without this the checker could be vacuous — a function that returns [] for
  // everything would pass the sweep below and pin nothing.
  assert.deepEqual(ambiguousPairs(String.raw`/\bif\s*\(?\s*(!(?!=)|not\b)/`), [String.raw`\s*\(?\s*`]);
  assert.deepEqual(
    ambiguousPairs(String.raw`/\bif\s*\([^\n]{0,200}?\)\s*\{?\s*(throw|return|raise)\b/`),
    [String.raw`\s*\{?\s*`],
  );
  assert.deepEqual(ambiguousPairs(String.raw`/\bif[\s(]*(!(?!=)|not\b)/`), []);
  assert.deepEqual(
    ambiguousPairs(String.raw`/\bif\s*\([^\n]{0,200}?\)[\s{]*(throw|return|raise)\b/`), [],
  );
  // Adjacency alone is not the bug; overlapping sets are. `\w*\s*` has one
  // split per position and is linear, and a checker that flagged it would have
  // to be silenced somewhere, which is how a checker stops being read.
  assert.deepEqual(ambiguousPairs(String.raw`/\bassert\w*\s*\(/i`), []);
  assert.deepEqual(ambiguousPairs(String.raw`/\bshell\s*[:=]\s*True\b/i`), []);
});

test('the extractor that finds those patterns is not itself exponential', () => {
  // CodeQL flagged `js/redos` on `regexLiterals`'s own literal, twice, and it
  // was right both times: `[^\]]` admitted the backslash that `\\.` also
  // matched, and the catch-all admitted the `[` that the bracket branch also
  // matched, so each input had two parses to backtrack between (18 escaped
  // backslashes: 119 ms; 22: 43,533 ms). At this attack size the ambiguous form
  // does not run slow, it never returns — so the attack runs in a child with a
  // kill deadline, where "never returns" fails instead of hanging the suite.
  const script =
    'const re = new RegExp(process.argv[1], process.argv[2]);\n' +
    'for (const m of ("  " + process.argv[3]).matchAll(re)) { void m; }';
  for (const attack of ['/[' + '\\\\'.repeat(200), '/' + '[]'.repeat(200)]) {
    const probe = spawnSync(
      process.execPath,
      ['-e', script, REGEX_LITERAL.source, REGEX_LITERAL.flags, attack],
      { timeout: 5000 },
    );
    assert.equal(probe.signal, null, `extracting from ${attack.slice(0, 12)}… was still running at 5 s`);
    assert.equal(probe.status, 0, String(probe.stderr));
  }

  // Control: it still finds what it is for, on the shape it is pointed at.
  assert.deepEqual(regexLiterals('  /\\bsudo\\b/i,\n'), ['/\\bsudo\\b/i']);
});

test('no signal pattern in scope.mjs has two quantifiers over one class', () => {
  const literals = regexLiterals(scopeSource);
  assert.ok(literals.length >= 60, `only ${literals.length} regex literals parsed — the extractor missed the arrays`);
  const offenders = literals
    .map((literal) => [literal, ambiguousPairs(literal)])
    .filter(([, hits]) => hits.length);
  assert.deepEqual(offenders, [],
    `quadratic shape reintroduced: ${offenders.map(([l, h]) => `${l} (${h.join(', ')})`).join('; ')}`);
});

// --- a bound must not turn a slow `run` into a fast `skip` -------------------
// The first pass at the ReDoS above bounded the spans and stopped there, which
// bought speed with silence: a guard padded past the bound matched nothing, and
// "matched nothing" is this module's word for `skip`. Under a bias that accepts
// two wasted model calls to avoid one unreviewed vulnerability, that is a worse
// failure than the stall it replaced, because it is the quiet one.

test('a negation far from its `if` is still a signal — the {0,16} bound erased it', () => {
  // The reported case is 17 characters, one past the bound an earlier fix
  // chose. Every line here stays under SPAN_LIMIT_CHARS, so the unreadable-line
  // backstop cannot be what rescues it: the only thing that can is the pattern
  // itself reading the whole run. A single character class has one greedy path,
  // so it costs nothing to let it.
  for (const gap of [16, 17, 40, 120]) {
    const line = `if${' '.repeat(gap)}(!ok) bail();`;
    assert.ok(line.length <= 200, 'the fixture must not reach the unreadable-line backstop');
    const r = assessScope({ files: ['src/render/widget.js'], diff: removedLine(line) });
    assert.equal(r.recommend, 'run', `${gap}-space gap: ${JSON.stringify(r.evidence)}`);
    assert.ok(r.evidence.some((e) => e.signal.includes('!(?!=)|not')),
      `${gap}-space gap tripped ${JSON.stringify(r.evidence.map((e) => e.signal))}`);
  }
});

test('a guard whose span outruns the bound reaches run as an unreadable line', () => {
  // 300 characters of condition puts `)` past the `{0,200}` window, so the
  // `if (…) throw` pattern genuinely cannot see this guard — and nothing else
  // in either list matches it either (`throw` needs line start or a brace).
  // Before the backstop this returned `skip` with empty evidence.
  const line = `if (${'x'.repeat(300)}) throw new Error(1);`;
  const r = assessScope({ files: ['src/render/widget.js'], diff: removedLine(line) });
  assert.equal(r.recommend, 'run', JSON.stringify(r.evidence));
  assert.deepEqual(r.evidence.map((e) => e.signal), [
    'line over 200 chars — longer than any bounded span can read end to end',
  ]);
  // `unreadable-removed`, not `content-removed`. It used to be filed under the
  // same kind as a real signal, which counted it into "N in removed code" and
  // let src/regression.mjs print "the fix diff crosses a trust boundary" over
  // a line whose only property is its length.
  assert.equal(r.evidence[0].kind, 'unreadable-removed');
  assert.doesNotMatch(r.reason, /trust-boundary signals present/);
});

test('the unreadable-line backstop decides on length, and 200 characters is the line', () => {
  const at = (n) => assessScope({ files: ['src/render/widget.js'], diff: removedLine('x'.repeat(n)) });
  assert.equal(at(200).recommend, 'skip', 'a line the bounded spans can read is still judged on its content');
  assert.deepEqual(at(200).evidence, []);
  assert.equal(at(201).recommend, 'run', 'one character past every span limit is unreadable, not clean');
  assert.match(at(201).evidence[0].signal, /^line over 200 chars/);
});

test('the backstop covers added lines too — SELECT and os.path.join are bounded there as well', () => {
  const added = `--- a/x.js\n+++ b/x.js\n@@ -1 +1 @@\n+${'y'.repeat(400)}\n`;
  const r = assessScope({ files: ['src/render/widget.js'], diff: added });
  assert.equal(r.recommend, 'run', JSON.stringify(r.evidence));
  assert.equal(r.evidence[0].kind, 'unreadable');
  // Was `/1 in added code/` — the assertion that pinned the laundering. The
  // backstop must still reach `run` on an added line, and must not be reported
  // as a trust-boundary signal to get there.
  assert.match(r.reason, /1 line\(s\) ran past the 200-character span limit/);
  assert.doesNotMatch(r.reason, /in added code/);
});

// The length backstop is not a boundary signal. It recommends `run` — that is
// the point of it — but the reason it hands its consumers has to say which of
// the gate's two claims it is, because src/regression.mjs prints one of them to
// an operator as a sentence about a trust boundary.

test('a length-only trigger says so, and does not report a trust-boundary signal', () => {
  // The reviewer's own fixture: 224 characters of ordinary README prose, with
  // no signal from any list anywhere in it. Before this, `reason` read
  // "trust-boundary signals present (0 in paths, 1 in added code, 0 in removed
  // code)" — a sentence in which every clause is false.
  const prose = `Amend the scope gate description so that it says what is true of the length `
    + 'backstop, because the sentence it replaces described a gate that only ever matched '
    + 'patterns and that is no longer the gate this repository ships to anybody at all.';
  assert.ok(prose.length > 200 && prose.length < 240, `fixture is ${prose.length} chars`);
  const r = assessScope({ files: ['README.md'], diff: diffOf(prose) });

  assert.equal(r.recommend, 'run', 'an unreadable line is still evidence in its own right');
  assert.equal(r.trigger, 'unreadable');
  assert.doesNotMatch(r.reason, /trust-boundary signals present/);
  assert.match(r.reason, /^no trust-boundary signal, but 1 line\(s\) ran past the 200-character/);
  assert.deepEqual(r.evidence.map((e) => e.kind), ['unreadable']);
});

test('a real signal beside a long line still reports the boundary, and does not count the line', () => {
  // Both at once. The boundary claim is true here and has to survive, but the
  // counts in it are counts of boundary signals: reporting "2 in added code"
  // for one signal and one long line is the same laundering one step along.
  const diff = diffOf('const password = load();', 'x'.repeat(300));
  const r = assessScope({ files: ['src/render/widget.js'], diff });

  assert.equal(r.trigger, 'boundary');
  assert.match(r.reason, /^trust-boundary signals present \(0 in paths, 1 in added code, 0 in removed code\)/);
  assert.match(r.reason, /1 line\(s\) also ran past the 200-character span limit/);
  assert.equal(r.evidence.filter((e) => e.kind === 'unreadable').length, 1);
});

test('every line past the limit is counted, not just the first one recorded', () => {
  // `record` deduplicates on the signal, so `evidence` holds one unreadable
  // entry however many long lines there are. A count read off `evidence` could
  // therefore only ever say "1", which would understate a minified diff.
  const r = assessScope({
    files: ['bundle.js'],
    diff: `--- a/bundle.js\n+++ b/bundle.js\n@@ -1 +3 @@\n+${'a'.repeat(260)}\n`
      + `+${'b'.repeat(260)}\n-${'c'.repeat(260)}\n`,
  });

  assert.equal(r.trigger, 'unreadable');
  assert.match(r.reason, /but 3 line\(s\) ran past the 200-character span limit/);
});

test('the skip and no-file-list answers carry a trigger too, so no consumer has to guess', () => {
  // Every return path names its trigger. One that did not would read as
  // `undefined` in src/regression.mjs, which refuses a trigger it cannot word
  // rather than defaulting to a sentence about a boundary.
  assert.equal(assessScope({ files: ['src/render/x.js'], diff: diffOf('const a = 1;') }).trigger,
    'none');
  assert.equal(assessScope({ files: [], diff: '' }).trigger, 'no-file-list');
  assert.equal(assessScope({ files: ['src/auth/session.js'], diff: '' }).trigger, 'boundary');
});
