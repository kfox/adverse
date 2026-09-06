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

import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import path from 'node:path';

import { readJson, splitPersonasFromPlan, usage } from './bridge-io.mjs';
import { importFromSrc } from './package-root.mjs';

const { annotate, checkBinding, isRegressionCandidate, emptyLedger, loadLedger } = await importFromSrc('ledger.mjs');
const { resolveRef, makeAnchorTracer } = await importFromSrc('trace.mjs');
const { ADVISORY_KINDS } = await importFromSrc('taxonomy.mjs');
const { mergeSplitReviews, normalizeVerdict } = await importFromSrc('synthesis.mjs');
const { DEFAULT_PERSONAS } = await importFromSrc('personas.mjs');
const { CLUSTER_WINDOW_LINES, checkKind, clusterFindings, crossReferenceFindings, groupFindings, makeClaimChecker } =
  await importFromSrc('triage.mjs');

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
    'merge-personas': { type: 'string', multiple: true },
    plan:   { type: 'string' },
  },
  strict: true,
  allowPositionals: true,
});

values.round1 = [...(values.round1 ?? []), ...positionals];
if (!values.round1.length || !values.repo || !values.out) {
  usage('Usage: triage.mjs --round1 a.json [--round1 b.json …] [--merge-personas <persona>]… [--plan plan.json] --repo <dir> [--base <ref>] [--gate "<summary>"] [--ledger <ledger.json>] --out <briefing.json>');
}

const repo = path.resolve(values.repo);
const base = values.base ?? 'main';
// Same guard as plan.mjs: a base in git's option position becomes a git
// option, and `--base=--output=X` is an arbitrary file create/truncate.
if (base.startsWith('-')) {
  process.stderr.write(`triage: --base ${JSON.stringify(base)} looks like an option, not a ref\n`);
  process.exit(2);
}

const { checkClaim, checkCounterpart } = makeClaimChecker({ repo, base });

const reviews = values.round1.map((f) => readJson(f, 'triage'));
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

// Same guard combine.mjs has always had, missing here until now: without it,
// ANY duplicate persona — a genuinely split lane, a re-run whose old files
// were never cleaned, a stale run's payload swept in by a wide glob — merges
// silently via mergeSplitReviews below. That silent merge is exactly how a
// contaminated briefing (8 reviewers instead of the planned 4) went undetected
// in the run that motivated this check. `--merge-personas <persona>` names
// the lane the plan actually split, so an undeclared duplicate is an error
// instead of a phantom extra reviewer.
const mergePersonas = new Set([
  ...(values['merge-personas'] ?? []),
  ...(values.plan ? splitPersonasFromPlan(values.plan, 'triage') : []),
]);
for (const p of mergePersonas) {
  if (!KNOWN_PERSONAS.has(p)) {
    process.stderr.write(`triage: ${p}: not a persona (${DEFAULT_PERSONAS.join(', ')})\n`);
    process.exit(2);
  }
}
const countByPersona = new Map();
for (const r of reviews) countByPersona.set(r.persona, (countByPersona.get(r.persona) ?? 0) + 1);
for (const [persona, count] of countByPersona) {
  if (mergePersonas.has(persona)) {
    if (count !== 2) {
      process.stderr.write(`triage: --merge-personas ${persona}: expected exactly 2 payloads for the split lane, got ${count}.`
        + (count < 2
          ? ' What is missing reviewed nothing — re-run it, or pass --degraded to synthesize.\n'
          : ' Extra payloads mean a stale file or a double glob — clean the run directory.\n'));
      process.exit(1);
    }
  } else if (count > 1) {
    process.stderr.write(`triage: duplicate persona '${persona}' across inputs`
      + ' (a deliberately split lane needs --merge-personas <persona>)\n');
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
      kindCheck: checkKind(f.kind, f.file ?? null, f.line ?? null, f.counterpart ?? null, { advisoryKinds: ADVISORY_KINDS }),
    });
  }
}

// Same-file-and-nearby-lines, and cross-file co-citation: the two consensus
// edges a title-only join cannot see. Pure over `findings`, so both live in
// src/triage.mjs where a unit test can exercise them directly.
const clusters = clusterFindings(findings, { windowLines: CLUSTER_WINDOW_LINES });
const crossReferences = crossReferenceFindings(findings);

// Both edge sets answer "these two reporters may be describing one thing", and
// neither closes the relation: A~B and B~C left three findings to remediate,
// decide, and ledger separately. Connected components close it and carry every
// member along as a citation. Proposed only — round 2 rules on each group.
const groups = groupFindings(findings, { clusters, crossReferences, advisoryKinds: ADVISORY_KINDS });

// Every finding sharing a file with another reporter's, regardless of line
// distance — a wider net than `clusters`, which `sameFileDifferentRegion`
// below reports separately.
const byFile = new Map();
for (const f of findings) {
  if (!f.file) continue;
  if (!byFile.has(f.file)) byFile.set(f.file, []);
  byFile.get(f.file).push(f);
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
  groups,
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
  + `  candidate root causes (proposed, for round 2 to confirm or split): ${groups.length}`
  + `${groups.length ? ` (${groups.map((g) => `${g.id}=${g.members.join('+')}${g.oversized ? ' OVERSIZED' : ''}`).join(', ')})` : ''}\n`
  + `  cited outside the diff (annotated, not rejected): ${outside.length}${ids(outside)}\n`
  + `  under-anchored for their kind (annotated, not rejected): ${underAnchored.length}${ids(underAnchored)}\n`
  + `  advisory (design — cannot block): ${advisory.length}${ids(advisory)}\n`
  + `  already settled in an earlier iteration: ${settled.length}${ids(settled)}\n`
  + `  REGRESSED (recorded fixed, reported again): ${regressed.length}${ids(regressed)}\n`);
