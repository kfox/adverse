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
import { parseHunks } from './trace.mjs';

export const CLUSTER_WINDOW_LINES = 15;

// What each kind promises about its own anchoring. Checked, not enforced: a
// finding that does not keep its kind's promise is ANNOTATED as
// under-anchored, never dropped — the reporter may have found something real
// and merely labeled it carelessly, and only a reviewer can tell those apart.
const KIND_REQUIREMENTS = {
  defect:     { file: true, line: true,  counterpart: false },
  behavioral: { file: true, line: false, counterpart: false },
  contract:   { file: true, line: false, counterpart: true  },
  design:     { file: false, line: false, counterpart: false },
};

export function checkKind(kind, file, line, counterpart, { advisoryKinds } = {}) {
  if (kind === undefined || kind === null || kind === '') {
    return { status: 'MISSING', why: 'no `kind` on this finding; it is treated as blocking' };
  }
  const req = KIND_REQUIREMENTS[kind];
  if (!req) {
    return { status: 'UNKNOWN', kind, why: `unrecognized kind ${JSON.stringify(kind)}; treated as blocking` };
  }
  const missing = [];
  if (req.file && !file) missing.push('file');
  if (req.line && (line === null || line === undefined)) missing.push('line');
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
    for (const f of sorted.slice(1)) {
      const prev = run[run.length - 1];
      const near = f.line !== null && prev.line !== null
        && Math.abs(f.line - prev.line) <= windowLines;
      if (near) { run.push(f); continue; }
      flush();
      run = [f];
    }
    flush();
  }
  return clusters;
}

// Cross-file co-citation. Proximity cannot see two personas describing one
// root cause that spans files — a docstring in one file contradicting a
// design note in another. If finding A's prose cites finding B's file (and,
// when both name lines, B's line too), that is a candidate same-root-cause
// edge that the title join and the line clustering would both drop.
export function crossReferenceFindings(findings) {
  const crossReferences = [];
  for (const a of findings) {
    for (const b of findings) {
      if (a.id === b.id || a.reporter === b.reporter || !b.file) continue;
      if (!a.detail || !a.detail.includes(b.file)) continue;
      const lineEchoed = b.line !== null && new RegExp(`\\b${b.line}\\b`).test(a.detail);
      crossReferences.push({
        from: a.id,
        to: b.id,
        file: b.file,
        lineEchoed,
        reporters: [a.reporter, b.reporter],
      });
    }
  }
  return crossReferences;
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

const SEVERITY_ORDER = ['critical', 'warning', 'info'];

function severityIndex(severity) {
  const at = SEVERITY_ORDER.indexOf(severity);
  return at === -1 ? SEVERITY_ORDER.length : at;
}

// Which member's words become the group's canonical statement: worst severity
// first, then a blocking kind over an advisory one, then the order triage
// assigned. Deterministic on purpose — a canonical title that moved between
// runs would break the title join every downstream edge rides on.
function anchorMember(members, { advisoryKinds }) {
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
export function groupFindings(findings, { clusters = [], crossReferences = [], advisoryKinds } = {}) {
  const parent = new Map(findings.map((f) => [f.id, f.id]));

  const find = (x) => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root);
    while (parent.get(x) !== root) { const next = parent.get(x); parent.set(x, root); x = next; }
    return root;
  };
  const union = (a, b) => {
    if (!parent.has(a) || !parent.has(b)) return;
    const [ra, rb] = [find(a), find(b)];
    if (ra !== rb) parent.set(rb, ra);
  };

  for (const c of clusters) {
    for (const id of (c.ids ?? []).slice(1)) union(c.ids[0], id);
  }
  for (const x of crossReferences) union(x.from, x.to);

  const components = new Map();
  for (const f of findings) {
    const root = find(f.id);
    if (!components.has(root)) components.set(root, []);
    components.get(root).push(f);
  }

  // Which edge kinds built this component, read back once the forest has
  // settled. Asking mid-merge attributes an edge to a root that a later union
  // replaces, and the answer is what tells a reviewer whether the machine saw
  // two findings in one place or two files naming each other.
  const edgeKinds = (ids) => {
    const has = (id) => ids.has(id);
    const kinds = [];
    if (clusters.some((c) => (c.ids ?? []).some(has))) kinds.push('cluster');
    if (crossReferences.some((x) => has(x.from) && has(x.to))) kinds.push('co-citation');
    return kinds;
  };

  const groups = [];
  for (const members of components.values()) {
    if (members.length < 2) continue;
    const anchor = anchorMember(members, { advisoryKinds });
    const distinct = (xs) => [...new Set(xs.filter((x) => x !== null && x !== undefined))];
    groups.push({
      id: `G${groups.length + 1}`,
      title: anchor.title,
      severity: SEVERITY_ORDER.find((s) => members.some((f) => f.severity === s))
        ?? anchor.severity ?? null,
      kinds: distinct(members.map((f) => f.kind)),
      files: distinct(members.map((f) => f.file)),
      reporters: distinct(members.map((f) => f.reporter)),
      members: members.map((f) => f.id),
      via: edgeKinds(new Set(members.map((f) => f.id))),
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
        title: f.title,
      })),
      oversized: members.length > MAX_CONFIRMABLE_MEMBERS,
    });
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
