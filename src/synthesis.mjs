// Deterministic synthesis: turn a set of round-1 reviews and a set of round-2
// cross-reviews into a single ranked report.
//
// Deliberately no fixed counts here, because the two callers differ and a
// number written down in this header has now been wrong twice. `src/cli.mjs`
// builds round 2 from every persona that produced a round-1 review, so it runs
// four and four. The Skill (`skills/adverse-review/SKILL.md`) skips the
// Pragmatist in round 2 — cross-validation exists to decide what BLOCKS and
// nothing advisory can, so its skipped call pays for the Steward's round 1 —
// and runs four and three. Synthesis does not care: it reads whatever reviews
// it is given and treats a missing round 2 as an empty cross-review.
//
// Why deterministic (not another LLM call): a fourth model invocation costs
// more, adds another failure mode, and would itself be subject to the same
// single-model bias the personas have. Cross-validation BETWEEN personas is
// the signal — we just count and present it.
//
// Confidence taxonomy:
//  - cross-validated : reported by ≥2 personas (no explicit cross-review needed)
//  - consensus       : reported by ≥1 persona AND validated by ≥1 other in round 2
//  - disputed        : reported by ≥1 persona AND challenged by ≥1 other
//  - solo            : reported by exactly 1 persona, no validate, no challenge
//
// A finding can be both `consensus` (one validates) and `disputed` (another
// challenges) — we mark it `disputed` because the dispute is the more
// interesting signal to a human reader.
//
// Orthogonal to both severity and confidence is `kind` (see src/taxonomy.mjs),
// which answers "what evidence would settle this". It is what makes an
// automated stop condition possible: `design` findings are advisory, because a
// reviewer can always want different structure and so a loop that counts them
// never terminates. `openBlocking` is the resulting signal — the findings that
// are both credible enough (demonstrated, cross-validated or consensus) and consequential
// enough (not advisory, not `info`) to hold a change open.

import { refuseDirectRun } from './entryGuard.mjs';
import { fenced, flatten, quoted, verbatim, verbatimCell } from './markdown.mjs';
import { isLaneAgent } from './personas.mjs';
import { indexProbes, probeDeclaration, probeKey, probeState } from './probe.mjs';
import { ADVISORY_KINDS, GROUP_RULINGS, KINDS, PROVENANCE, ROOT_CAUSE_STATUSES, SEVERITY_RANK,
         assertCoversConfidences, assertCoversStatuses } from './taxonomy.mjs';

refuseDirectRun(import.meta.url);

// Verdict → score mapping. The natural symmetric choice: approve and reject
// cancel each other out, conditional carries half-weight on the approve side.
// The mean across reviewers gives the final score in [-1, 1].
const verdictScores = { approve: 1, conditional: 0.5, reject: -1 };

// Split-lane merge semantics, shared by the combine and triage bridges so the
// combined payload and the briefing cannot disagree about what a split lane
// concluded. An off-contract verdict normalizes to `reject`: the scorer above
// treats an unknown string as 0 (better than reject's -1) and consensusLabel
// counts only the literal `reject` as a block, so letting garbage through is
// the one direction that can erase a real rejection.
export const VERDICT_RANK = { reject: 0, conditional: 1, approve: 2 };

export function normalizeVerdict(v) {
  return Object.hasOwn(VERDICT_RANK, v) ? v : 'reject';
}

export function worseVerdict(a, b) {
  const na = normalizeVerdict(a);
  const nb = normalizeVerdict(b);
  return VERDICT_RANK[na] <= VERDICT_RANK[nb] ? na : nb;
}

// Union a split lane's two payloads: findings concatenate, the worse verdict
// wins, and BOTH summaries survive — a verdict from one half rendered beside
// the other half's summary reads as one reviewer's position, and is not.
// Each half is bounded BEFORE the join, at the per-reviewer contract limit
// (prompts.mjs promises "<= 200 chars"), so a half that honors the contract
// loses nothing in the persisted payload — this merge feeds round1.json and
// the triage briefing, not just a report cell — while a runaway half cannot
// amputate the other, which is exactly the voice the merge exists to keep.
// The summary cell cap below is derived from this bound for the same reason.
const MERGED_SUMMARY_PART_MAX = 200;
const SUMMARY_CELL_MAX = 2 * MERGED_SUMMARY_PART_MAX + ' · '.length;

// ---------- Agent identity ---------------------------------------------------
//
// A lane split across two agents writes ONE persona name from both halves, on
// purpose: `reporters` dedupes on persona, so two halves finding the same thing
// cannot inflate it to `cross-validated`. That property is untouched here.
// What the persona name cannot do is tell `auditor-a` from `auditor-b`, and
// round 2's self-validation guard needs exactly that — `-b` read different
// files and its judgment on `-a`'s findings is as independent as any other
// lane's, but the guard used to discard it as the lane rubber-stamping itself.
//
// Three questions, one rule underneath: an id counts only if it names its own
// lane (src/personas.mjs, `isLaneAgent`). Everything else resolves toward the
// persona, which is the behavior that predates this field.

// The id an entry claims, or null when it claims none the lane will vouch for.
// An entry stamped by a split-lane merge answers for itself; otherwise the
// payload answers for all of its entries.
function claimedAgent(persona, payload, entry) {
  const claimed = coerceStr(entry?.agent) ?? coerceStr(payload?.agent);
  return isLaneAgent(persona, claimed) ? claimed : null;
}

// Who REPORTED an entry. The bare persona is a legitimate answer here — an
// unsplit lane reports as itself — so nothing is refused, only defaulted.
function entryAgent(persona, payload, entry) {
  return claimedAgent(persona, payload, entry) ?? persona;
}

// Which HALF of a lane is making a round-2 ruling, or null for "the lane
// itself". Null is the fail-closed default, and it is the answer in three
// cases: the payload named no agent, it named one that does not belong to this
// lane, or it named the bare persona. The first is an orchestrator that
// predates agent ids, and it must keep getting today's persona-level behavior
// — otherwise doing nothing would silently start counting a lane's ruling on
// its own finding as independent, which is the one direction this change must
// not fail. The third is a payload claiming to BE the whole lane: a claim to
// contain both halves, so it can be neither of them.
function rulingAgent(persona, payload, entry) {
  const agent = claimedAgent(persona, payload, entry);
  return agent === persona ? null : agent;
}

// ---------- Provenance ------------------------------------------------------
//
// "A fix commit's regression pass found this" and "round 2 noticed this" are
// different facts, and an operator reading a ranked list cannot act on the
// first without knowing which it is — the stamp records which pass found the
// finding, never that the fix caused it; causation lives in the
// classification. Both arrive as `added` findings — a regression found against
// a commit that already landed IS the `added` shape, and giving it a parallel
// channel would mean every consumer of `findings` had to learn about a second
// one — so the distinction rides on the finding instead.
//
// Read from the ENTRY first and the payload second, the same order
// `claimedAgent` uses and for the same reason: a split-lane merge unions two
// payloads' entry lists under one payload header, so an identity that lives
// only on the header is one the merge cannot carry.
function provenanceOf(payload, entry) {
  return entry?.provenance === PROVENANCE.regression
    || payload?.provenance === PROVENANCE.regression
    ? PROVENANCE.regression : PROVENANCE.review;
}

// The other half of that rule: WHO may write the field it reads.
//
// `provenanceOf` trusts the file, and the file is written by a bridge —
// skills/adverse-review/scripts/regression.mjs stamps `regression` on the
// findings a Phase 9 pass produced, after validating the pass's own payload.
// Nothing checked that, so any reviewer could put the key on an ordinary
// round-1, round-2 or verify finding and buy the report's loudest label.
// Measured before this guard, on a plain `round1-auditor.json` whose finding
// carried `"provenance": "regression"`:
//
//   validate.mjs --phase round1 round1-auditor.json   ->  ok (auditor), exit 0
//   the rendered report              ->  _Reported by: auditor · confidence:
//                                        solo · found by the regression pass on
//                                        a fix commit that landed_
//
// No pass ran, no commit was named, and that sentence is the one that points a
// human at a revert. So the field is INADMISSIBLE from an agent — refused, not
// stripped, because a reviewer that wrote it either misread the schema or was
// reaching for a label it has not earned, and each is worth a sentence back.
// What a bridge stamps, it stamps after this check.
//
// Every list of objects on the payload is swept, not a named few: `findings`,
// `added`, `verified`, `validate`, `challenge` and whatever a later phase adds
// all reach a reader eventually, and a whitelist would have to be edited by
// whoever adds the next one. Depth one is enough because that is the depth at
// which `provenanceOf` reads.
const BRIDGE_STAMPED_FIELD = 'provenance';

// `key` is PAYLOAD-CHOSEN and both callers print this claim straight to stderr,
// so an ordinary key is named as-is and anything else is quoted. A key spelled
// `findings\n/x/round1-adversary.json: ok (adversary)\nfindings` made
// `validate.mjs --phase round1` emit forged `ok (<persona>)` lines for lanes
// whose files do not exist — the hazard validate.mjs already names for the
// `agent` label, twenty-six lines above the call site this went through.
//
// Quoting only the odd ones on purpose: the message's job is to NAME the field,
// and the tests pin that (`findings[1].provenance`). Quoting unconditionally
// made every honest message read `"findings"[1].provenance`.
//
// Bounded as well as quoted, because the sink is not only a terminal: SKILL.md
// tells the orchestrator to append this bridge's stderr line to the retry
// prompt it sends the agent. Measured before the bound: a 2.16 MB key produced
// a single 2,160,328-byte stderr message in 0.05 s. `MAX_REASON_CHARS` in
// src/limits.mjs bounds ledger text for exactly this reason; the length here is
// its own constant rather than an import, since a field NAME needs far less
// room than a sentence and one number serving two purposes is how the next one
// drifts.
const PLAIN_KEY = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const MAX_KEY_CHARS = 80;
const nameKey = (key) => {
  const clipped = key.length > MAX_KEY_CHARS
    ? `${key.slice(0, MAX_KEY_CHARS)}… [clipped]` : key;
  return PLAIN_KEY.test(clipped) ? clipped : JSON.stringify(clipped);
};

function payloadStampSite(payload) {
  if (BRIDGE_STAMPED_FIELD in payload) return BRIDGE_STAMPED_FIELD;
  for (const [key, list] of Object.entries(payload)) {
    if (!Array.isArray(list)) continue;
    const at = list.findIndex((e) => e && typeof e === 'object' && BRIDGE_STAMPED_FIELD in e);
    if (at !== -1) return `${nameKey(key)}[${at}].${BRIDGE_STAMPED_FIELD}`;
  }
  return null;
}

export function stampedFieldClaim(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const site = payloadStampSite(payload);
  if (!site) return null;
  return `\`${site}\` is stamped by the bridge that writes a regression pass to disk,`
    + " not claimed by a payload: it is what makes the report say a fix commit's"
    + ' regression pass found a finding. Remove the key.';
}

// What the report says beside a finding the regression pass found. Spelled out
// rather than printing the bare word: `regression` next to `confidence: solo`
// reads as another confidence label, and the fact that matters to a reader
// deciding what to do is that a commit which already landed introduced it.
const REGRESSION_NOTE = 'found by the regression pass on a fix commit that landed';

// The agent a whole payload was written by, read off the payload's own
// persona because a bridge merging two files has no key to consult.
function payloadAgent(payload) {
  const persona = coerceStr(payload?.persona);
  return claimedAgent(persona, payload, null) ?? persona;
}

// Stamp each half's entries with the agent that produced them, before the two
// lists become one list under one persona name. This has to be a JSON field
// and not a closure: combine.mjs writes the merged object to round1.json and
// synthesis reads it back out of the file, so an identity that lives anywhere
// but in the payload is an identity the second half of the pipeline cannot
// see. Unconditional, overwriting whatever the reporter put there — the stamp
// is what the round-2 guard keys on, and a payload that names its sibling on
// its own finding would hand its sibling's ruling an independent vote.
function stampAgent(payload, key) {
  const agent = payloadAgent(payload);
  const entries = Array.isArray(payload?.[key]) ? payload[key] : [];
  return entries.map((e) => (e && typeof e === 'object' && !Array.isArray(e)
    ? { ...e, agent }
    : e));
}

// The merged object describes a LANE, so every field on its header has to be
// true of the whole lane. The header is BUILT from the fields that are, rather
// than inherited from half A with subtractions, because the subtracting form
// was wrong within one commit of being written: it deleted `agent` — half A's
// id left there labels half B's verdict, summary and findings with half A's
// name — and then `provenance` arrived on a payload header, rode the `{ ...a }`
// spread onto the merged lane, and `provenanceOf`'s payload fallback stamped
// half B's ordinary findings "found by the regression pass on a fix commit that
// landed", which is the one label that points a human at a revert.
//
// Two more per-half fields were already riding along by then: `verified`
// (verify.mjs) and `passes` (regression.mjs), each a record of what ONE half
// checked, presented on the merged header as the lane's. They are dropped here
// with the rest, and nothing is lost that is not still on disk: the
// `round1-<persona>.verified.json` and `.regression.json` halves combine.mjs
// read keep those lists beside their own persona, correctly attributed.
//
// A denylist has to be edited every time a payload grows a field, and a field
// nobody remembered fails toward a lie about the other half. This way it fails
// toward a missing line.
const LANE_HEADER_KEYS = ['persona'];

function mergedLane(a) {
  const lane = {};
  for (const key of LANE_HEADER_KEYS) {
    if (a?.[key] !== undefined) lane[key] = a[key];
  }
  return lane;
}

export function mergeSplitReviews(a, b) {
  const part = (s) => String(s ?? '').slice(0, MERGED_SUMMARY_PART_MAX);
  return {
    ...mergedLane(a),
    verdict: worseVerdict(a?.verdict, b?.verdict),
    summary: [a?.summary, b?.summary].filter(Boolean).map(part).join(' · '),
    findings: [...stampAgent(a, 'findings'), ...stampAgent(b, 'findings')],
  };
}

// The round-2 counterpart. Merging two cross-reviews used to be refused
// outright, and the reason was sound: both halves write one persona name, so a
// union handed synthesis two payloads' rulings with no way to tell which agent
// made which — and the self-validation guard, keyed on the persona, discarded
// every one of them. Once each entry carries its own agent (above), the union
// is the whole point: `auditor-b` read different files and its judgment on
// `auditor-a`'s findings is as independent as any other lane's.
//
// `groups` is unioned for the same reason the other three lists are — a
// dropped ruling is a candidate root cause reported as unruled — and it is
// safe to let one persona appear twice there: `buildRootCauses` counts voices
// with a Set, and two halves that disagree land the group on `contested`,
// which dissolves nothing and decides every citation individually.
export function mergeSplitCrossReviews(a, b) {
  return {
    ...mergedLane(a),
    validate: [...stampAgent(a, 'validate'), ...stampAgent(b, 'validate')],
    challenge: [...stampAgent(a, 'challenge'), ...stampAgent(b, 'challenge')],
    groups: [...stampAgent(a, 'groups'), ...stampAgent(b, 'groups')],
    added: [...stampAgent(a, 'added'), ...stampAgent(b, 'added')],
  };
}
// Sort order within a severity, lowest first — a DIFFERENT question from
// CONFIDENCE_ORDER below, which is the order the report's SECTIONS appear in.
// `disputed` sits high here because a contested finding is the one a human most
// needs to look at; `demonstrated` sits above it because a behavior that was
// observed to happen is not in contest, whatever anyone argued.
const CONFIDENCE_RANK = assertCoversConfidences(
  { demonstrated: 0, disputed: 1, 'cross-validated': 2, consensus: 3, solo: 4 },
  'synthesis CONFIDENCE_RANK');

function severityRank(s) {
  return SEVERITY_RANK[s] ?? 99;
}

function normTitle(t) {
  return t.toLowerCase().split(/\s+/).join(' ').replace(/[.:,;!?]+$/, '');
}

function coerceInt(v) {
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  if (typeof v === 'string') {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function coerceStr(v) {
  return typeof v === 'string' && v.trim() ? v : null;
}

// A finding whose `kind` is missing or unrecognized is UNCLASSIFIED, and
// unclassified blocks. Defaulting the other way would let a real finding slip
// past the gate by arriving mislabeled, which is the one failure this axis must
// not introduce.
export const UNCLASSIFIED = 'unclassified';

function coerceKind(v) {
  return typeof v === 'string' && v.trim() ? v.trim() : UNCLASSIFIED;
}

export function isBlocking(finding) {
  return !ADVISORY_KINDS.has(finding.kind) && finding.severity !== 'info';
}

// Did the agent making a ruling already report the finding it is ruling on?
// The lane-level answer stands unless a payload named a half of a split lane,
// and even then a finding the whole lane reported — `reporterAgents` carrying
// the bare persona, which is what an unsplit or unstamped round 1 produces —
// is still that agent's own work.
function reportedBy(finding, persona, agent) {
  if (!finding.reporters.includes(persona)) return false;
  if (agent === null) return true;
  return finding.reporterAgents.includes(agent)
    || finding.reporterAgents.includes(persona);
}

// The same question for a GROUP ruling: is the reviewer that ruled the only
// reporter of every citation, i.e. a reviewer confirming that its own findings
// are one thing? Asked through `reportedBy` so the two answers cannot drift —
// keying this one on the persona alone made a split lane's two halves
// independent for a validate edge and one reviewer for a group ruling, and
// `auditor-b`'s ruling on `auditor-a`'s citations was discarded as
// self-ruling. An unresolved citation has no `reporterAgents` to consult, so
// its claimed reporter answers for the agents too: that reads as self-ruling,
// which costs a voice rather than minting one.
function ruledOnOwnCitations(ruling, citations) {
  return citations.every((c) => {
    const reporters = c.reporters ?? [c.reporter];
    const reporterAgents = c.reporterAgents ?? reporters;
    return reporters.length === 1
      && reportedBy({ reporters, reporterAgents }, ruling.persona, ruling.agent);
  });
}

// Who a group ruling speaks as: the half of a split lane that declared itself,
// the lane otherwise. Exported because both renderers have to answer it the
// same way — each printed `r.persona`, so a split lane's two rulings arrived as
// two indistinguishable `auditor` blocks claiming two reviewers where there was
// one lane.
export function rulingVoice(ruling) {
  return ruling.agent ?? ruling.persona;
}

// One entry per PERSONA, whatever agent produced it. A split lane's two halves
// can both rule on the same finding now, and `validators.length` is what turns
// a finding into `consensus` while the group `voices` count decides whether a
// root cause collapses — two entries under one persona would be one lane
// counted twice, which is precisely the inflation the halves' shared persona
// name exists to prevent. First ruling wins; a sibling that agrees adds no
// information, and one that disagrees is a lane arguing with itself, which is
// not a second voice either way.
function recordRuling(list, persona, reason) {
  if (list.some((e) => e.persona === persona)) return;
  list.push({ persona, reason });
}

// The stop condition and the report's headline number are the same question —
// "is this both blocking and credible enough to hold the change open?" —
// asked on either side of the report.json serialization boundary. Defined
// over `{kind, severity, confidence}` alone (not `.blocking`, which only the
// serialized shape carries) so it works unchanged on an in-memory finding
// here and on one `convergenceStatus` reads back out of a report.
// `demonstrated` joins the two counted labels rather than replacing either.
// The question this asks is "is the evidence strong enough to hold the change
// open", and a reproduction src/probe.mjs re-ran and watched succeed is the
// strongest answer this flow can produce — stronger than two reviewers who
// agree, which is what the other two labels mean. A demonstrated finding that
// only one lane reported would otherwise be `solo` and dropped by this gate,
// which is precisely the hole the probe exists to fill.
export function isOpenBlocking(finding) {
  return isBlocking(finding)
    && (finding.confidence === 'demonstrated'
      || finding.confidence === 'cross-validated'
      || finding.confidence === 'consensus');
}

// A finding's probe: the strongest one any of its reporters attached. A finding
// two lanes reported can carry a probe from each, and one reproduction that ran
// is what the label turns on — so a confirmed probe wins over an unconfirmed
// one, and reporter order decides only among equals.
function pickProbe(index, finding) {
  let fallback = null;
  for (const persona of finding.reporters) {
    const p = index.get(probeKey(persona, finding.title));
    if (!p) continue;
    if (p.confirmed) return p;
    fallback ??= p;
  }
  return fallback;
}

function buildFinding(persona, raw, agent = persona) {
  const title = coerceStr(raw?.title);
  const severity = raw?.severity;
  if (!title || !(severity in SEVERITY_RANK)) return null;
  return {
    severity,
    kind: coerceKind(raw?.kind),
    title: title.trim(),
    detail: (coerceStr(raw?.detail) ?? '').trim(),
    file: coerceStr(raw?.file),
    line: coerceInt(raw?.line),
    counterpart: coerceStr(raw?.counterpart),
    fix: coerceStr(raw?.fix),
    reporters: [persona],
    // Which AGENTS reported it, beside which lanes did. A split lane's two
    // halves write one persona name deliberately — `reporters` deduping on it
    // is what stops two halves inflating a finding to `cross-validated` — so
    // round 2 needs a second string to tell `auditor-a` from `auditor-b`.
    // Confidence never reads this list; only the self-validation guard does.
    reporterAgents: [agent],
    // Which pass produced this finding — an ordinary review round, or a
    // regression pass over a fix commit that already landed. Declared here so
    // the field exists on every finding whether or not a run ran the pass; a
    // shape that appears only sometimes is one every consumer has to guess
    // about. `upsert` promotes it, so the default is the quiet one.
    provenance: PROVENANCE.review,
    validators: [], // Array<{persona, reason}>
    challengers: [],
    confidence: 'solo',
    // The root cause this finding is a citation of, once round 2 has been
    // read. Declared here so the field exists whether or not a run grouped
    // anything — a shape that appears only sometimes is one every consumer
    // has to guess about.
    group: null,
    // The reproduction its reporter attached, once src/probe.mjs has re-run it
    // — never what the reporter said about it. Declared here for the same
    // reason as `group`, and null on every run that did not probe.
    probe: null,
  };
}

// Attach round 2's rulings to the candidate root causes triage proposed, and
// resolve each citation back to the finding it names.
//
// The unit of REPORT and DECISION becomes the group; the unit of CONFIDENCE
// stays the finding, and nothing here touches it. That separation is the whole
// safety argument: distinct-persona counting is what makes consensus mean
// something, and a group that let one lane's three findings read as three
// voices would counterfeit exactly the signal the design trusts most.
//
// Five states, and only one of them collapses anything:
//
//   confirmed  every ruling says `one` — a single fix, a single disposition,
//              with its citations attached
//   split      every ruling says `split` — the proposal was wrong; the
//              citations are independent findings and are decided that way
//   contested  the rulings disagree. Not a verdict, and not a collapse: the
//              citations stay individually decidable, like a `disputed`
//              finding stays blocking until someone decides it
//   oversized  ruled `one`, but carrying more citations than one disposition
//              can honestly cover (src/triage.mjs, MAX_CONFIRMABLE_MEMBERS)
//   proposed   nobody ruled — the pre-grouping behavior, kept as the default
//
// Every state but `confirmed` leaves the members exactly as they were, so a
// missing, contested, or oversized ruling costs the speedup and never a
// finding.
// How many independent personas must rule `one` before a candidate root cause
// becomes a confirmed one. Two, for the same reason the report's own
// confidence labels need two: a confirmed group is one fix and one disposition
// covering N findings, and a single unopposed voice — potentially the sole
// reporter of every member — deciding that inverts the design's own rule that
// cross-validation is what makes agreement trustworthy. Falling short is
// `proposed`, which costs only the remediation shortcut and never a finding.
const MIN_CONFIRMING_VOICES = 2;

function buildRootCauses(groups, round2, findByTitle) {

  const rulingsById = new Map();
  for (const [persona, cross] of Object.entries(round2)) {
    for (const r of cross?.groups ?? []) {
      if (!r || typeof r !== 'object' || !GROUP_RULINGS.has(r.ruling)) continue;
      if (!rulingsById.has(r.id)) rulingsById.set(r.id, []);
      // The agent rides along: `mergeSplitCrossReviews` stamps it onto every
      // unioned `groups` entry for exactly this reader, and dropping it here
      // cost two things at once — the report could not say which half ruled,
      // and `selfRuled` could not tell a sibling's ruling from the lane's own.
      // Null means "the lane itself", which is what `rulingAgent` fails
      // closed to.
      rulingsById.get(r.id).push({
        persona,
        agent: rulingAgent(persona, cross, r),
        ruling: r.ruling,
        reason: (coerceStr(r.reason) ?? '').trim(),
      });
    }
  }

  return groups.map((g) => {
    const rulings = rulingsById.get(g.id) ?? [];
    const verdicts = new Set(rulings.map((r) => r.ruling));


    // A citation naming a title synthesis never built is reported unresolved
    // rather than dropped: the finding may have been rejected upstream for a
    // missing severity, and a citation that quietly disappears makes a group
    // of three look like a group of two.
    const citations = (g.citations ?? []).map((c) => {
      const f = findByTitle(c.title);
      return {
        ...c,
        resolved: Boolean(f),
        confidence: f?.confidence ?? null,
        blocking: f ? isBlocking(f) : null,
        fix: f?.fix ?? null,
        // The briefing's `reporter` is what the payload CLAIMED; the finding's
        // own `reporters` is what synthesis actually resolved. Where they
        // disagree, the group was reporting the unverified one.
        reporters: f?.reporters ?? null,
        // Which AGENTS reported it, at the granularity a split lane needs: the
        // group ruling below asks whether the half that ruled is the one that
        // reported, and `reporters` answers only for the lane.
        reporterAgents: f?.reporterAgents ?? null,
      };
    });

    // Anchor first, then worst severity, then the order triage assigned. Every
    // scalar below reads this list, so the group's headline and its fix cannot
    // describe different citations — which they did whenever the first citation
    // by ID order was not the worst one, i.e. most of the time.
    const ranked = [...citations].sort((a, b) =>
      (b.id === g.anchor ? 1 : 0) - (a.id === g.anchor ? 1 : 0)
      || severityRank(a.severity) - severityRank(b.severity));

    // Resolved reporters where synthesis has them, the citation's claim only
    // where it does not — an unresolved citation should not erase a reporter,
    // but it should not silently vouch for one either.
    //
    // And a citation that claims no reporter contributes nobody, rather than
    // an undefined that serializes as `null`: that phantom counted as one
    // reviewer in the PR comment and rendered as the word "null" in the HTML,
    // which is the vouching this list is careful not to do, spelled by an
    // absence instead of a name.
    //
    // ABSENT, not merely unusable. These groups are read off a briefing file
    // whose caller checks only that it is an array, so a `reporter` can arrive
    // as a number or an object — and dropping those too would put the same
    // "0 reviewers" in a permanent PR comment with nothing said about why.
    // They go on, to the renderer that refuses them by name.
    const reporters = [...new Set(citations.flatMap((c) => c.reporters ?? [c.reporter])
      .filter((lane) => lane !== undefined && lane !== null))];

    // A ruling from the reviewer that is the only reporter of every citation is
    // that reviewer confirming that its own findings are one thing. `validate`
    // and `challenge` already skip such an edge; a group ruling had no such
    // guard.
    //
    // Excluded by identity, not by name: two rulings can share a persona (one
    // per half of a split lane), and excluding by name threw away the half that
    // had not reported anything along with the half that had. `voices` still
    // counts PERSONAS, so two halves agreeing remain one voice and cannot reach
    // MIN_CONFIRMING_VOICES between them.
    const selfRulings = rulings.filter((r) => ruledOnOwnCitations(r, citations));
    // Deduped and named per agent: `['auditor','auditor']` printed one lane
    // twice, as if a second reviewer had ruled.
    const selfRuled = [...new Set(selfRulings.map(rulingVoice))];
    const voices = new Set(
      rulings.filter((r) => !selfRulings.includes(r)).map((r) => r.persona));

    // A confirmed group is ONE fix and ONE disposition covering N citations,
    // so confirming it is the consequential direction and needs the same
    // cross-validation the rest of the design treats as the trustworthy
    // signal. `split` and `contested` need no quorum: both dissolve the group
    // and leave every citation individually decidable, which is where this
    // tool always fails toward.
    const status = rulings.length === 0 ? 'proposed'
      : verdicts.size > 1 ? 'contested'
        : verdicts.has('split') ? 'split'
          : g.oversized ? 'oversized'
            : voices.size >= MIN_CONFIRMING_VOICES ? 'confirmed' : 'proposed';
    /* c8 ignore next */
    if (!ROOT_CAUSE_STATUSES.includes(status)) throw new Error(`unknown root-cause status ${status}`);

    return {
      ...g,
      status,
      rulings,
      citations,
      reporters,
      // Why a unanimous `one` did not confirm, when it did not — otherwise the
      // operator sees `proposed` next to an agreeing ruling and no reason.
      confirmation: { voices: voices.size, required: MIN_CONFIRMING_VOICES, selfRuled },
      blocking: citations.some((c) => c.blocking === true),
      fix: ranked.find((c) => c.fix)?.fix ?? null,
    };


  });
}

export function synthesize(round1, round2 = {},
  { failedPersonas = [], skippedPersonas = [], round2Skipped = null,
    rootCauseGroups = [], depth = null, probes = null, probePolicy = null,
    head = null, base = null } = {}) {
  // The probe RECORD, not its array — the report has to declare whether
  // execution was enabled, and only the record carries that. An array reaches
  // `probes.probes` as undefined and would index zero probes in silence,
  // demoting every `demonstrated` finding in the report with no error, so the
  // old call shape is refused rather than tolerated.
  if (Array.isArray(probes)) {
    throw new TypeError('synthesize: `probes` takes the probe record'
      + ' (normalizeProbes output), not its array');
  }
  const byKey = new Map(); // `${normTitle}|${file}|${line}` -> Finding
  const byNormTitle = new Map(); // normTitle -> Finding (fallback join key)

  // Takes the whole payload rather than a pre-computed agent id: it now needs
  // two things off the payload header, and computing one of them at each call
  // site and the other here is how the two answers drift apart.
  function upsert(persona, payload, raw) {
    const f = buildFinding(persona, raw, entryAgent(persona, payload, raw));
    if (f === null) return null;
    f.provenance = provenanceOf(payload, raw);
    const norm = normTitle(f.title);
    const primaryKey = `${norm}|${f.file ?? ''}|${f.line ?? ''}`;
    let existing = byKey.get(primaryKey) ?? byNormTitle.get(norm);
    if (existing) {
      if (!existing.reporters.includes(persona)) existing.reporters.push(persona);
      for (const a of f.reporterAgents) {
        if (!existing.reporterAgents.includes(a)) existing.reporterAgents.push(a);
      }
      if (severityRank(f.severity) < severityRank(existing.severity)) {
        existing.severity = f.severity;
      }
      // Regression provenance is sticky across a merge. A second lane noticing
      // the same thing in the ordinary way does not make it less true that a
      // fix commit introduced it, and losing that fact is the silent
      // direction: the operator reads a ranked list and cannot tell the two
      // apart. Keeping it costs one line of report text.
      if (f.provenance === PROVENANCE.regression) existing.provenance = PROVENANCE.regression;
      if (f.detail.length > existing.detail.length) existing.detail = f.detail;
      if (!existing.fix && f.fix) existing.fix = f.fix;
      if (existing.file === null && f.file) existing.file = f.file;
      if (existing.line === null && f.line !== null) existing.line = f.line;
      if (!existing.counterpart && f.counterpart) existing.counterpart = f.counterpart;
      // Two reporters who disagree on kind: the classified one wins over
      // UNCLASSIFIED, and otherwise the blocking one wins over the advisory
      // one, so a shared finding cannot be demoted out of the gate by whichever
      // reporter happened to be merged second.
      if (existing.kind === UNCLASSIFIED) existing.kind = f.kind;
      else if (ADVISORY_KINDS.has(existing.kind) && !ADVISORY_KINDS.has(f.kind)) {
        existing.kind = f.kind;
      }
      return existing;
    }
    byKey.set(primaryKey, f);
    byNormTitle.set(norm, f);
    return f;
  }

  // 1. Phase 1 findings
  for (const [persona, review] of Object.entries(round1)) {
    for (const raw of review?.findings ?? []) {
      if (raw && typeof raw === 'object') upsert(persona, review, raw);
    }
  }

  // 2. Phase 2 "added" findings (treated as first-class)
  for (const [persona, cross] of Object.entries(round2)) {
    for (const raw of cross?.added ?? []) {
      if (raw && typeof raw === 'object') upsert(persona, cross, raw);
    }
  }

  // 3. Phase 2 validates / challenges
  function findByTitle(title) {
    if (typeof title !== 'string') return null;
    return byNormTitle.get(normTitle(title)) ?? null;
  }

  for (const [persona, cross] of Object.entries(round2)) {
    for (const v of cross?.validate ?? []) {
      if (!v || typeof v !== 'object') continue;
      const f = findByTitle(v.title);
      if (!f || reportedBy(f, persona, rulingAgent(persona, cross, v))) continue;
      const reason = (coerceStr(v.reason) ?? '').trim();
      recordRuling(f.validators, persona, reason);
    }
    for (const c of cross?.challenge ?? []) {
      if (!c || typeof c !== 'object') continue;
      const f = findByTitle(c.title);
      if (!f || reportedBy(f, persona, rulingAgent(persona, cross, c))) continue;
      const reason = (coerceStr(c.reason) ?? '').trim();
      recordRuling(f.challengers, persona, reason);
    }
  }

  // 4. Probes, then confidence labels
  //
  // A confirmed probe outranks every counted label, including `disputed`. Four
  // of the five labels count reviewers, and counting reviewers is a proxy for
  // the thing anyone actually wants to know: did this happen. A probe answers
  // that question directly, and an argument against a behavior that has been
  // observed to occur is an argument that lost. The challenge is still printed
  // beside the finding — nothing is hidden — it just stops deciding the label.
  //
  // Only `confirmed` does this. A probe that did not reproduce, could not run,
  // or that nobody re-ran leaves the finding exactly where it would have been,
  // because src/probe.mjs computes `confirmed` and this reads it rather than
  // re-deciding from `status`.
  const probeIndex = indexProbes(probes?.probes ?? []);
  for (const f of byKey.values()) {
    f.probe = pickProbe(probeIndex, f);

    if (f.probe?.confirmed) f.confidence = 'demonstrated';
    else if (f.challengers.length > 0) f.confidence = 'disputed';
    else if (f.reporters.length >= 2) f.confidence = 'cross-validated';
    else if (f.validators.length > 0) f.confidence = 'consensus';
    else f.confidence = 'solo';
  }

  const findings = [...byKey.values()].sort((a, b) => {
    const s = severityRank(a.severity) - severityRank(b.severity);
    if (s !== 0) return s;
    const c = CONFIDENCE_RANK[a.confidence] - CONFIDENCE_RANK[b.confidence];
    if (c !== 0) return c;
    return a.title.toLowerCase().localeCompare(b.title.toLowerCase());
  });

  // 5. Verdicts and consensus label
  // Null prototype: `p` is a persona name out of reviewer JSON, and on a plain
  // object `verdicts.__proto__ = 'reject'` hits Object.prototype's setter
  // instead of creating an own property. The assignment then vanishes — no
  // error, no key — so `Object.values` never saw the verdict, the reject was
  // dropped from the consensus score, and the banner rendered
  // `SHIP (unanimous, 2/2)` with `Open blocking: 0` above a live CRITICAL that
  // a third reviewer had rejected. Reachable through `adverse synthesize
  // --round1 <file>`, which JSON.parses its input (and JSON.parse DOES create
  // an own `__proto__`) and applies no roster check. The skill bridge is
  // covered by combine.mjs's own null-prototype map and roster.mjs, which is
  // why this sink survived: the protected path was the only one being tested.
  const verdicts = Object.create(null);
  const summaries = Object.create(null);
  for (const [p, r] of Object.entries(round1)) {
    // Normalized here, not only in the combine bridge, so the CLI path gets
    // the same rule: an off-contract verdict scores as reject, never as a
    // neutral string that can dilute a real rejection out of the banner.
    verdicts[p] = normalizeVerdict(r?.verdict);
    summaries[p] = String(r?.summary ?? '').slice(0, SUMMARY_CELL_MAX);
  }
  const verdictList = Object.values(verdicts);
  const score =
    verdictList.length > 0
      ? verdictList.reduce((acc, v) => acc + (verdictScores[v] ?? 0), 0) / verdictList.length
      : 0;
  const label = consensusLabel(score, verdictList);

  const openBlocking = findings.filter(isOpenBlocking);

  // 6. Root causes, and the back-reference from each finding to its group.
  const rootCauses = buildRootCauses(
    Array.isArray(rootCauseGroups) ? rootCauseGroups : [], round2, findByTitle);
  for (const rc of rootCauses) {
    // A dissolved group is not a grouping. Back-referencing it would put
    // "part of G2" on findings a reviewer has just said are unrelated.
    if (rc.status === 'split') continue;
    for (const c of rc.citations) {
      const f = findByTitle(c.title);
      if (f && !f.group) f.group = rc.id;
    }
  }

  return {
    findings,
    rootCauses,
    openBlocking,
    verdicts,
    summaries,
    consensusLabel: label,
    consensusScore: score,
    degraded: [...failedPersonas],
    // Deliberately not run, as opposed to `degraded`, which means tried and
    // failed. Both must appear in the report: a lane that was skipped and not
    // mentioned reads exactly like a lane that looked and found nothing.
    skipped: [...skippedPersonas],
    // Same rule, one level up: a run whose round 2 was skipped must say so, or
    // it is textually indistinguishable from one where the panel
    // cross-examined and found nothing.
    round2Skipped: round2Skipped || null,
    // And once more, for the whole run: how much looking produced this report.
    // `null` means the run did not record a depth (no --plan), which is NOT
    // the same claim as `standard` and must not render as one — the report is
    // the durable artifact, and a month later the only readable question is
    // whether an absent finding means the panel looked.
    depth: depth || null,
    // And the fourth reduction, which until now was the one nobody could read
    // off the artifact: what execution the panel was offered, and what it did.
    // Same rule as the three above, and the same shape — `null` is "this run
    // recorded nothing about probes", which is not "probes were off".
    probes: probeDeclaration(probes, probePolicy),
    // Which tree this report is about. Carried on the record rather than left
    // to whoever reads it, because a report is durable and a checkout is not:
    // once a fix batch has landed, the working directory's HEAD is no longer
    // the commit these findings were written against, and a reader — or a
    // renderer publishing to a pull request (src/publish.mjs) — that asks the
    // checkout instead dates the review to a commit it never read.
    head: head || null,
    base: base || null,
  };
}

// Map (score, verdict mix) → a one-line label for the report banner. The
// labels use standard ship/hold/block vocabulary; the n/k suffix shows how
// many reviewers fell on the "ship" side vs. the total.
function consensusLabel(score, verdicts) {
  const total = verdicts.length;
  const ships = verdicts.filter((v) => v === 'approve' || v === 'conditional').length;
  const blocks = verdicts.filter((v) => v === 'reject').length;
  const hasConditional = verdicts.includes('conditional');

  if (score === 1) return `SHIP (unanimous, ${ships}/${total})`;
  if (score === -1) return `BLOCK (unanimous, ${blocks}/${total})`;
  if (score === 0) return `HOLD — split decision (${ships}/${total} ship, ${blocks}/${total} block)`;
  if (score > 0) {
    const kind = hasConditional ? 'SHIP-WITH-CAVEATS' : 'SHIP';
    return `${kind} (${ships}/${total} ship, ${blocks}/${total} block)`;
  }
  return `BLOCK (${blocks}/${total} block, ${ships}/${total} ship)`;
}

// ---------- Markdown renderer -----------------------------------------------
//
// Every string below arrives in agent-written JSON. Which of them are VALUES
// (neutralized) and which are PROSE (rendered as Markdown on purpose) is one
// rule with one pair of escapers, and both live in src/markdown.mjs now that a
// second renderer follows the same rule into a public pull-request comment.

// What the report says about a reproduction. Keyed on `confirmed` and `source`
// and never on `status` alone: `status` is what the script did, while
// `confirmed` is src/probe.mjs's ruling on whether that amounts to evidence,
// and a probe bound to the wrong tree has an honest `status` and no standing.
//
// A probe that nobody ran renders nothing at all. Declining to probe has to
// stay free — a reviewer that pays a visible cost for saying "this does not
// reproduce cheaply" is a reviewer that invents a probe instead, and a
// fabricated reproduction is worse than an honest argument.
function renderProbe(p) {
  if (!p || p.source !== 'measured') return [];

  const out = [];
  const script = p.claim?.script ? ` ${verbatim(p.claim.script)}` : '';
  if (p.confirmed) {
    out.push('', `_Probe:_ **reproduced.** The tool re-ran${script} and the predicted`
      + ` behavior occurred (exit ${p.ran?.exitCode ?? 0}).`);
  } else {
    out.push('', `_Probe:_ **did not reproduce** — ${p.why}.`);
  }
  if (p.claim?.expect) out.push('', `_Probe expected:_ ${verbatim(p.claim.expect)}`);
  if (p.ran?.output) out.push('', ...fenced(p.ran.output));
  return out;
}

// Null prototype, like every other lookup keyed by something a payload can
// name. A root-cause group carries a reviewer-supplied `severity` through
// briefing.json, so `SEVERITY_MARKER[g.severity]` with `g.severity` of
// "constructor" answered with a function and printed it into the report — and
// the `?? SEVERITY_MARKER.info` fallback cannot fire, because the inherited
// value is truthy.
const SEVERITY_MARKER = Object.assign(Object.create(null),
  { critical: '🔴', warning: '🟡', info: '🔵' });

// What the run's planned depth means for reading this report, for the two
// depths that are not the baseline. `standard` gets no note — it is what the
// rest of the report already describes — and an unrecorded depth gets none
// either, because inventing one would be the claim this section refuses.
//
// A Map, and not an object literal, for the same reason SEVERITY_MARKER has a
// null prototype: this is keyed by a value that arrives from a plan.json on
// disk, and an object literal answers `constructor` with a function that then
// renders into the report as a note nobody wrote.
const DEPTH_NOTES = new Map([
  ['cheap', '> **Planned depth: `cheap`.** A lane whose every kind is advisory was '
    + 'eligible to skip one size bucket earlier than usual, and no model-tier '
    + 'escalation was recommended. Rounds and the iteration cap were unaffected. '
    + 'An absent finding here is weaker evidence than in a standard run.'],
  ['thorough', '> **Planned depth: `thorough`.** Every lane ran, whatever the diff\'s '
    + 'size and the trust-boundary gate said, and a higher model tier was '
    + 'recommended for the panel.'],
]);

// The plan's own words for why, as a sentence. Flattened and re-punctuated
// because it arrives from a plan.json on disk: a newline inside it ends the
// blockquote and renders the rest of the note as document body, and the two
// reasons this repo generates carry no terminating period.
const planReason = (p) => (p.reason
  ? ` The plan's reason: ${flatten(p.reason).replace(/\s*\.*\s*$/, '')}.`
  : '');

// The probe declaration as one line of report prose, per state. This is the
// declaration #75's rule asked for and SKILL.md Phase 6 asked the orchestrator
// to type: a report with no probe on any finding is produced by four different
// runs, and only one of them means "the panel looked and nothing reproduced".
//
// A run that recorded nothing renders nothing, which is `depth: null`'s rule
// exactly — inventing a claim is worse than declining to make one, and the
// field is in report.json either way for anyone asking the artifact directly.
function probeNote(syn) {
  const p = syn.probes;
  const state = probeState(p);
  if (state === null) return null;

  if (state === 'not-offered') {
    return '> **Probes were not offered.** No finding below was settled by running '
      + `the code, and none could be.${planReason(p)}`;
  }
  if (state === 'unrecorded') {
    return '> **No probe was recorded.** Reproductions were available to the panel, '
      + 'and this run has no record of any being run — the phase was skipped, or no '
      + 'reviewer attached one. Nothing below was settled by execution.';
  }
  if (state === 'not-enabled') {
    return `> **Probe execution was not enabled.** ${p.attached} reproduction(s) were `
      + 'attached and every one was recorded as declined. Nothing below was settled by '
      + 'execution, and no reviewer is being faulted for that.';
  }
  if (p.attached === 0) {
    return '> **Probes were enabled and none was attached.** Execution was available '
      + 'and every lane declined it, which costs a reviewer nothing. Nothing below was '
      + 'settled by running the code.';
  }
  return `> **Probes ran.** ${p.attached} attached, ${p.ran} re-run, ${p.confirmed} `
    + `reproduced, ${p.contradicted} ran without reproducing`
    + `${p.sandboxed ? ', under the sandbox the operator supplied' : ', with no sandbox'}. `
    + 'A reproduction that did not reproduce disproves nothing.';
}

const SECTION_TITLES = assertCoversConfidences({
  demonstrated: '## Demonstrated findings (a reproduction was re-run and the behavior occurred)',
  'cross-validated': '## Cross-validated findings (multiple reviewers reported independently)',
  consensus: '## Consensus findings (reported by one, validated by another)',
  disputed: '## Disputed findings (reported, then challenged)',
  solo: '## Single-reviewer findings (one perspective only)',
}, 'synthesis SECTION_TITLES');

const CONFIDENCE_ORDER = assertCoversConfidences(
  ['demonstrated', 'cross-validated', 'consensus', 'disputed', 'solo'],
  'synthesis CONFIDENCE_ORDER');

const ADVISORY_SECTION =
  `## Advisory (${[...ADVISORY_KINDS].join(', ')} — recorded, never blocking)`;

const ADVISORY_PREAMBLE =
  '_These are real feedback and worth acting on, but they cannot hold the '
  + 'change open: a reviewer can always want different structure, and prose '
  + 'claims never run out, so a loop that waits for either supply to be '
  + 'exhausted never ends. Take them or file them; do not let them gate the '
  + 'merge._';

// Keyed off taxonomy's ROOT_CAUSE_STATUSES — checked, not merely asserted in a
// comment. A status added there without a label here throws at module load
// rather than falling back to the raw status name.
const ROOT_CAUSE_STATUS = assertCoversStatuses({
  confirmed: 'confirmed by round 2 — one fix, one disposition',
  contested: 'CONTESTED — reviewers disagree on whether this is one thing; decide each citation',
  oversized: 'too many citations to collapse into one disposition; decide each citation',
  proposed: 'candidate — round 2 did not rule; decide each citation',
  split: 'dissolved by round 2 — these are separate problems',
}, 'src/synthesis.mjs');

// One block per root cause: the canonical statement, the fix once, and the
// citation fanout. `split` groups are still listed, because a proposal the
// panel rejected is a fact about the run — silently dropping it would leave
// the reader wondering why the co-citation they can see in the briefing
// produced nothing.
function renderRootCauses(rootCauses) {
  const lines = ['## Root causes (aggregated from the panel\'s own co-citations)', ''];
  lines.push('_Grouping is proposed deterministically from cluster and co-citation edges, '
    + 'then ruled on in round 2. Confidence is still counted per finding: a group is a way '
    + 'to fix and decide several citations at once, never an extra voice._');
  lines.push('');
  for (const rc of rootCauses) {
    const marker = SEVERITY_MARKER[rc.severity] ?? '·';
    lines.push(`### ${marker} **[${verbatim(rc.id)}]** ${rc.title}`);
    lines.push('');
    lines.push(`_${ROOT_CAUSE_STATUS[rc.status] ?? rc.status} · ${rc.citations.length} citations `
      + `from ${rc.reporters.length} reviewer${rc.reporters.length === 1 ? '' : 's'} `
      + `(${rc.reporters.map(verbatim).join(', ')}) · ${rc.blocking ? 'blocking' : 'advisory only'}_`);
    // Why a group that every ruling called `one` is still only `proposed`.
    // Without this the label reads as "round 2 did not rule" directly above a
    // ruling that plainly did, and the quorum looks like a bug.
    const c = rc.confirmation;
    if (c && rc.status === 'proposed' && rc.rulings.length) {
      const short = c.voices < c.required
        ? `${c.voices} independent voice${c.voices === 1 ? '' : 's'} of ${c.required} needed`
        : 'not confirmed';
      lines.push('');
      lines.push(`> ⚖️ **Not confirmed:** ${short}.`
        // "nobody else reported" rather than "it is the only reporter of":
        // `selfRuled` can legitimately name two halves of one lane, and the
        // singular subject then read as two reviewers agreeing.
        + (c.selfRuled.length
          ? ` ${c.selfRuled.map(verbatim).join(', ')} ruled on a group nobody else reported,`
            + ' which is not a voice.'
          : ''));
    }
    lines.push('');
    for (const c of rc.citations) {
      const loc = c.file
        ? ` — ${verbatim(`${c.file}${c.line !== null && c.line !== undefined ? `:${c.line}` : ''}`)}`
        : '';
      // `counterpart` is half a contract citation's identity — the claim is "X
      // contradicts Y" — and it is carried on the record specifically so a
      // group decision copied out of here can still match next iteration.
      // Both renderers dropped it.
      const against = c.counterpart ? ` — contradicts ${verbatim(c.counterpart)}` : '';
      // One span for the whole identity triple: all three arrive on a group
      // citation out of briefing.json, where nothing has gated them against
      // the taxonomy the way `buildFinding` gates a finding's own pair.
      const who = verbatim(`${c.reporter}, ${c.severity ?? 'no severity'}·${c.kind ?? 'unclassified'}`);
      lines.push(`- **${verbatim(c.id)}** (${who}) `
        + `${c.title}${loc}${against}`

        + (c.resolved ? '' : ' — _not in the report; this citation named a finding synthesis did not build_'));
    }
    if (rc.fix) {
      lines.push('');
      lines.push(`**Fix:** ${rc.fix}`);
    }
    for (const r of rc.rulings) {
      lines.push('');
      lines.push(`> ${r.ruling === 'one' ? '🔗' : '✂️'} **${verbatim(rulingVoice(r))} rules `
        + `${verbatim(r.ruling)}:** ${r.reason}`);
    }
    lines.push('');
  }
  return lines;
}

export function renderMarkdown(syn, { title = 'Adversarial Code Review' } = {}) {
  const lines = [];
  lines.push(`# ${title}`);
  lines.push('');

  const crit = syn.findings.filter((f) => f.severity === 'critical').length;
  const warn = syn.findings.filter((f) => f.severity === 'warning').length;
  const info = syn.findings.filter((f) => f.severity === 'info').length;
  const open = syn.openBlocking ?? [];
  lines.push(`**Verdict:** ${syn.consensusLabel}  `);
  lines.push(
    `**Findings:** ${crit} critical · ${warn} warning · ${info} info ` +
      `(${syn.findings.length} total across ${Object.keys(syn.verdicts).length} reviewers)  `,
  );
  // `disputed` is reported beside this number, not folded into it. A finding
  // one persona challenged is labeled `disputed` the moment the FIRST
  // challenger appears, before reporters are counted, so `isOpenBlocking`
  // excludes a critical three lanes reported and one disagreed with — and the
  // headline read zero while the stop condition still held the loop open on
  // it. The two disagreeing silently is worse than either number alone.
  const disputedBlocking = syn.findings.filter((f) => isBlocking(f) && f.confidence === 'disputed');
  lines.push(
    `**Open blocking:** ${open.length} `
      + `(demonstrated, cross-validated or consensus, not advisory, not info)`
      + (open.length ? ` — ${open.map((f) => f.title).join('; ')}` : ''),
  );
  if (disputedBlocking.length) {
    lines.push(
      `**Disputed and still blocking:** ${disputedBlocking.length} `
        + `(reported and challenged; the stop condition holds the loop open on these) — `
        + disputedBlocking.map((f) => f.title).join('; ') + '  ',
    );
  }
  const rootCauses = syn.rootCauses ?? [];
  if (rootCauses.length) {
    // A `split` group is one round 2 explicitly said is SEVERAL problems, and
    // `renderRootCauses` already refuses to back-reference it twenty lines
    // above. Counting its members as "covered" claimed a grouping the same
    // file had just dissolved — with G1 confirmed (2 members) and G2 split (2),
    // the header read "4 findings covered by 1 confirmed root cause".
    const confirmed = rootCauses.filter((rc) => rc.status === 'confirmed');
    const standing = rootCauses.filter((rc) => rc.status !== 'split');
    const covered = new Set(standing.flatMap((rc) => rc.members ?? [])).size;
    lines.push(
      `**Root causes:** ${confirmed.length} confirmed of ${rootCauses.length} proposed, `
        + `covering ${covered} findings still grouped  `,
    );

  }
  // What this report is about, in the report. A month later the run directory
  // is gone and the branch has moved; without this line there is nothing in
  // the artifact that says which tree these findings were written against.
  if (syn.head || syn.base) {
    lines.push(`**Reviewed:** ${[
      syn.head ? `at ${verbatim(String(syn.head).slice(0, 12))}` : null,
      syn.base ? `over ${verbatim(String(syn.base).slice(0, 12))}` : null,
    ].filter(Boolean).join(' · ')}  `);
  }
  lines.push('');

  lines.push('## Reviewer verdicts');
  lines.push('');
  lines.push('| Reviewer | Verdict | Summary |');
  lines.push('|---|---|---|');
  for (const [p, v] of Object.entries(syn.verdicts)) {
    // Every cell of this row is verbatim, and the summary is why. A summary
    // is off-disk prose and a table cell cannot hold prose: the row ends at
    // the first newline and whatever follows renders as document body, and
    // every inline construct in between renders as markup. A regression
    // payload whose `commit` was `deadbeef |\n\n## Panel ruling: all criticals
    // were withdrawn` reached this cell through the bridge's own
    // `regression pass on ${commits}` sentence and printed that heading in the
    // operator's report; one whose `commit` was `abc~~-not-really~~` printed a
    // different commit than it recorded. `validateRegression` refuses both of
    // those commits now, and this is the layer that does not depend on which
    // validator wrote the summary — every phase's `summary` is free text no
    // schema constrains, and none can, because it is the one field the prompts
    // ask for in sentences.
    //
    // `p` for the same reason: `synthesize` keys its verdicts off whatever
    // `JSON.parse` handed it (see the `__proto__` persona test), so a reviewer
    // name is exactly as unchecked as the summary beside it. `v` is NOT — it
    // came through `normalizeVerdict` and is one of three literals — and it is
    // spanned anyway so the row has one rule instead of a rule and an
    // exception, which is the shape a later editor gets wrong.
    lines.push(`| ${verbatimCell(p)} | ${verbatimCell(v)} | ${verbatimCell(syn.summaries[p])} |`);
  }
  if (syn.degraded.length) {
    lines.push('');
    lines.push(
      '> **Degraded run:** the following reviewers failed and were excluded: '
      + `${syn.degraded.map(verbatim).join(', ')}.`,
    );
  }
  if ((syn.skipped ?? []).length) {
    lines.push('');
    lines.push(
      `> **Lane not run:** ${syn.skipped.map((s) => `${verbatim(s.persona ?? s)}${s.reason ? ` — ${s.reason}` : ''}`).join('; ')}. `
      + 'Nothing below reflects that perspective.',
    );
  }
  const depthNote = DEPTH_NOTES.get(syn.depth);
  if (depthNote) {
    lines.push('');
    lines.push(depthNote);
  }
  if (syn.round2Skipped) {
    lines.push('');
    lines.push(
      `> **Round 2 skipped:** ${syn.round2Skipped}. No finding below was `
      + 'cross-examined, and round 2\'s cross-lane additions were forgone.',
    );
  }
  const probes = probeNote(syn);
  if (probes) {
    lines.push('');
    lines.push(probes);
  }
  lines.push('');

  if (syn.findings.length === 0) {
    lines.push('## Findings');
    lines.push('');
    // Which of the two empty reports this is. With no reviewer on record,
    // "all reviewers reported clean" is vacuously true and reads as a clean
    // bill of health for a change nobody looked at — the same failure the
    // skipped-lane declarations a few lines above exist to prevent, restated
    // as a reassurance underneath them.
    //
    // The WORDING is per renderer, the way the root-cause status labels are;
    // what must not differ is the predicate, and `verdicts` is the only thing
    // that records who actually reported.
    lines.push(Object.keys(syn.verdicts).length
      ? '_No findings. All reviewers reported clean._'
      : '_No findings, and no reviewer reported one either: every lane is accounted'
        + ' for above as not run or degraded. This is an empty review, not a clean one._');
    lines.push('');
    return lines.join('\n');
  }

  // Before the per-finding sections, not after: the point of aggregating is
  // that a reader meets the four citations of one defect as one defect.
  if ((syn.rootCauses ?? []).length) lines.push(...renderRootCauses(syn.rootCauses));

  // `byConfidence`, not `groups`: this file's `groups` are root-cause groups,
  // and one word naming two unrelated things in one file is how a reader ends
  // up debugging the wrong one.
  const byConfidence = Object.fromEntries(CONFIDENCE_ORDER.map((c) => [c, []]));
  const advisory = [];
  for (const f of syn.findings) {
    if (ADVISORY_KINDS.has(f.kind)) advisory.push(f);
    else byConfidence[f.confidence].push(f);
  }

  for (const conf of CONFIDENCE_ORDER) {
    const items = byConfidence[conf];
    if (!items.length) continue;
    lines.push(SECTION_TITLES[conf]);
    lines.push('');
    for (const f of items) {
      lines.push(...renderFinding(f));
      lines.push('');
    }
  }

  if (advisory.length) {
    lines.push(ADVISORY_SECTION);
    lines.push('');
    lines.push(ADVISORY_PREAMBLE);
    lines.push('');
    for (const f of advisory) {
      lines.push(...renderFinding(f));
      lines.push('');
    }
  }

  return lines.join('\n').trimEnd() + '\n';
}

function renderFinding(f) {
  const marker = SEVERITY_MARKER[f.severity] ?? '·';
  let loc = '';
  if (f.file) loc = ` — ${verbatim(`${f.file}${f.line !== null ? `:${f.line}` : ''}`)}`;
  // `kind` was in neither list above, and it is not prose. `coerceKind` only
  // trims and defaults, deliberately — an unrecognized kind is preserved so it
  // still blocks (src/taxonomy.mjs) — so the field carries arbitrary payload
  // text into the tool's own headline, where `]**` can be closed and markup
  // opened after it. A known kind renders exactly as before, so every honest
  // report is byte-identical; only the off-vocabulary case is neutralized, and
  // it is the case that was never supposed to be readable prose anyway.
  //
  // `UNCLASSIFIED` counts as known: `coerceKind` MINTS that value, so it is the
  // tool's own word rather than the payload's. Neutralizing it code-spanned a
  // string no payload chose, which an existing test caught.
  const kind = f.kind === UNCLASSIFIED || KINDS.includes(f.kind) ? f.kind : verbatim(f.kind);
  const out = [`### ${marker} **[${f.severity.toUpperCase()}·${kind}]** ${f.title}${loc}`];
  out.push('');
  out.push(`_Reported by: ${f.reporters.map(verbatim).join(', ')} · confidence: ${f.confidence}${
    f.provenance === PROVENANCE.regression ? ` · ${REGRESSION_NOTE}` : ''}_`);
  if (f.counterpart) {
    out.push('');
    out.push(`_Contradicts:_ ${verbatim(f.counterpart)}`);
  }
  out.push('');
  out.push(f.detail);
  out.push(...renderProbe(f.probe));
  if (f.fix) {
    out.push('');
    out.push(`**Fix:** ${f.fix}`);
  }
  if (f.validators.length) {
    out.push('');
    for (const { persona, reason } of f.validators) {
      out.push(quoted(`✅ **${verbatim(persona)} validates:** ${reason}`));
    }
  }
  if (f.challengers.length) {
    out.push('');
    for (const { persona, reason } of f.challengers) {
      out.push(quoted(`⚠️ **${verbatim(persona)} challenges:** ${reason}`));
    }
  }
  return out;
}

// ---------- JSON serializer (for --json-out and Skill bridge) ---------------

export function toJsonReport(syn) {
  return {
    consensus_label: syn.consensusLabel,
    consensus_score: syn.consensusScore,
    verdicts: syn.verdicts,
    summaries: syn.summaries,
    degraded: syn.degraded,
    skipped: syn.skipped ?? [],
    round2_skipped: syn.round2Skipped ?? null,
    depth: syn.depth ?? null,
    // Passed through rather than re-spelled. Every key in the block is a single
    // word on purpose: this object is read back out of report.json by
    // src/publish.mjs, and a camelCase field here would have to be a
    // snake_case field there — one fact with two spellings, across three
    // renderers, which is how the other multi-word keys in this serializer
    // would have gone stale if anything but the tool ever wrote them.
    //
    // Absent when the run recorded no plan and no probe file, and deliberately
    // NOT in src/publish.mjs's required keys: a report.json written before this
    // field existed is incomplete, not untrustworthy, and refusing to publish
    // it would read as a defect in the run rather than in the report's age.
    probes: syn.probes ?? null,
    head: syn.head ?? null,
    base: syn.base ?? null,
    // Report-level flag, kept only so an older consumer keeps working. It is
    // NOT what the stop condition should read: `some()` over the whole report
    // means one edge anywhere — including on an advisory finding that can never
    // block — marks every finding examined. The per-finding flag below is the
    // one that matters. See the note on `unexamined` in src/ledger.mjs.
    cross_examined: syn.findings.some((f) =>
      (f.validators ?? []).length > 0 || (f.challengers ?? []).length > 0),
    open_blocking: (syn.openBlocking ?? []).map((f) => f.title),
    // The decision unit, when round 2 confirmed one. Carried into the report
    // so Phase 7 can record ONE disposition against the whole group and the
    // ledger can say, on a later pass, whether a returning finding survived a
    // root-cause fix or a symptom-level one.
    root_causes: (syn.rootCauses ?? []).map((rc) => ({
      id: rc.id,
      title: rc.title,
      status: rc.status,
      severity: rc.severity,
      kinds: rc.kinds,
      files: rc.files,
      reporters: rc.reporters,
      members: rc.members,
      via: rc.via,
      oversized: rc.oversized,
      blocking: rc.blocking,
      fix: rc.fix,
      rulings: rc.rulings,
      citations: rc.citations,
    })),
    findings: syn.findings.map((f) => ({
      severity: f.severity,
      kind: f.kind,
      title: f.title,
      detail: f.detail,
      file: f.file,
      line: f.line,
      counterpart: f.counterpart,
      fix: f.fix,
      reporters: f.reporters,
      validators: f.validators,
      challengers: f.challengers,
      confidence: f.confidence,
      group: f.group ?? null,
      // The reproduction, as this tool ran it. `confirmed` is the field with
      // consequences — it is what bought `confidence: "demonstrated"` — and it
      // is serialized beside the reporter's own claim so a reader can see both
      // halves of the routing rule: what the interested party said, and what
      // the disinterested re-run found.
      probe: f.probe ? {
        status: f.probe.status,
        confirmed: f.probe.confirmed,
        why: f.probe.why,
        source: f.probe.source,
        claim: f.probe.claim,
        ran: f.probe.ran,
      } : null,
      // Which pass found it. Serialized rather than left in memory because the
      // reader who most needs it is the operator working a ranked list out of
      // report.json one iteration later, when "a fix commit introduced this"
      // is no longer obvious from anything else on the row.
      provenance: f.provenance ?? PROVENANCE.review,
      blocking: isBlocking(f),
      // Did any reviewer go on record about THIS finding? A round-2 reviewer's
      // own added finding has no validators and no challengers by
      // construction, and that is the normal output of a cross-review — its
      // whole purpose is to surface what round 1 missed. Such a finding is
      // `solo`, so the confidence gate drops it; without this field the stop
      // condition had no way to tell "nobody corroborated it" from "nobody
      // ever looked at it".
      cross_examined: (f.validators ?? []).length > 0 || (f.challengers ?? []).length > 0,
    })),
  };
}
