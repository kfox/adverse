// Fold fix-agent payloads into the `decisions.json` that `converge.mjs
// --record` appends to the ledger.
//
// The third list is why this file exists, and it exists because of one measured
// failure. A fix agent's report named `preflight_emu is not budgeted` under a
// heading that explicitly said "out of scope, named not fixed". The
// orchestrator read it and recorded nothing. The next iteration, TWO
// independent round-1 reviewers found it — a full lane-pair's attention
// re-deriving a conclusion that was already written down in the previous
// iteration's own artifacts. The agent behaved correctly: it found something
// outside its brief, refused to widen its own scope, and said so. The handoff
// dropped it.
//
// "Read the reports carefully" was already the rule for findings and still
// missed this one, which is why the channel is code rather than more prose. The
// item arrives at the worst possible moment — the end of a long report, while
// the orchestrator is reconciling several such reports and preparing a commit —
// and everything else in that report is about work that WAS done. It reads as a
// footnote and it is a finding.
//
// `fixed` and `declined` are folded here too, though only the third list was
// asked for. Leaving them out would leave the orchestrator hand-assembling two
// thirds of decisions.json out of identity fields the payload already carries,
// and that hand is the defect source #17 removed from every other leg of this
// flow: transcription drift, truncated `detail` fields, a decision recorded
// from memory that had never been written to a file at all.

// Ids for items nobody ever assigned one. Two letters so it cannot collide with
// triage's `F<n>` or its root causes' `G<n>`, and it carries the batch label so
// two fix agents folded in separate invocations cannot both mint `NF1` for
// different items. Nothing matches on ids — SKILL.md Phase 9 says they are
// per-run and re-derived — so this is for whoever reads the ledger afterward,
// and which batch noticed the item is most of what they want to know.
const namedItemId = (agent, n) => `NF-${agent}-${n}`;

// Every item a fix agent named but did not fix defaults to this. #49 says the
// agent's own reasoning is usually the right disposition, and `isSettled`
// counts `deferred` as settled — but SETTLING_SCORE is 3, which only an
// identical title reaches, so a near-miss comes back annotated with this reason
// attached rather than silently dropped. That is the safe direction: a wrong
// settle is silent and loses a real finding, a missed settle is noisy and costs
// one line to re-decide.
const NAMED_NOT_FIXED_DISPOSITION = 'deferred';

// `recordDecisions` throws on a decision with no reason, three frames
// downstream, in a message that names the ledger rather than the payload that
// caused it. Refusing here means the operator is told which item, in which
// batch, is unexplained.
function requireReason(text, what) {
  const reason = String(text ?? '').trim();
  if (!reason) {
    throw new Error(`${what} has no reason; an unexplained decision cannot be reviewed `
      + 'later and the ledger refuses it');
  }
  return reason;
}

function requireTitle(title, what) {
  const t = String(title ?? '').trim();
  if (!t) throw new Error(`${what} has no title; title is what the next pass matches on`);
  return t;
}

// The identity fields `scoreMatch` reads next iteration. Copied straight
// through: an entry written from a shorter example matches nothing, and the
// finding it decided is re-raised from scratch on the next pass.
function toDecision(d, disposition, agent) {
  const label = `${disposition} decision ${JSON.stringify(d?.title)} from ${agent}`;
  return {
    id: d.id ?? null,
    title: requireTitle(d.title, label),
    kind: d.kind ?? null,
    severity: d.severity ?? null,
    confidence: d.confidence ?? null,
    file: d.file ?? null,
    line: d.line ?? null,
    counterpart: d.counterpart ?? null,
    disposition,
    reason: requireReason(d.reason, label),
    reporters: [agent],
  };
}

// `reason` is the only free-text field `recordDecisions` preserves, so a
// suggestion that does not go in it is a suggestion that is lost. Appended
// rather than dropped; `clipReason` bounds the rendered form at 500 characters,
// which is a reason to keep `detail` short and not a reason to discard the
// remedy the agent already worked out.
function toNamedNotFixed(item, agent, n) {
  const label = `named-not-fixed item ${JSON.stringify(item?.title)} from ${agent}`;
  const detail = requireReason(item.detail, label);
  const suggestion = typeof item.suggestion === 'string' ? item.suggestion.trim() : '';
  return {
    id: namedItemId(agent, n),
    title: requireTitle(item.title, label),
    kind: item.kind ?? null,
    // No severity: nobody triaged this item, and `scoreMatch` treats a missing
    // severity as equal to nothing, including another missing one. That costs a
    // positional match the stronger of two annotation scores and costs settling
    // nothing at all, since only an identical title settles a decision.
    severity: null,
    confidence: null,
    file: item.file ?? null,
    line: item.line ?? null,
    counterpart: null,
    disposition: NAMED_NOT_FIXED_DISPOSITION,
    reason: suggestion ? `${detail} Suggested: ${suggestion}` : detail,
    reporters: [agent],
  };
}

function requireAgent(payload) {
  const agent = payload?.agent;
  if (typeof agent !== 'string' || !agent.trim()) {
    throw new Error('a fix payload has no `agent` label; run validate.mjs --phase fix first');
  }
  return agent;
}

// Every decision a batch of fix payloads implies, in payload order, ready for
// `recordDecisions`.
//
// Callers are expected to have run `validateFix` first — the bridge does — and
// the guards above are deliberately kept anyway. A caller that skipped the
// validator must not be able to mint an entry that dies inside the ledger; that
// is the failure the whole channel exists to stop, and it would arrive wearing
// the ledger's name.
export function foldFixPayloads(payloads) {
  const decisions = [];
  for (const payload of payloads) {
    const agent = requireAgent(payload);
    for (const d of payload.fixed ?? []) decisions.push(toDecision(d, 'fixed', agent));
    for (const d of payload.declined ?? []) decisions.push(toDecision(d, 'declined', agent));
    (payload.named_not_fixed ?? []).forEach((item, i) => {
      decisions.push(toNamedNotFixed(item, agent, i + 1));
    });
  }
  return decisions;
}
