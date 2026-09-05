#!/usr/bin/env node
// Skill bridge: round-1 triage. Assigns stable finding IDs, claim-checks every
// cited file and line against the checkout, and clusters findings that are
// likely to be the same defect seen twice — emitted as a compact round-2
// briefing that replaces the source block.
//
// Why this exists. Synthesis joins cross-review edges on normalized finding
// TITLE (src/synthesis.mjs, `byNormTitle`), which is why round2.txt has to ask
// reviewers to copy titles character-for-character. Two personas who
// independently find the SAME defect under different titles never form a
// consensus edge — so the strongest signal the panel produces, cross-lane
// agreement, is the one most likely to be silently dropped.
//
// Three answers, all deterministic — no model in the loop, so none of this can
// hallucinate:
//   1. Every finding gets a stable ID (F1..Fn). Reviewers reference the ID and
//      carry the canonical title along verbatim, so the title join still works.
//   2. Findings in the same file within CLUSTER_WINDOW_LINES, and findings whose
//      prose cites another finding's file, are surfaced as candidate shared root
//      causes — the edges neither the title join nor a human skim would make.
//   3. A cited file that does not exist, or a line past end of file, is flagged
//      before any model spends a token judging it.
//
// The same doctrine governs the kind check. A finding's `kind` promises a
// certain anchoring — a `defect` is settled by reading a line, so it needs one;
// a `contract` claims two files disagree, so it has to name both. A finding
// that does not keep that promise is ANNOTATED as under-anchored, never
// dropped: the reporter may have found something real and merely labeled it
// carelessly, and only a reviewer can tell those apart.
//
// A finding citing a line OUTSIDE the diff's changed ranges is ANNOTATED, never
// rejected. A latent bug that this change newly makes reachable lives in
// unchanged lines by definition, and in the run that motivated this script that
// finding was the only CRITICAL on the table. "Outside" is a question for the
// reviewer ("does the finding say why this diff puts it in play?"), not a
// verdict.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, statSync, realpathSync } from 'node:fs';
import { parseArgs } from 'node:util';
import path from 'node:path';

import { importFromSrc } from './package-root.mjs';

const { annotate, checkBinding, isRegressionCandidate, emptyLedger, loadLedger } = await importFromSrc('ledger.mjs');
const { resolveRef, makeAnchorTracer } = await importFromSrc('trace.mjs');
const { ADVISORY_KINDS } = await importFromSrc('prompts.mjs');
const { mergeSplitReviews, normalizeVerdict } = await importFromSrc('synthesis.mjs');
const { DEFAULT_PERSONAS } = await importFromSrc('personas.mjs');

const CLUSTER_WINDOW_LINES = 15;

// `allowPositionals` is not optional here. `--round1 run/round1-*.json` is the
// documented invocation and the natural one to type; the shell expands it, and
// with strict parsing the second and later paths arrive as positionals. Node
// then throws ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL and Phase 3 aborts before
// any round-2 work happens. combine.mjs has always accepted them; so does this.
const { values, positionals } = parseArgs({
  options: {
    round1: { type: 'string', multiple: true },
    repo:   { type: 'string' },
    base:   { type: 'string' },
    gate:   { type: 'string' },
    ledger: { type: 'string' },
    out:    { type: 'string' },
  },
  strict: true,
  allowPositionals: true,
});

values.round1 = [...(values.round1 ?? []), ...positionals];
if (!values.round1.length || !values.repo || !values.out) {
  process.stderr.write('Usage: triage.mjs --round1 a.json [--round1 b.json …] --repo <dir> [--base <ref>] [--gate "<summary>"] [--ledger <ledger.json>] --out <briefing.json>\n');
  process.exit(2);
}

const repo = path.resolve(values.repo);
const base = values.base ?? 'main';
// Same guard as plan.mjs: a base in git's option position becomes a git
// option, and `--base=--output=X` is an arbitrary file create/truncate.
if (base.startsWith('-')) {
  process.stderr.write(`triage: --base ${JSON.stringify(base)} looks like an option, not a ref\n`);
  process.exit(2);
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf-8'));
  } catch (e) {
    process.stderr.write(`triage: ${file}: ${e.message}\n`);
    process.exit(1);
  }
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
  for (const line of out.split('\n')) {
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!m) continue;
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    if (count === 0) continue;
    ranges.push([start, start + count - 1]);
  }
  return ranges;
}

function lineCount(abs) {
  const lines = readFileSync(abs, 'utf-8').split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

// Resolve a model-supplied path against the repo root, or null if it escapes.
//
// `file` comes out of a reviewer's JSON, so `../../../etc/passwd` is a path a
// reviewer can write. Both callers below go on to read the file and put a line
// of it into `citedLine`, which is copied verbatim into the round-2 prompt —
// so an unchecked join is a read-anything primitive with an exfiltration path
// attached. `path.join` normalizes `..` away rather than rejecting it, which is
// why the check has to be on the resolved result.
// Note `realpathSync`, not just `resolve`. `path.resolve` normalizes `..` but
// knows nothing about symlinks, while `existsSync`/`statSync`/`readFileSync`
// all follow them — so a symlink committed inside the checkout (git stores
// mode 120000) kept the path under the repo prefix while the read landed
// wherever it pointed. That is the same exfiltration channel this function was
// written to close, reached by a path the string check could not see.
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
    return abs; // does not exist yet; the caller's existsSync check rejects it
  }
  if (real !== repoReal && !real.startsWith(repoReal + path.sep)) return null;
  return real;
}

function checkClaim(file, line) {
  if (!file) return { status: 'not-file-bound' };

  const abs = insideRepo(file);
  if (abs === null) {
    return { status: 'DISPROVED', why: `cited path escapes the checkout: ${file}` };
  }
  if (!existsSync(abs) || !statSync(abs).isFile()) {
    return { status: 'DISPROVED', why: `cited file does not exist in the checkout: ${file}` };
  }

  const total = lineCount(abs);
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
  out.citedLine = readFileSync(abs, 'utf-8').split('\n')[line - 1] ?? null;
  return out;
}

// What each kind promises about its own anchoring. Checked, not enforced —
// see the doctrine note at the top of this file.
const KIND_REQUIREMENTS = {
  defect:     { file: true, line: true,  counterpart: false },
  behavioral: { file: true, line: false, counterpart: false },
  contract:   { file: true, line: false, counterpart: true  },
  design:     { file: false, line: false, counterpart: false },
};

// A `contract` finding names a second path, and that path is a claim like any
// other: a counterpart that is not in the checkout disproves the contradiction
// just as surely as a missing primary file does.
function checkCounterpart(file) {
  if (!file) return null;
  const abs = insideRepo(file);
  if (abs === null) {
    return { status: 'DISPROVED', why: `cited counterpart escapes the checkout: ${file}` };
  }
  if (existsSync(abs) && statSync(abs).isFile()) return { status: 'ok', file };
  return { status: 'DISPROVED', why: `cited counterpart does not exist in the checkout: ${file}` };
}

function checkKind(kind, file, line, counterpart) {
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
  return { status: 'ok', kind, advisory: ADVISORY_KINDS.has(kind) };
}

const reviews = values.round1.map(readJson);
// The persona string is model-written and keys the briefing's verdicts,
// clusters (reporters.size >= 2), and cross-references (a.reporter !==
// b.reporter) — a re-cased name would mint a phantom reviewer whose agreement
// with its own other half reads as two independent lanes. Same registry check
// as combine.mjs, at the earlier reader.
const KNOWN_PERSONAS = new Set(DEFAULT_PERSONAS);
for (const r of reviews) {
  if (!KNOWN_PERSONAS.has(r?.persona)) {
    process.stderr.write(`triage: unknown persona ${JSON.stringify(r?.persona)}`
      + ` (expected one of ${DEFAULT_PERSONAS.join(', ')})\n`);
    process.exit(1);
  }
}

const findings = [];
let n = 0;
for (const review of reviews) {
  for (const f of review.findings ?? []) {
    n += 1;
    findings.push({
      id: `F${n}`,
      reporter: review.persona,
      severity: f.severity,
      kind: f.kind ?? null,
      file: f.file ?? null,
      line: f.line ?? null,
      counterpart: f.counterpart ?? null,
      title: f.title,
      detail: f.detail,
      fix: f.fix ?? null,
      claimCheck: checkClaim(f.file ?? null, f.line ?? null),
      counterpartCheck: checkCounterpart(f.counterpart ?? null),
      kindCheck: checkKind(f.kind, f.file ?? null, f.line ?? null, f.counterpart ?? null),
    });
  }
}

// Proximity clusters: same file, lines within CLUSTER_WINDOW_LINES, different
// reporters. These are the consensus edges a title-only join cannot see.
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
      && Math.abs(f.line - prev.line) <= CLUSTER_WINDOW_LINES;
    if (near) { run.push(f); continue; }
    flush();
    run = [f];
  }
  flush();
}

// Cross-file co-citation. Proximity cannot see two personas describing one root
// cause that spans files — a docstring in one file contradicting a design note
// in another. If finding A's prose cites finding B's file (and, when both name
// lines, B's line too), that is a candidate same-root-cause edge that the title
// join and the line clustering would both drop.
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

// What earlier iterations already decided. Positions in the ledger were
// recorded against the commit the decision was made at, so each one is
// re-projected to HEAD before matching — otherwise a fix that shifted the file
// makes every past decision look like a different finding.
let ledger = emptyLedger();
if (values.ledger) {
  try {
    ledger = loadLedger(values.ledger);
  } catch (e) {
    process.stderr.write(`triage: ${e.message}\n`);
    process.exit(1);
  }

  // The same binding converge.mjs enforces, and this script needs it more:
  // triage is what writes briefing.json, which IS the round-2 prompt. A
  // foreign ledger accepted here marks findings settled with "Do not re-open
  // it" and puts its own text in front of every reviewer.
  const problems = checkBinding(ledger, (ref) => resolveRef(repo, ref));
  if (problems.length) {
    process.stderr.write('triage: this ledger does not belong to this repository:\n'
      + problems.map((p) => `  - ${p}\n`).join(''));
    process.exit(1);
  }
}
const traceFor = makeAnchorTracer({ repo, to: 'HEAD' });
const adjudicatedFindings = annotate(findings, ledger, traceFor);
for (let i = 0; i < findings.length; i += 1) {
  if (adjudicatedFindings[i].adjudicated) findings[i].adjudicated = adjudicatedFindings[i].adjudicated;
}
const settled = findings.filter((f) => f.adjudicated?.settled);
// The same predicate convergenceStatus uses, imported rather than re-spelled —
// this copy had drifted to "annotated and unsettled", which calls a brand-new
// finding REGRESSED because a line-less decline sits somewhere in its file.
// briefing.regressed IS the round-2 prompt, so that is a false claim made to a
// reviewer about work that was never done.
const regressed = findings.filter(isRegressionCandidate);

const briefing = {
  base,
  gate: values.gate ?? null,
  // A split lane arrives as two payloads under one persona, and
  // Object.fromEntries is last-key-wins — which replaced half B's reject with
  // half A's approve in the one text every round-2 reviewer reads. Merge with
  // the same semantics combine.mjs uses, from the same export.
  verdicts: reviews.reduce((acc, r) => {
    const prev = acc[r.persona];
    const merged = prev ? mergeSplitReviews(prev, r) : r;
    acc[r.persona] = { verdict: normalizeVerdict(merged.verdict), summary: merged.summary };
    return acc;
  }, Object.create(null)),
  findings,
  clusters,
  crossReferences,
  settled: settled.map((f) => f.id),
  regressed: regressed.map((f) => f.id),
  sameFileDifferentRegion: [...byFile]
    .filter(([, g]) => new Set(g.map((f) => f.reporter)).size >= 2)
    .map(([file, g]) => ({ file, ids: g.map((f) => f.id) })),
};

writeFileSync(values.out, JSON.stringify(briefing, null, 2), 'utf-8');


const disproved = findings.filter(
  (f) => f.claimCheck.status === 'DISPROVED' || f.counterpartCheck?.status === 'DISPROVED',
);
const underAnchored = findings.filter((f) => f.kindCheck.status !== 'ok');
const advisory = findings.filter((f) => f.kindCheck.advisory === true);
const outside = findings.filter((f) => f.claimCheck.inDiff === 'outside');
const ids = (list) => (list.length ? ` (${list.map((f) => f.id ?? f).join(', ')})` : '');
process.stdout.write(
  `triaged ${findings.length} findings from ${reviews.length} reviewers -> ${values.out}\n`
  + `  clusters (same file, <=${CLUSTER_WINDOW_LINES} lines apart, 2+ reporters): ${clusters.length}\n`
  + `  claim-check disproved: ${disproved.length}${ids(disproved)}\n`
  + `  cross-file co-citations (candidate shared root cause): ${crossReferences.length}`
  + `${crossReferences.length ? ` (${crossReferences.map((x) => `${x.from}->${x.to}`).join(', ')})` : ''}\n`
  + `  cited outside the diff (annotated, not rejected): ${outside.length}${ids(outside)}\n`
  + `  under-anchored for their kind (annotated, not rejected): ${underAnchored.length}${ids(underAnchored)}\n`
  + `  advisory (design — cannot block): ${advisory.length}${ids(advisory)}\n`
  + `  already settled in an earlier iteration: ${settled.length}${ids(settled)}\n`
  + `  REGRESSED (recorded fixed, reported again): ${regressed.length}${ids(regressed)}\n`);
