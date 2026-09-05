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
// Orthogonal to both severity and confidence is `kind` (see src/prompts.mjs),
// which answers "what evidence would settle this". It is what makes an
// automated stop condition possible: `design` findings are advisory, because a
// reviewer can always want different structure and so a loop that counts them
// never terminates. `openBlocking` is the resulting signal — the findings that
// are both credible enough (cross-validated or consensus) and consequential
// enough (not advisory, not `info`) to hold a change open.

import { ADVISORY_KINDS } from './prompts.mjs';

const SEVERITY_ORDER = { critical: 0, warning: 1, info: 2 };
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
// Each half is bounded BEFORE the join: the renderer clips a summary cell at
// 300 characters, and a long first half would otherwise amputate the second
// half entirely, losing exactly the voice the merge exists to keep.
const MERGED_SUMMARY_PART_MAX = 148;
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
  return SEVERITY_ORDER[s] ?? 99;
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
  if (!title || !(severity in SEVERITY_ORDER)) return null;
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
  };
}

export function synthesize(round1, round2 = {},
  { failedPersonas = [], skippedPersonas = [], round2Skipped = null } = {}) {
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
  const verdicts = {};
  const summaries = {};
  for (const [p, r] of Object.entries(round1)) {
    // Normalized here, not only in the combine bridge, so the CLI path gets
    // the same rule: an off-contract verdict scores as reject, never as a
    // neutral string that can dilute a real rejection out of the banner.
    verdicts[p] = normalizeVerdict(r?.verdict);
    summaries[p] = String(r?.summary ?? '').slice(0, 300);
  }
  const verdictList = Object.values(verdicts);
  const score =
    verdictList.length > 0
      ? verdictList.reduce((acc, v) => acc + (verdictScores[v] ?? 0), 0) / verdictList.length
      : 0;
  const label = consensusLabel(score, verdictList);

  const openBlocking = findings.filter(isOpenBlocking);

  return {
    findings,
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
  lines.push(
    `**Open blocking:** ${open.length} `
      + `(cross-validated or consensus, not advisory, not info)`
      + (open.length ? ` — ${open.map((f) => f.title).join('; ')}` : ''),
  );
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

  const groups = { 'cross-validated': [], consensus: [], disputed: [], solo: [] };
  const advisory = [];
  for (const f of syn.findings) {
    if (ADVISORY_KINDS.has(f.kind)) advisory.push(f);
    else groups[f.confidence].push(f);
  }

  for (const conf of CONFIDENCE_ORDER) {
    const items = groups[conf];
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
