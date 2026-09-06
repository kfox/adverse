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

import { readJson, readPlanLanes, reportRoster, usage } from './bridge-io.mjs';
import { importFromSrc } from './package-root.mjs';

const { annotate, checkBinding, isRegressionCandidate, emptyLedger, loadLedger } = await importFromSrc('ledger.mjs');
const { resolveRef, makeAnchorTracer } = await importFromSrc('trace.mjs');
const { ADVISORY_KINDS } = await importFromSrc('taxonomy.mjs');
const { mergeSplitReviews, normalizeVerdict } = await importFromSrc('synthesis.mjs');
const { checkRoster } = await importFromSrc('roster.mjs');
const { CLUSTER_WINDOW_LINES, MAX_CO_CITATIONS_PER_FINDING, checkKind, clusterFindings,
        crossReferenceFindings, groupFindings, makeClaimChecker, normalizeAnchor } =
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

const sources = values.round1;
const reviews = sources.map((f) => readJson(f, 'triage'));

// Who counts as a reviewer — src/roster.mjs, the same rules combine.mjs
// applies to the same payloads one phase later. triage is the bridge that
// builds the round-2 PROMPT, so a payload from a lane the plan never ran was
// shaping the cross-review one step before combine got the chance to refuse
// it.
//
// `--plan` carries both answers this needs: `agents > 1` says which lanes were
// split, `run` says which lanes exist.
const planLanes = values.plan ? readPlanLanes(values.plan, 'triage') : null;
reportRoster(checkRoster(
  reviews.map((r, i) => ({ persona: r?.persona, src: sources[i] })),
  { lanes: planLanes, explicitMerges: values['merge-personas'] ?? [] },
), 'triage');

// Identity is settled above; this is the other half of a usable payload. A
// non-array `findings` reached a `for…of` and threw a TypeError with a stack
// trace, against a contract that says a bridge which could not read its input
// exits 2 and never crashes.
for (let i = 0; i < reviews.length; i += 1) {
  const supplied = reviews[i].findings;
  if (supplied !== undefined && !Array.isArray(supplied)) {
    process.stderr.write(`triage: ${sources[i]}: \`findings\` is not an array`
      + ` (got ${JSON.stringify(supplied)})\n`);
    process.exit(2);
  }
}

// Anchors are normalized BEFORE anything reads them. `line`, `file`,
// `counterpart` and `detail` come out of a model, and downstream they reach a
// bounds test, a path resolver and a prose scan that each assumed a type
// nothing had established. Rejected values are collected rather than
// swallowed: a finding whose anchor was thrown away must not read like a
// finding that never had one.
const findings = [];
const rejectedAnchors = [];
let n = 0;
for (const review of reviews) {
  for (const f of review.findings ?? []) {
    n += 1;
    const id = `F${n}`;
    const { file, line, counterpart, detail, fix, rejected } = normalizeAnchor(f);
    if (rejected.length) rejectedAnchors.push(`${id}.${rejected.join('+')}`);
    findings.push({
      id,
      reporter: review.persona,
      // On the FINDING, not only on stdout. A coerced-away anchor left the
      // briefing looking exactly like a finding whose reporter never supplied
      // one — and briefing.json is what round 2 reads, so the reviewer judging
      // "is this under-anchored?" could not see that an anchor had been
      // offered and thrown away. That is the distinction `rejected` exists to
      // preserve, reaching only the terminal it was printed to.
      rejectedAnchors: rejected.length ? rejected : undefined,
      severity: f.severity,
      kind: f.kind ?? null,
      file,
      line,
      counterpart,
      title: f.title,
      detail,
      fix,
      claimCheck: checkClaim(file, line),
      counterpartCheck: checkCounterpart(counterpart),
      kindCheck: checkKind(f.kind, file, line, counterpart, { advisoryKinds: ADVISORY_KINDS }),
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
  + `  malformed anchors coerced away (field kept null): ${rejectedAnchors.length}`
  + `${rejectedAnchors.length ? ` (${rejectedAnchors.join(', ')})` : ''}\n`

  + `  co-citations (cross-file, or same-file with the line echoed; max`
  + ` ${MAX_CO_CITATIONS_PER_FINDING}/finding): ${crossReferences.length}`

  + `${crossReferences.length ? ` (${crossReferences.map((x) => `${x.from}->${x.to}`).join(', ')})` : ''}\n`
  + `  candidate root causes (proposed, for round 2 to confirm or split): ${groups.length}`
  + `${groups.length ? ` (${groups.map((g) => `${g.id}=${g.members.join('+')}${g.oversized ? ' OVERSIZED' : ''}`).join(', ')})` : ''}\n`
  + `  cited outside the diff (annotated, not rejected): ${outside.length}${ids(outside)}\n`
  + `  under-anchored for their kind (annotated, not rejected): ${underAnchored.length}${ids(underAnchored)}\n`
  + `  advisory (design — cannot block): ${advisory.length}${ids(advisory)}\n`
  + `  already settled in an earlier iteration: ${settled.length}${ids(settled)}\n`
  + `  REGRESSED (recorded fixed, reported again): ${regressed.length}${ids(regressed)}\n`);
