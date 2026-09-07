// The round-2 briefing: every round-1 finding, identified, claim-checked, and
// grouped into the candidate root causes the edges imply.
//
// This object IS the round-2 prompt. Nothing here decides anything — a group
// is proposed and round 2 rules on it, an under-anchored finding is annotated
// and never dropped, a finding outside the diff is a question for a reviewer
// and not a verdict. What the assembly owes the run is that each of those
// annotations reaches the reviewer intact, because a finding whose anchor was
// silently coerced away reads exactly like a finding that never had one.
//
// Extracted from the triage bridge, where it sat behind argv and a real git
// checkout: every property below needed a subprocess and a throwaway repo to
// observe, so the assembly — as opposed to the pure predicates it calls — was
// the part of triage with the least direct coverage (kfox/adverse#44 item 6).
// It is its own module rather than more of src/triage.mjs, which is already
// past this repo's file-size guidance and whose job is the predicates this
// one wires together.
//
// The repository is injected as `checkClaim`/`checkCounterpart`/`traceFor`
// rather than opened here, so this module stays pure and the bridge keeps the
// I/O and the exit codes. Same split as ledger.mjs's `checkBinding`.

import { emptyLedger, isRegressionCandidate, annotate } from './ledger.mjs';
import { isLaneAgent } from './personas.mjs';
import { ADVISORY_KINDS } from './taxonomy.mjs';
import {
  CLUSTER_WINDOW_LINES, checkKind, clusterFindings, crossReferenceFindings,
  groupFindings, normalizeAnchor,
} from './triage.mjs';
import { mergeSplitReviews, normalizeVerdict } from './synthesis.mjs';

// Anchors are normalized BEFORE anything reads them. `line`, `file`,
// `counterpart` and `detail` come out of a model, and downstream they reach a
// bounds test, a path resolver and a prose scan that each assumed a type
// nothing had established.
// The agent id, coerced toward the persona. An id that does not name its own
// lane is a phantom reviewer, and this string goes in front of every round-2
// agent as the answer to "was this mine?" — so a bad one falls back to the
// lane, where it reads as the whole lane's work and gets examined, rather than
// as a stranger's.
function reporterAgentOf(review) {
  return isLaneAgent(review?.persona, review?.agent) ? review.agent : review?.persona;
}

function ingest(reviews, { checkClaim, checkCounterpart, advisoryKinds }) {
  const findings = [];
  const rejectedAnchors = [];

  for (const review of reviews) {
    for (const f of review.findings ?? []) {
      const id = `F${findings.length + 1}`;
      const { file, line, counterpart, detail, fix, rejected } = normalizeAnchor(f);
      if (rejected.length) rejectedAnchors.push(`${id}.${rejected.join('+')}`);
      findings.push({
        id,
        reporter: review.persona,
        // Which AGENT of that lane, where the lane was split in two. Round 2
        // spawns one agent per round-1 agent, and this is the only field that
        // lets one of them tell its own prior work from its sibling's — without
        // it a split lane's round-2 agent reads every entry under its persona
        // as its own and passes the lot through unexamined, which is half the
        // cost kfox/adverse#50 names. Always present, equal to `reporter` for
        // an unsplit lane: a field that appears only sometimes is one every
        // consumer has to guess about.
        reporterAgent: reporterAgentOf(review),
        // On the FINDING, not only on stdout. A coerced-away anchor left the
        // briefing looking exactly like a finding whose reporter never
        // supplied one — and briefing.json is what round 2 reads, so the
        // reviewer judging "is this under-anchored?" could not see that an
        // anchor had been offered and thrown away.
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
        kindCheck: checkKind(f.kind, file, line, counterpart, { advisoryKinds }),
      });
    }
  }

  return { findings, rejectedAnchors };
}

// A split lane arrives as two payloads under one persona, and
// Object.fromEntries is last-key-wins — which replaced half B's reject with
// half A's approve in the one text every round-2 reviewer reads. Merged with
// the same semantics combine.mjs uses, from the same export, so the combined
// payload and this briefing cannot disagree.
function mergeVerdicts(reviews) {
  return reviews.reduce((acc, r) => {
    const prev = acc[r.persona];
    const merged = prev ? mergeSplitReviews(prev, r) : r;
    acc[r.persona] = { verdict: normalizeVerdict(merged.verdict), summary: merged.summary };
    return acc;
  }, Object.create(null));
}

// Every finding sharing a file with another reporter's, regardless of line
// distance — a wider net than `clusters`, and reported separately from it.
function sameFileDifferentRegion(findings) {
  const byFile = new Map();
  for (const f of findings) {
    if (!f.file) continue;
    if (!byFile.has(f.file)) byFile.set(f.file, []);
    byFile.get(f.file).push(f);
  }
  return [...byFile]
    .filter(([, g]) => new Set(g.map((f) => f.reporter)).size >= 2)
    .map(([file, g]) => ({ file, ids: g.map((f) => f.id) }));
}

// What earlier iterations already decided. Positions in the ledger were
// recorded against the commit the decision was made at, so each is
// re-projected before matching — otherwise a fix that shifted the file makes
// every past decision look like a different finding.
function adjudicate(findings, ledger, traceFor) {
  const annotated = annotate(findings, ledger, traceFor);
  for (let i = 0; i < findings.length; i += 1) {
    if (annotated[i].adjudicated) findings[i].adjudicated = annotated[i].adjudicated;
  }
}

export function buildBriefing(reviews, {
  base,
  gate = null,
  checkClaim,
  checkCounterpart,
  ledger = emptyLedger(),
  traceFor = (anchor) => anchor,
  advisoryKinds = ADVISORY_KINDS,
  windowLines = CLUSTER_WINDOW_LINES,
} = {}) {
  const { findings, rejectedAnchors } = ingest(reviews,
    { checkClaim, checkCounterpart, advisoryKinds });

  // Same-file-and-nearby-lines, and cross-file co-citation: the two consensus
  // edges a title-only join cannot see.
  const clusters = clusterFindings(findings, { windowLines });
  const crossReferences = crossReferenceFindings(findings);

  // Neither edge set closes the relation on its own: A~B and B~C left three
  // findings to remediate, decide, and ledger separately. Connected components
  // close it and carry every member along as a citation. Proposed only.
  const groups = groupFindings(findings, { clusters, crossReferences, advisoryKinds });

  adjudicate(findings, ledger, traceFor);
  const settled = findings.filter((f) => f.adjudicated?.settled);
  // The same predicate convergenceStatus uses, imported rather than re-spelled
  // — a copy of it had drifted to "annotated and unsettled", which calls a
  // brand-new finding REGRESSED because a line-less decline sits somewhere in
  // its file. `regressed` IS the round-2 prompt, so that is a false claim made
  // to a reviewer about work that was never done.
  const regressed = findings.filter(isRegressionCandidate);

  const briefing = {
    base,
    gate,
    verdicts: mergeVerdicts(reviews),
    findings,
    clusters,
    crossReferences,
    groups,
    settled: settled.map((f) => f.id),
    regressed: regressed.map((f) => f.id),
    sameFileDifferentRegion: sameFileDifferentRegion(findings),
  };

  // What the bridge prints. Derived here so the summary line and the briefing
  // cannot describe different runs, formatted there because the shape of a
  // terminal line is the bridge's business.
  const stats = {
    reviewers: reviews.length,
    rejectedAnchors,
    disproved: findings.filter((f) => f.claimCheck.status === 'DISPROVED'
      || f.counterpartCheck?.status === 'DISPROVED'),
    underAnchored: findings.filter((f) => f.kindCheck.status !== 'ok'),
    advisory: findings.filter((f) => f.kindCheck.advisory === true),
    outside: findings.filter((f) => f.claimCheck.inDiff === 'outside'),
    settled,
    regressed,
  };

  return { briefing, stats };
}
