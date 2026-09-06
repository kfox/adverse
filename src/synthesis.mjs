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
// are both credible enough (cross-validated or consensus) and consequential
// enough (not advisory, not `info`) to hold a change open.

import { ADVISORY_KINDS, GROUP_RULINGS, ROOT_CAUSE_STATUSES, SEVERITY_RANK,
         assertCoversStatuses } from './taxonomy.mjs';

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
export function mergeSplitReviews(a, b) {
  const part = (s) => String(s ?? '').slice(0, MERGED_SUMMARY_PART_MAX);
  return {
    ...a,
    verdict: worseVerdict(a?.verdict, b?.verdict),
    summary: [a?.summary, b?.summary].filter(Boolean).map(part).join(' · '),
    findings: [
      ...(Array.isArray(a?.findings) ? a.findings : []),
      ...(Array.isArray(b?.findings) ? b.findings : []),
    ],
  };
}
const CONFIDENCE_RANK = { disputed: 0, 'cross-validated': 1, consensus: 2, solo: 3 };

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
const UNCLASSIFIED = 'unclassified';

function coerceKind(v) {
  return typeof v === 'string' && v.trim() ? v.trim() : UNCLASSIFIED;
}

export function isBlocking(finding) {
  return !ADVISORY_KINDS.has(finding.kind) && finding.severity !== 'info';
}

// The stop condition and the report's headline number are the same question —
// "is this both blocking and credible enough to hold the change open?" —
// asked on either side of the report.json serialization boundary. Defined
// over `{kind, severity, confidence}` alone (not `.blocking`, which only the
// serialized shape carries) so it works unchanged on an in-memory finding
// here and on one `convergenceStatus` reads back out of a report.
export function isOpenBlocking(finding) {
  return isBlocking(finding)
    && (finding.confidence === 'cross-validated' || finding.confidence === 'consensus');
}

function buildFinding(persona, raw) {
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
    validators: [], // Array<{persona, reason}>
    challengers: [],
    confidence: 'solo',
    // The root cause this finding is a citation of, once round 2 has been
    // read. Declared here so the field exists whether or not a run grouped
    // anything — a shape that appears only sometimes is one every consumer
    // has to guess about.
    group: null,
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
//   proposed   nobody ruled — the pre-grouping behaviour, kept as the default
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
      rulingsById.get(r.id).push({ persona, ruling: r.ruling, reason: (coerceStr(r.reason) ?? '').trim() });
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
    const reporters = [...new Set(citations.flatMap((c) => c.reporters ?? [c.reporter]))];

    // A ruling from a persona that is the only reporter of every citation is a
    // persona confirming that its own findings are one thing. `validate` and
    // `challenge` already skip a persona's edge on a finding it reported
    // itself; a group ruling had no such guard.
    const selfRuled = rulings
      .filter((r) => citations.every((c) => {
        const rs = c.reporters ?? [c.reporter];
        return rs.length === 1 && rs[0] === r.persona;
      }))
      .map((r) => r.persona);
    const voices = new Set(
      rulings.filter((r) => !selfRuled.includes(r.persona)).map((r) => r.persona));

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
    rootCauseGroups = [] } = {}) {
  const byKey = new Map(); // `${normTitle}|${file}|${line}` -> Finding
  const byNormTitle = new Map(); // normTitle -> Finding (fallback join key)

  function upsert(persona, raw) {
    const f = buildFinding(persona, raw);
    if (f === null) return null;
    const norm = normTitle(f.title);
    const primaryKey = `${norm}|${f.file ?? ''}|${f.line ?? ''}`;
    let existing = byKey.get(primaryKey) ?? byNormTitle.get(norm);
    if (existing) {
      if (!existing.reporters.includes(persona)) existing.reporters.push(persona);
      if (severityRank(f.severity) < severityRank(existing.severity)) {
        existing.severity = f.severity;
      }
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
      if (raw && typeof raw === 'object') upsert(persona, raw);
    }
  }

  // 2. Phase 2 "added" findings (treated as first-class)
  for (const [persona, cross] of Object.entries(round2)) {
    for (const raw of cross?.added ?? []) {
      if (raw && typeof raw === 'object') upsert(persona, raw);
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
      if (!f || f.reporters.includes(persona)) continue; // self-validation does not count
      const reason = (coerceStr(v.reason) ?? '').trim();
      f.validators.push({ persona, reason });
    }
    for (const c of cross?.challenge ?? []) {
      if (!c || typeof c !== 'object') continue;
      const f = findByTitle(c.title);
      if (!f || f.reporters.includes(persona)) continue;
      const reason = (coerceStr(c.reason) ?? '').trim();
      f.challengers.push({ persona, reason });
    }
  }

  // 4. Confidence labels
  for (const f of byKey.values()) {
    if (f.challengers.length > 0) f.confidence = 'disputed';
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

const SEVERITY_MARKER = { critical: '🔴', warning: '🟡', info: '🔵' };

const SECTION_TITLES = {
  'cross-validated': '## Cross-validated findings (multiple reviewers reported independently)',
  consensus: '## Consensus findings (reported by one, validated by another)',
  disputed: '## Disputed findings (reported, then challenged)',
  solo: '## Single-reviewer findings (one perspective only)',
};

const CONFIDENCE_ORDER = ['cross-validated', 'consensus', 'disputed', 'solo'];

const ADVISORY_SECTION =
  '## Advisory (design — recorded, never blocking)';

const ADVISORY_PREAMBLE =
  '_These are design opinions. They are real feedback and worth acting on, but '
  + 'they cannot hold the change open: a reviewer can always want different '
  + 'structure, so a loop that waits for them to run out never ends. Take them '
  + 'or file them; do not let them gate the merge._';

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
    lines.push(`### ${marker} **[${rc.id}]** ${rc.title}`);
    lines.push('');
    lines.push(`_${ROOT_CAUSE_STATUS[rc.status] ?? rc.status} · ${rc.citations.length} citations `
      + `from ${rc.reporters.length} reviewer${rc.reporters.length === 1 ? '' : 's'} `
      + `(${rc.reporters.join(', ')}) · ${rc.blocking ? 'blocking' : 'advisory only'}_`);
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
        + (c.selfRuled.length
          ? ` ${c.selfRuled.join(', ')} ruled on a group it is the only reporter of, which is not a voice.`
          : ''));
    }
    lines.push('');
    for (const c of rc.citations) {
      const loc = c.file ? ` — \`${c.file}${c.line !== null && c.line !== undefined ? `:${c.line}` : ''}\`` : '';
      // `counterpart` is half a contract citation's identity — the claim is "X
      // contradicts Y" — and it is carried on the record specifically so a
      // group decision copied out of here can still match next iteration.
      // Both renderers dropped it.
      const against = c.counterpart ? ` — contradicts \`${c.counterpart}\`` : '';
      lines.push(`- **${c.id}** (${c.reporter}, ${c.severity ?? 'no severity'}·${c.kind ?? 'unclassified'}) `
        + `${c.title}${loc}${against}`

        + (c.resolved ? '' : ' — _not in the report; this citation named a finding synthesis did not build_'));
    }
    if (rc.fix) {
      lines.push('');
      lines.push(`**Fix:** ${rc.fix}`);
    }
    for (const r of rc.rulings) {
      lines.push('');
      lines.push(`> ${r.ruling === 'one' ? '🔗' : '✂️'} **${r.persona} rules \`${r.ruling}\`:** ${r.reason}`);
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
  // one persona challenged is labelled `disputed` the moment the FIRST
  // challenger appears, before reporters are counted, so `isOpenBlocking`
  // excludes a critical three lanes reported and one disagreed with — and the
  // headline read zero while the stop condition still held the loop open on
  // it. The two disagreeing silently is worse than either number alone.
  const disputedBlocking = syn.findings.filter((f) => isBlocking(f) && f.confidence === 'disputed');
  lines.push(
    `**Open blocking:** ${open.length} `
      + `(cross-validated or consensus, not advisory, not info)`
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
  lines.push('');

  lines.push('## Reviewer verdicts');
  lines.push('');
  lines.push('| Reviewer | Verdict | Summary |');
  lines.push('|---|---|---|');
  for (const [p, v] of Object.entries(syn.verdicts)) {
    const summary = (syn.summaries[p] ?? '').replaceAll('|', '\\|');
    lines.push(`| ${p} | ${v} | ${summary} |`);
  }
  if (syn.degraded.length) {
    lines.push('');
    lines.push(
      `> **Degraded run:** the following reviewers failed and were excluded: ${syn.degraded.join(', ')}.`,
    );
  }
  if ((syn.skipped ?? []).length) {
    lines.push('');
    lines.push(
      `> **Lane not run:** ${syn.skipped.map((s) => `${s.persona ?? s}${s.reason ? ` — ${s.reason}` : ''}`).join('; ')}. `
      + 'Nothing below reflects that perspective.',
    );
  }
  if (syn.round2Skipped) {
    lines.push('');
    lines.push(
      `> **Round 2 skipped:** ${syn.round2Skipped}. No finding below was `
      + 'cross-examined, and round 2\'s cross-lane additions were forgone.',
    );
  }
  lines.push('');

  if (syn.findings.length === 0) {
    lines.push('## Findings');
    lines.push('');
    lines.push('_No findings. All reviewers reported clean._');
    lines.push('');
    return lines.join('\n');
  }

  // Before the per-finding sections, not after: the point of aggregating is
  // that a reader meets the four citations of one defect as one defect.
  if ((syn.rootCauses ?? []).length) lines.push(...renderRootCauses(syn.rootCauses));

  // `byConfidence`, not `groups`: this file's `groups` are root-cause groups,
  // and one word naming two unrelated things in one file is how a reader ends
  // up debugging the wrong one.
  const byConfidence = { 'cross-validated': [], consensus: [], disputed: [], solo: [] };
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
  if (f.file) {
    loc = ` — \`${f.file}`;
    if (f.line !== null) loc += `:${f.line}`;
    loc += '`';
  }
  const out = [`### ${marker} **[${f.severity.toUpperCase()}·${f.kind}]** ${f.title}${loc}`];
  out.push('');
  out.push(`_Reported by: ${f.reporters.join(', ')} · confidence: ${f.confidence}_`);
  if (f.counterpart) {
    out.push('');
    out.push(`_Contradicts:_ \`${f.counterpart}\``);
  }
  out.push('');
  out.push(f.detail);
  if (f.fix) {
    out.push('');
    out.push(`**Fix:** ${f.fix}`);
  }
  if (f.validators.length) {
    out.push('');
    for (const { persona, reason } of f.validators) {
      out.push(`> ✅ **${persona} validates:** ${reason}`);
    }
  }
  if (f.challengers.length) {
    out.push('');
    for (const { persona, reason } of f.challengers) {
      out.push(`> ⚠️ **${persona} challenges:** ${reason}`);
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
