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

import path from 'node:path';

import { parseBridgeArgs, readJson, readPlanLanes, reportRoster, usage, writeOutput } from './bridge-io.mjs';
import { importFromSrc } from './package-root.mjs';

const { ADVISORY_KINDS } = await importFromSrc('taxonomy.mjs');
const { checkBinding, emptyLedger, loadLedger } = await importFromSrc('ledger.mjs');
const { resolveRef, makeAnchorTracer } = await importFromSrc('trace.mjs');
const { buildBriefing } = await importFromSrc('briefing.mjs');
const { worktreeDigest } = await importFromSrc('gate.mjs');
const { normalizeProbes } = await importFromSrc('probe.mjs');
const { checkRoster } = await importFromSrc('roster.mjs');
const { CLUSTER_WINDOW_LINES, MAX_CO_CITATIONS_PER_FINDING, makeClaimChecker } =
  await importFromSrc('triage.mjs');



// `allowPositionals` is not optional here. `--round1 run/round1-*.json` is the
// documented invocation and the natural one to type; the shell expands it, and
// with strict parsing the second and later paths arrive as positionals. Node
// then throws ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL and Phase 3 aborts before
// any round-2 work happens. combine.mjs has always accepted them; so does this.
const USAGE = 'Usage: triage.mjs --round1 a.json [--round1 b.json …] [--merge-personas <persona>]… [--plan plan.json] --repo <dir> [--base <ref>] [--gate-file <gate.json> | --gate "<summary>"] [--ledger <ledger.json>] [--probes <probes.json>] --out <briefing.json>';

const { values, positionals } = parseBridgeArgs({
  prefix: 'triage',
  usage: USAGE,
  options: {
    round1: { type: 'string', multiple: true },
    repo:   { type: 'string' },
    base:   { type: 'string' },
    gate:   { type: 'string' },
    'gate-file': { type: 'string' },
    ledger: { type: 'string' },
    probes: { type: 'string' },
    out:    { type: 'string' },
    'merge-personas': { type: 'string', multiple: true },
    plan:   { type: 'string' },
  },
  strict: true,
  allowPositionals: true,
});

values.round1 = [...(values.round1 ?? []), ...positionals];
if (!values.round1.length || !values.repo || !values.out) {
  usage(USAGE);
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
// trace, which is not an exit code at all.
//
// Exit 1, not 2. SKILL.md draws that line for exactly this case — "2 means it
// never read a payload, 1 means it read one that failed the schema" — and this
// payload parsed fine and then failed the schema, which is what validate.mjs
// reports the same way. bridge-io's exit 2 belongs to the read that never
// happened, not to what the bytes turned out to say.
//
// The ELEMENTS too, not only the array. Guarding the container and not its
// contents closed one instance and left the class open: `"findings": [null]`
// still reached normalizeAnchor and threw at src/triage.mjs:49, which is the
// same crash under a different input.
for (let i = 0; i < reviews.length; i += 1) {
  const supplied = reviews[i].findings;
  if (supplied === undefined) continue;
  if (!Array.isArray(supplied)) {
    process.stderr.write(`triage: ${sources[i]}: \`findings\` is not an array`
      + ` (got ${JSON.stringify(supplied)})\n`);
    process.exit(1);
  }
  const bad = supplied.findIndex((f) => !f || typeof f !== 'object' || Array.isArray(f));
  if (bad !== -1) {
    process.stderr.write(`triage: ${sources[i]}: findings[${bad}] is not an object`
      + ` (got ${JSON.stringify(supplied[bad])})\n`);
    process.exit(1);
  }
}

// What earlier iterations already decided. Loading it is file I/O and its
// refusals are exit codes, so it stays here; what the decisions MEAN to a
// finding is src/briefing.mjs's job.
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

// Two gates would be two answers to "may reviewers suppress on this", and the
// briefing carries one. Refuse rather than pick: an ambiguous suppression
// channel is what this flag was added to remove.
if (values.gate !== undefined && values['gate-file'] !== undefined) {
  usage('triage: pass --gate-file or --gate, not both — they are two claims about one gate\n' + USAGE);
}

// A measured record if there is one; otherwise the legacy summary string, which
// src/gate.mjs marks `asserted` and which therefore suppresses nothing.
const gate = values['gate-file'] !== undefined
  ? readJson(values['gate-file'], 'triage')
  : (values.gate ?? null);

const head = resolveRef(repo, 'HEAD');

// Bound to the reviewed HEAD here rather than trusted as written, the same
// treatment the gate gets one line down and for the same reason: Phase 9 loops
// back through this run directory, and a probes.json an earlier iteration left
// behind would otherwise go on confirming findings against a tree that has
// moved. src/probe.mjs's `normalizeProbes` turns every failure into a declined
// probe, which confirms nothing and costs no finding anything.
const probes = values.probes !== undefined
  ? normalizeProbes(readJson(values.probes, 'triage'), { head })
  : null;

const { briefing, stats } = buildBriefing(reviews, {
  base,
  head,
  worktree: worktreeDigest(repo),
  gate,
  checkClaim,
  checkCounterpart,
  ledger,
  probes,
  traceFor: makeAnchorTracer({ repo, to: 'HEAD' }),
});

writeOutput('triage', values.out, JSON.stringify(briefing, null, 2));

const ids = (list) => (list.length ? ` (${list.map((f) => f.id ?? f).join(', ')})` : '');
process.stdout.write(
  `triaged ${briefing.findings.length} findings from ${stats.reviewers} reviewers -> ${values.out}\n`
  + `  clusters (same file, <=${CLUSTER_WINDOW_LINES} lines apart, 2+ reporters): ${briefing.clusters.length}\n`
  + `  claim-check disproved: ${stats.disproved.length}${ids(stats.disproved)}\n`
  + `  malformed anchors coerced away (field kept null): ${stats.rejectedAnchors.length}`
  + `${ids(stats.rejectedAnchors)}\n`
  + `  co-citations (cross-file, or same-file with the line echoed; max`
  + ` ${MAX_CO_CITATIONS_PER_FINDING}/finding): ${briefing.crossReferences.length}`
  + `${briefing.crossReferences.length ? ` (${briefing.crossReferences.map((x) => `${x.from}->${x.to}`).join(', ')})` : ''}\n`
  + `  candidate root causes (proposed, for round 2 to confirm or split): ${briefing.groups.length}`
  + `${briefing.groups.length ? ` (${briefing.groups.map((g) => `${g.id}=${g.members.join('+')}${g.oversized ? ' OVERSIZED' : ''}`).join(', ')})` : ''}\n`
  + `  cited outside the diff (annotated, not rejected): ${stats.outside.length}${ids(stats.outside)}\n`
  + `  under-anchored for their kind (annotated, not rejected): ${stats.underAnchored.length}${ids(stats.underAnchored)}\n`
  + `  advisory (${[...ADVISORY_KINDS].join(', ')} — cannot block): ${stats.advisory.length}${ids(stats.advisory)}\n`
  + `  reproductions the tool re-ran and confirmed: ${stats.demonstrated.length}`
  + `${ids(stats.demonstrated)}\n`
  + `  reproductions that ran without reproducing (annotated, NOT disproved):`
  + ` ${stats.notReproduced.length}${ids(stats.notReproduced)}\n`
  + `  already settled in an earlier iteration: ${stats.settled.length}${ids(stats.settled)}\n`
  + `  REGRESSED (recorded fixed, reported again): ${stats.regressed.length}${ids(stats.regressed)}\n`);
