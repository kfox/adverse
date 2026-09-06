// Pure triage logic: claim-checking, kind-anchoring, and finding clustering.
//
// This used to live entirely inside the Skill bridge
// (skills/adverse-review/scripts/triage.mjs), which put ~330 lines of domain
// logic somewhere no unit test could reach without spawning a subprocess and a
// throwaway git repo for every case. It also meant `changedRanges` below
// carried its own hunk-header regex, duplicating the parser trace.mjs already
// exports (`parseHunks`) for the exact same `git diff -U0` format — and the
// two had already drifted once, which is how an off-by-one between them
// entered the same review this split was filed from.

import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

import { closeQuietly, openRegularFileSync } from './fsSafe.mjs';
import { ADVISORY_KINDS, SEVERITIES, SEVERITY_RANK } from './taxonomy.mjs';
import { parseHunks } from './trace.mjs';

export const CLUSTER_WINDOW_LINES = 15;

// A reviewer payload is LLM output — this tool's explicitly untrusted input.
// `validatePhase1` establishes that severity/title/detail/kind are PRESENT and
// that the two enums are in range; it says nothing about the type of `line`,
// `file`, `counterpart` or `detail`, and every anchor sink below assumed one
// anyway. Two of those sinks crashed the bridge on a value a model produces by
// accident (`"line": "105)"`), and two worse ones returned `status: 'ok'` on a
// value nobody checked — a mechanically-verified anchor minted out of a
// string. Normalizing once at ingest is the fix; the fail-closed guards in
// `checkKind`, `insideRepo` and `checkClaim` are the backstop for a caller
// that skips it.
export function isAnchorLine(line) {
  return Number.isInteger(line) && line > 0;
}

const ANCHOR_STRINGS = ['file', 'counterpart', 'fix'];

const asString = (v) => (typeof v === 'string' && v ? v : null);

const wasSupplied = (v) => v !== null && v !== undefined;

// The anchor fields coerced to the types every sink assumes, plus `rejected`:
// the names of the fields whose supplied value was unusable. The caller
// reports that list rather than swallowing it — an anchor silently coerced to
// null is indistinguishable from one the reviewer never gave, and those two
// deserve different reactions from whoever reads the run.
export function normalizeAnchor(f) {
  const anchor = {
    line: isAnchorLine(f.line) ? f.line : null,
    detail: typeof f.detail === 'string' ? f.detail : '',
  };
  for (const k of ANCHOR_STRINGS) anchor[k] = asString(f[k]);

  const rejected = ANCHOR_STRINGS.filter((k) => wasSupplied(f[k]) && anchor[k] === null);
  if (wasSupplied(f.line) && anchor.line === null) rejected.push('line');
  if (wasSupplied(f.detail) && typeof f.detail !== 'string') rejected.push('detail');

  return { ...anchor, rejected };
}


// What each kind promises about its own anchoring. Checked, not enforced: a
// finding that does not keep its kind's promise is ANNOTATED as
// under-anchored, never dropped — the reporter may have found something real
// and merely labeled it carelessly, and only a reviewer can tell those apart.
// Null prototype: `kind` is reviewer-supplied, and a plain object answers
// `constructor` and `toString` with something truthy — so `KIND_REQUIREMENTS[kind]`
// found a "requirement" for a kind that does not exist and skipped the
// UNKNOWN branch that exists to treat it as blocking. Same class as the
// `VALIDATORS` lookup in scripts/validate.mjs; this is the second site.
const KIND_REQUIREMENTS = Object.assign(Object.create(null), {
  defect:     { file: true, line: true,  counterpart: false },
  behavioral: { file: true, line: false, counterpart: false },
  contract:   { file: true, line: false, counterpart: true  },
  design:     { file: false, line: false, counterpart: false },
});

export function checkKind(kind, file, line, counterpart, { advisoryKinds = ADVISORY_KINDS } = {}) {
  if (kind === undefined || kind === null || kind === '') {
    return { status: 'MISSING', why: 'no `kind` on this finding; it is treated as blocking' };
  }
  const req = KIND_REQUIREMENTS[kind];
  if (!req) {
    return { status: 'UNKNOWN', kind, why: `unrecognized kind ${JSON.stringify(kind)}; treated as blocking` };
  }
  const missing = [];
  if (req.file && !file) missing.push('file');
  if (req.line && !isAnchorLine(line)) missing.push('line');

  if (req.counterpart && !counterpart) missing.push('counterpart');
  if (missing.length) {
    return {
      status: 'UNDER-ANCHORED',
      kind,
      missing,
      why: `kind \`${kind}\` requires ${missing.join(' and ')}, which this finding does not give. `
         + 'The claim may still be real — judge the claim, not the label.',
    };
  }
  return { status: 'ok', kind, advisory: advisoryKinds ? advisoryKinds.has(kind) : undefined };
}

// Proximity clusters: same file, lines within `windowLines`, different
// reporters. These are the consensus edges a title-only join cannot see.
export function clusterFindings(findings, { windowLines = CLUSTER_WINDOW_LINES } = {}) {
  const clusters = [];
  const byFile = new Map();
  for (const f of findings) {
    if (!f.file) continue;
    if (!byFile.has(f.file)) byFile.set(f.file, []);
    byFile.get(f.file).push(f);
  }
  for (const [file, group] of byFile) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
    let run = [sorted[0]];
    const flush = () => {
      const reporters = new Set(run.map((f) => f.reporter));
      if (run.length >= 2 && reporters.size >= 2) {
        clusters.push({
          file,
          ids: run.map((f) => f.id),
          reporters: [...reporters],
          titles: run.map((f) => f.title),
        });
      }
    };
    // Near the PREVIOUS finding and still inside the window measured from the
    // run's START. Chaining on the predecessor alone let a run grow without
    // bound — ten findings six lines apart span sixty — so "same file, within
    // CLUSTER_WINDOW_LINES" was true of every adjacent pair and false of the
    // cluster, which is the bound the name promises and the one grouping
    // relies on. One reviewer filing a ladder of nits could bridge every other
    // lane's findings in a hot file into a single component.
    for (const f of sorted.slice(1)) {
      const prev = run[run.length - 1];
      const near = f.line !== null && prev.line !== null
        && Math.abs(f.line - prev.line) <= windowLines
        && Math.abs(f.line - run[0].line) <= windowLines;
      if (near) { run.push(f); continue; }
      flush();
      run = [f];
    }
    flush();
  }
  return clusters;
}

// How many co-citation edges one finding may emit. Unbounded, a single
// `detail` that name-drops several paths fanned out across the whole panel:
// on the run that filed kfox/adverse#38, F31 alone emitted 15 out-edges and
// F24 emitted 14, purely from prose naming filenames, and the transitive
// closure of the result was a 29-member "root cause" spanning 10 files and all
// four lanes — which is not a root cause, it is the review. The strongest
// three claims are kept; the rest were never evidence of a shared cause.
export const MAX_CO_CITATIONS_PER_FINDING = 3;

// Bounds the substring scan per detail. A payload is model-written and its
// length is not otherwise capped, and this scan runs once per distinct cited
// path.
const MAX_SCANNED_DETAIL_CHARS = 20_000;

// A path token is delimited by anything that cannot continue a path. `.` is
// deliberately NOT a continuation character, so "…in a.mjs." matches while
// "a.mjsx" and "src/a.mjs" (searching for `a.mjs`) do not — the second is the
// case that matters, since a bare substring match made every finding in a
// directory a citation of every other.
const PATH_CHAR = /[A-Za-z0-9_/\\-]/;

// Whether `detail` names `file` as a whole path token rather than merely
// containing its characters somewhere.
function citesPath(detail, file) {
  const text = detail.length > MAX_SCANNED_DETAIL_CHARS
    ? detail.slice(0, MAX_SCANNED_DETAIL_CHARS) : detail;
  let at = text.indexOf(file);
  while (at !== -1) {
    const before = at === 0 ? '' : text[at - 1];
    const after = text[at + file.length] ?? '';
    if (!PATH_CHAR.test(before) && !PATH_CHAR.test(after)) return true;
    at = text.indexOf(file, at + 1);
  }
  return false;
}

// Co-citation. Proximity cannot see two personas describing one root cause
// that spans files — a docstring in one file contradicting a design note in
// another. If finding A's prose cites finding B's file as a path token, that
// is a candidate same-root-cause edge that the title join and the line
// clustering would both drop.
//
// Three bounds, each of which this function was missing when it was named,
// documented and reported to the operator as "cross-file":
//
//   1. It was not cross-file. The filter excluded same-ID, same-reporter and
//      file-less pairs and never compared `a.file` to `b.file`, and reviewers
//      routinely write their own path in their own prose — so two findings in
//      one file 900 lines apart became an edge, bypassing CLUSTER_WINDOW_LINES,
//      the bound the proximity clusterer exists to enforce. A same-file pair
//      now has to echo the other finding's LINE, which is the reviewer
//      actually pointing at it rather than naming the file they are already in.
//   2. It was a bare substring match. Now a whole path token.
//   3. It had no out-degree cap. Now MAX_CO_CITATIONS_PER_FINDING.
//
// Candidates are grouped by target FILE rather than by target finding, so the
// substring scan runs once per distinct path instead of once per pair.

// Line numbers CITED in `text`, as a set.
//
// Two properties matter and the first version had only one. It replaced a
// `new RegExp(`\\b${b.line}\\b`)` built from reviewer data — `"line": "(20"`
// threw out of the constructor and took the bridge with it, `"([a-z]+)+~"`
// backtracked forever — and a set of numbers can do neither.
//
// But `/\d+/g` matched every integer anywhere in the prose, including digits
// inside identifiers (`SHA256` yielded 256) and any figure a reviewer happened
// to quote. `lineEchoed` is what lets a SAME-FILE pair form an edge at all, so
// a weak match reopened exactly the bypass the same-file rule closes. A cited
// line has a shape — `path.mjs:123`, `line 123`, `L123` — and requiring it
// asks the question actually being asked: did this reviewer point at that
// line, or merely use its digits in a sentence.
const LINE_REFERENCE = /(?::|\blines?\s+|\bL)(\d+)(?![\w.])/gi;

function numbersIn(text) {
  const cited = new Set();
  for (const m of text.matchAll(LINE_REFERENCE)) cited.add(Number(m[1]));
  return cited;
}

// A citation target has to be a file the claim-checker actually found. Nothing
// constrained the SHAPE of `file`, so a finding citing `"the"` was matched as a
// whole token in every other reviewer's prose and became the in-edge of the
// entire panel — a DISPROVED anchor anchoring a four-lane critical root cause,
// which is the headline of the round-2 prompt.
//
// Keyed on the claim check rather than on a path-shaped regex because a regex
// gets this wrong in both directions: `Makefile`, `LICENSE` and `Dockerfile`
// are real files with no slash and no extension, and `the` would pass any
// length floor. "The claim-checker opened it" is the question actually being
// asked. A finding with no claimCheck at all (a direct unit-test caller) is
// left alone.
const anchorHolds = (f) => f.claimCheck === undefined || f.claimCheck.status === 'ok';

export function crossReferenceFindings(findings) {
  const numbersByFinding = new Map(
    findings.map((f) => [f.id, numbersIn(typeof f.detail === 'string' ? f.detail : '')]),
  );

  const byFile = new Map();
  for (const b of findings) {
    if (typeof b.file !== 'string' || !b.file || !anchorHolds(b)) continue;
    if (!byFile.has(b.file)) byFile.set(b.file, []);
    byFile.get(b.file).push(b);
  }

  const crossReferences = [];
  for (const a of findings) {
    if (typeof a.detail !== 'string' || !a.detail) continue;
    const numbers = numbersByFinding.get(a.id);

    const candidates = [];
    for (const [file, targets] of byFile) {
      if (!citesPath(a.detail, file)) continue;
      for (const b of targets) {
        if (a.id === b.id || a.reporter === b.reporter) continue;
        const lineEchoed = isAnchorLine(b.line) && numbers.has(b.line);
        // Naming the file you are already in is not a citation of anything.
        // Echoing the other finding's line in it is — that is the reviewer
        // pointing at the finding rather than at their own location.
        if (a.file === b.file && !lineEchoed) continue;
        candidates.push({ from: a.id, to: b.id, file, lineEchoed, reporters: [a.reporter, b.reporter] });
      }
    }

    // Strongest first, then the order they were gathered in — deterministic,
    // because a candidate set that reordered between runs would change which
    // edges survive the cap, and grouping rides on these.
    candidates.sort((x, y) => (y.lineEchoed ? 1 : 0) - (x.lineEchoed ? 1 : 0));
    crossReferences.push(...candidates.slice(0, MAX_CO_CITATIONS_PER_FINDING));
  }

  // In-degree, capped the same way. The out-degree cap alone bounded how far
  // one finding could REACH and said nothing about how many could reach IT, so
  // a single well-placed target still collected an edge from every other
  // finding in the run and sat at the centre of the resulting component.
  const inDegree = new Map();
  return crossReferences.filter((e) => {
    const seen = inDegree.get(e.to) ?? 0;
    if (seen >= MAX_CO_CITATIONS_PER_FINDING) return false;
    inDegree.set(e.to, seen + 1);
    return true;
  });

}

// How many citations a proposed root cause may carry and still be a candidate
// for round 2 to confirm as ONE thing.
//
// Grouping is a transitive closure, and transitivity is greedy: 41 co-citation
// edges over 34 findings (the run that opened kfox/adverse#16) can chain into
// a single component that is not one root cause but the whole review. A group
// that large is still reported — the edges are real and seeing them is the
// point — but it is marked `oversized` and cannot be confirmed, so one
// reviewer answering "one" cannot collapse most of a review into a single
// disposition. Oversized fails toward MORE decisions, which is the direction
// this tool always fails in.
export const MAX_CONFIRMABLE_MEMBERS = 8;

// The cap above is absolute, and the invariant it is written for is not: "one
// reviewer answering `one` must not collapse most of a review into a single
// disposition" holds at 8 members out of 34 and fails at 7 out of 10, which is
// 70% of the review under one decision. So the effective bound is whichever of
// the two is tighter.
//
// The floor of 2 keeps the smallest meaningful group legal at any review size;
// below that there is nothing to group and the relative bound would forbid
// grouping entirely.
export function confirmableLimit(findingCount) {
  return Math.min(MAX_CONFIRMABLE_MEMBERS, Math.max(2, Math.floor(findingCount / 2)));
}


// `src/taxonomy.mjs` was created in this same range as the home for shared
// vocabulary, and this file then wrote a third copy of the severity order
// outside it. `SEVERITY_RANK[s] ?? SEVERITIES.length` gives the same total
// order, unknown severities last.
const severityIndex = (severity) => SEVERITY_RANK[severity] ?? SEVERITIES.length;

// Which member's words become the group's canonical statement: worst severity
// first, then a blocking kind over an advisory one, then the order triage
// assigned. Deterministic on purpose — a canonical title that moved between
// runs would break the title join every downstream edge rides on.
function anchorMember(members, { advisoryKinds = ADVISORY_KINDS } = {}) {
  const advisory = (f) => (advisoryKinds?.has(f.kind) ? 1 : 0);
  return [...members]
    .map((f, i) => ({ f, i }))
    .sort((a, b) => severityIndex(a.f.severity) - severityIndex(b.f.severity)
      || advisory(a.f) - advisory(b.f)
      || a.i - b.i)[0].f;
}

// Promote the cluster and co-citation edges into candidate ROOT-CAUSE groups.
//
// Both edge kinds already answer "these two reporters may be describing one
// thing" — clusters by position, co-citations by one finding's prose naming
// another's file. What neither does is close the relation: A~B and B~C left
// three separate findings to remediate, decide, and ledger, and the fixer
// re-derived the shared cause by hand every time. Connected components close
// it, and the citation fanout keeps every member's own reporter, kind,
// severity and anchor so nothing is lost to the merge.
//
// This side only PROPOSES. Whether a group is one defect or several is a
// judgment about the code, and the deterministic layer has no business making
// it — round 2 rules, and until it does the members stay individually
// reported and individually decidable. Confidence is likewise untouched:
// every group here spans at least two reporters (a cluster needs two, a
// co-citation is cross-reporter by construction), but `reporters` counts
// DISTINCT personas so a lane that reported one thing three times still
// speaks with one voice.
// A size-bounded union-find over finding IDs.
//
// Separated from `groupFindings` because closing a relation and describing the
// result are two jobs, and the size bound is the interesting half: `merge`
// refuses a union that would push a component past `limit` rather than making
// it and labelling the result afterwards.
function makeForest(ids) {
  const parent = new Map(ids.map((id) => [id, id]));
  const size = new Map(ids.map((id) => [id, 1]));

  const find = (x) => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root);
    while (parent.get(x) !== root) { const next = parent.get(x); parent.set(x, root); x = next; }
    return root;
  };

  const merge = (a, b, limit = Infinity) => {
    if (!parent.has(a) || !parent.has(b)) return false;
    const [ra, rb] = [find(a), find(b)];
    if (ra === rb) return false;
    if (size.get(ra) + size.get(rb) > limit) return false;
    parent.set(rb, ra);
    size.set(ra, size.get(ra) + size.get(rb));
    return true;
  };

  return { find, merge, parent };
}

// The connected components the two edge sets imply, as arrays of findings.
// Clusters merge unconditionally; co-citations are size-gated. Why each, in
// the comments below.
function connectedComponents(findings, { clusters, crossReferences }) {
  const { find, merge, parent } = makeForest(findings.map((f) => f.id));

  // Bounded like the co-citation path. The original premise — that a cluster is
  // "already bounded evidence" because it is same-file and cross-reporter —
  // was false while a run could chain past its own window, and even with the
  // span now bounded, an unbounded MERGE still lets several clusters in one
  // hot file chain into a component larger than any of them.
  //
  // Chained rather than star-unioned from `ids[0]`: `merge` does nothing when
  // either id is absent, so anchoring every edge on one id meant an unknown
  // first id silently discarded every edge in that cluster. Unknown ids are
  // dropped from the chain rather than breaking it, so one unknown id in the
  // MIDDLE no longer splits a real cluster in two.
  for (const c of clusters) {
    const ids = (c.ids ?? []).filter((id) => parent.has(id));
    for (let i = 1; i < ids.length; i += 1) merge(ids[i - 1], ids[i], MAX_CONFIRMABLE_MEMBERS);
  }

  // Co-citation edges are size-gated, because they are unbounded evidence: one
  // finding's prose naming another's file says far less than two reporters
  // landing on the same lines, and transitivity is greedy. The cap used to be
  // applied only AFTER the closure had run, so a chain of weak edges still
  // swallowed the review and `oversized` merely labelled the result — 34
  // findings collapsed into one 29-member "root cause" spanning 10 files and
  // all four lanes. Bounding the closure itself is what keeps a group small
  // enough to be a root cause at all.
  //
  // Strongest first, so the edges that survive the bound are the best evidence
  // available rather than whichever happened to be enumerated first. A refused
  // edge is not lost: it is still reported in `crossReferences` for the
  // operator to read, it simply does not collapse two findings into one
  // disposition.
  // The CLOSURE bound is the absolute one. It exists to stop runaway
  // transitivity, which is about the chain, not about the review's size — and
  // the relative bound below would refuse the three-finding A~B~C chain this
  // feature was built for.
  const byStrength = [...crossReferences]
    .sort((x, y) => (y.lineEchoed ? 1 : 0) - (x.lineEchoed ? 1 : 0));
  for (const x of byStrength) merge(x.from, x.to, MAX_CONFIRMABLE_MEMBERS);

  const components = new Map();
  for (const f of findings) {
    const root = find(f.id);
    if (!components.has(root)) components.set(root, []);
    components.get(root).push(f);
  }
  return [...components.values()];
}

// Which edge kinds built a component, read back once the forest has settled.
// Asking mid-merge attributes an edge to a root that a later union replaces,
// and the answer is what tells a reviewer whether the machine saw two findings
// in one place or two files naming each other.
function edgeKindsFor(ids, { clusters, crossReferences }) {
  const has = (id) => ids.has(id);
  const kinds = [];
  if (clusters.some((c) => (c.ids ?? []).some(has))) kinds.push('cluster');
  if (crossReferences.some((x) => has(x.from) && has(x.to))) kinds.push('co-citation');
  return kinds;
}

const distinct = (xs) => [...new Set(xs.filter((x) => x !== null && x !== undefined))];

// One component, described as a candidate root cause.
function toGroup(members, id, { advisoryKinds, findingCount, via }) {
  const anchor = anchorMember(members, { advisoryKinds });
  return {
    id,
    title: anchor.title,
    // Which member's words became the canonical statement. Recorded rather
    // than re-derived: `title` came from this member and four other places
    // used to answer "what is this group" by array position instead, so the
    // group's headline and its fix routinely described different citations.
    anchor: anchor.id,
    severity: SEVERITIES.find((s) => members.some((f) => f.severity === s))
      ?? anchor.severity ?? null,
    kinds: distinct(members.map((f) => f.kind)),
    files: distinct(members.map((f) => f.file)),
    reporters: distinct(members.map((f) => f.reporter)),
    members: members.map((f) => f.id),
    via,
    // The fanout. Every member keeps its own reporter, kind, severity and
    // anchor: a group is a way to read and decide N findings at once, never
    // a replacement for them.
    citations: members.map((f) => ({
      id: f.id,
      reporter: f.reporter,
      kind: f.kind ?? null,
      severity: f.severity ?? null,
      file: f.file ?? null,
      line: f.line ?? null,
      // `counterpart` is here because a group decision is built by copying
      // these fields into decisions.json, and a `contract` entry that omits
      // it can never match anything again (src/ledger.mjs, scoreMatch: the
      // claim is "X contradicts Y", so Y is half the identity). The ledger
      // would then re-raise that citation every iteration — the circling it
      // exists to stop.
      counterpart: f.counterpart ?? null,
      title: f.title,
    })),
    // CONFIRMABILITY gets the relative bound. A group may legitimately be
    // most of a tiny review; what must not happen is one ruling turning most
    // of a review into one disposition. Oversized fails toward MORE
    // decisions, so a group that trips this is still reported in full and
    // still individually decidable — it just cannot collapse.
    oversized: members.length > confirmableLimit(findingCount),
  };
}

// Gather the edges, close them, describe each component. Those three steps are
// the three functions above; this is the assembly, and the only place that
// knows a component of fewer than two findings is not a group.
export function groupFindings(findings,
  { clusters = [], crossReferences = [], advisoryKinds = ADVISORY_KINDS } = {}) {
  const edges = { clusters, crossReferences };
  const groups = [];
  for (const members of connectedComponents(findings, edges)) {
    if (members.length < 2) continue;
    const via = edgeKindsFor(new Set(members.map((f) => f.id)), edges);
    groups.push(toGroup(members, `G${groups.length + 1}`, {
      advisoryKinds, findingCount: findings.length, via,
    }));
  }
  return groups;
}

// Claim-checking needs the repo root and the diff base, so it is built by a
// factory rather than taking them as parameters on every call — the same
// shape trace.mjs's `makeAnchorTracer` uses for the same reason.
export function makeClaimChecker({ repo, base }) {
  // Resolve a model-supplied path against the repo root, or null if it
  // escapes.
  //
  // `file` comes out of a reviewer's JSON, so `../../../etc/passwd` is a path
  // a reviewer can write. Both callers below go on to read the file and put a
  // line of it into `citedLine`, which is copied verbatim into the round-2
  // prompt — so an unchecked join is a read-anything primitive with an
  // exfiltration path attached. `path.join` normalizes `..` away rather than
  // rejecting it, which is why the check has to be on the resolved result.
  // Note `realpathSync`, not just `resolve`. `path.resolve` normalizes `..`
  // but knows nothing about symlinks, while a plain existence check and a
  // read by path both follow them — so a symlink committed inside the
  // checkout (git stores mode 120000) kept the path under the repo prefix
  // while the read landed wherever it pointed. That is the same exfiltration
  // channel this function was written to close, reached by a path the string
  // check could not see.
  const repoReal = (() => {
    try {
      return realpathSync(repo);
    } catch {
      return repo;
    }
  })();

  function insideRepo(file) {
    // `path.resolve` throws ERR_INVALID_ARG_TYPE on a number, boolean, array
    // or object, and `file` reaches here from reviewer JSON. Rejecting a
    // non-string here rather than letting it throw keeps a malformed anchor a
    // DISPROVED finding instead of an uncaught crash that loses the run.
    if (typeof file !== 'string' || !file) return null;

    const abs = path.resolve(repo, file);

    if (abs !== repo && !abs.startsWith(repo + path.sep)) return null;

    let real;
    try {
      real = realpathSync(abs);
    } catch {
      return abs; // does not exist yet; the caller's open attempt rejects it
    }
    if (real !== repoReal && !real.startsWith(repoReal + path.sep)) return null;
    return real;
  }

  function changedRanges(file) {
    let out;
    try {
      out = execFileSync('git', ['diff', '-U0', `${base}...HEAD`, '--', file],
                         { cwd: repo, encoding: 'utf-8' });
    } catch {
      return null;
    }
    const ranges = [];
    for (const h of parseHunks(out)) {
      if (h.newCount === 0) continue;
      ranges.push([h.newStart, h.newStart + h.newCount - 1]);
    }
    return ranges;
  }

  function checkClaim(file, line) {
    if (!file) return { status: 'not-file-bound' };

    const abs = insideRepo(file);
    if (abs === null) {
      return { status: 'DISPROVED', why: `cited path escapes the checkout: ${file}` };
    }

    // Open once and check/read through the same descriptor rather than the
    // path — an exists-then-readFileSync-by-path pair leaves a window where
    // the path could resolve to something else by the time it's read, and
    // `insideRepo`'s realpath check above only proves the path was clean at
    // that moment.
    let fd = null;
    try {
      fd = openRegularFileSync(abs);
    } catch {
      // ENOENT, ELOOP (a symlink slipped in after the realpath check), EACCES…
    }
    if (fd === null) {
      return { status: 'DISPROVED', why: `cited file does not exist in the checkout: ${file}` };
    }
    let lines;
    try {
      lines = readFileSync(fd, 'utf-8').split('\n');
    } finally {
      closeQuietly(fd);
    }
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    const total = lines.length;
    const out = { status: 'ok', file, fileLines: total };

    if (line === null || line === undefined) {
      out.line = null;
      out.note = 'no line cited; file exists';
      return out;
    }
    // Fail closed on a line that is not a positive integer. `line > total` is
    // false for `NaN`, so `"line": ".*"` used to fall through this branch and
    // come back `status: 'ok'` with `citedLine: null` — the tool vouching for
    // an anchor it never checked. `0`, `-5` and `4.5` passed the same way.
    if (!isAnchorLine(line)) {
      return { status: 'DISPROVED', file, fileLines: total, line,
               why: `cited line is not a positive integer: ${JSON.stringify(line)}` };
    }

    out.line = line;
    if (line > total) {

      return { status: 'DISPROVED', file, fileLines: total, line,
               why: `cited line ${line} is past end of file (${total} lines)` };
    }

    const ranges = changedRanges(file);
    if (ranges === null) {
      out.inDiff = 'unknown';
    } else if (ranges.some(([s, e]) => line >= s && line <= e)) {
      out.inDiff = 'inside';
    } else {
      out.inDiff = 'outside';
      out.note = 'cited line is NOT in this diff\'s changed ranges. That is legitimate '
               + 'for a latent defect the diff newly makes reachable — but the finding '
               + 'must say why the diff is what puts it in play.';
    }
    out.citedLine = lines[line - 1] ?? null;
    return out;
  }

  // A `contract` finding names a second path, and that path is a claim like
  // any other: a counterpart that is not in the checkout disproves the
  // contradiction just as surely as a missing primary file does.
  function checkCounterpart(file) {
    if (!file) return null;
    const abs = insideRepo(file);
    if (abs === null) {
      return { status: 'DISPROVED', why: `cited counterpart escapes the checkout: ${file}` };
    }
    let fd = null;
    try {
      fd = openRegularFileSync(abs);
    } catch {
      // not a usable file at this path
    }
    if (fd === null) {
      return { status: 'DISPROVED', why: `cited counterpart does not exist in the checkout: ${file}` };
    }
    closeQuietly(fd);
    return { status: 'ok', file };
  }

  return { checkClaim, checkCounterpart };
}
