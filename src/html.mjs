// Self-contained HTML dashboard: a single file with no external assets so it
// works as an email/chat attachment, in CI artifacts, or pasted into a wiki.
// Vanilla HTML + scoped CSS + a few lines of JS — no framework, no build step.

import { refuseDirectRun } from './entryGuard.mjs';
import { ADVISORY_KINDS, PROVENANCE, assertCoversConfidences,
         assertCoversStatuses, citationReporter } from './taxonomy.mjs';
import { probeState } from './probe.mjs';
// Not wording — identity. Which half of a split lane made a ruling is a fact
// about the run, and this renderer printed the lane's persona for both halves.
import { rulingVoice } from './synthesis.mjs';

refuseDirectRun(import.meta.url);

// The dashboard's wording for a finding the regression pass found, kept here
// rather than shared with the Markdown renderer for the same reason each
// renderer keeps its own root-cause labels: the wording belongs to the medium.
// What must not differ is the CLAIM, and this one did. It read "introduced by a
// fix commit", which asserts causation the payload does not carry: a regression
// entry is classified `intended-inert`, `intended-undocumented` or `unintended`,
// and only the last of those was introduced in the sense a reader takes from
// that sentence. The Markdown renderer's copy said "found by the regression
// pass", which is what the provenance field actually means, so this one now
// says the same thing in fewer words.
// No `esc`: it is this file's own literal, not a reviewer's string.
const REGRESSION_NOTE = 'found by a fix commit\'s regression pass';

// Null prototype: same reasoning as SEVERITY_MARKER in src/synthesis.mjs. A
// group severity of "constructor" defeated the `?? SEVERITY_BADGE.info`
// fallback and rendered `style="color:undefined;background:undefined"`.
const SEVERITY_BADGE = Object.assign(Object.create(null), {
  critical: { label: 'CRITICAL', color: '#b91c1c', bg: '#fee2e2' },
  warning:  { label: 'WARNING',  color: '#92400e', bg: '#fef3c7' },
  info:     { label: 'INFO',     color: '#1e40af', bg: '#dbeafe' },
});

// Checked against the taxonomy at module load, like the root-cause labels
// below and for the same reason: this map is BOTH the section heading and the
// bucket list, so a label missing here is a section that never renders and a
// finding that quietly leaves the dashboard.
const CONFIDENCE_LABEL = assertCoversConfidences({
  demonstrated: 'Demonstrated · a reproduction was re-run and the behavior occurred',
  'cross-validated': 'Cross-validated · multiple reviewers, independently',
  consensus: 'Consensus · reported by one, validated by another',
  disputed: 'Disputed · reported, then challenged',
  solo: 'Solo · single perspective',
}, 'html CONFIDENCE_LABEL');

// One order, read off the map above rather than spelled a second time. The two
// lists had to agree and nothing made them: the buckets were built from one
// literal and iterated from another, twenty lines apart.
const CONFIDENCE_ORDER = Object.keys(CONFIDENCE_LABEL);

const VERDICT_BADGE = {
  approve:     { label: 'approve',     color: '#166534', bg: '#dcfce7' },
  conditional: { label: 'conditional', color: '#854d0e', bg: '#fef9c3' },
  reject:      { label: 'reject',      color: '#991b1b', bg: '#fee2e2' },
  unknown:     { label: '—',           color: '#374151', bg: '#f3f4f6' },
};

// Keyed off taxonomy's ROOT_CAUSE_STATUSES — checked at module load, not
// merely asserted in a comment.
const ROOT_CAUSE_STATUS = assertCoversStatuses({
  confirmed: 'Confirmed by round 2 — one fix, one disposition',
  contested: 'Contested — reviewers disagree; decide each citation',
  oversized: 'Too many citations to collapse; decide each citation',
  proposed: 'Candidate — round 2 did not rule; decide each citation',
  split: 'Dissolved by round 2 — separate problems',
}, 'src/html.mjs');

// The two note tables this page renders beside its banners. Maps rather than
// object literals for the reason SEVERITY_MARKER has a null prototype
// elsewhere: both are keyed by a value that arrives from a plan.json on disk,
// and an object literal answers `constructor` with a function.
//
// The WORDING is this renderer's own, the way the root-cause status labels are.
// What is shared is the PREDICATE — `probeState` in src/probe.mjs decides which
// of the four a run is in, once, for all three renderers.
const DEPTH_NOTES = new Map([
  ['cheap', 'Planned depth cheap: a lane whose every kind is advisory was eligible to'
    + ' skip one size bucket earlier than usual. An absent finding here is weaker'
    + ' evidence than in a standard run.'],
  ['thorough', 'Planned depth thorough: every lane ran whatever the diff\'s size and the'
    + ' trust-boundary gate said, at a higher model tier.'],
]);

const PROBE_NOTES = new Map([
  ['not-offered', (p) => 'Probes were not offered: nothing here was settled by running'
    + ` the code, and nothing could be.${p.reason ? ` Plan's reason: ${p.reason}` : ''}`],
  ['unrecorded', () => 'No probe was recorded: reproductions were available to the panel,'
    + ' and this run has no record of one being run. Nothing here was settled by execution.'],
  ['not-enabled', (p) => `Probe execution was not enabled: ${p.attached} reproduction(s)`
    + ' were attached and every one was recorded as declined. Nothing here was settled by'
    + ' execution.'],
  ['ran', (p) => (p.attached === 0
    ? 'Probes were enabled and none was attached: every lane declined, which costs a'
      + ' reviewer nothing. Nothing here was settled by running the code.'
    : `Probes ran: ${p.attached} attached, ${p.ran} re-run, ${p.confirmed} reproduced,`
      + ` ${p.contradicted} ran without reproducing`
      + `${p.sandboxed ? ', under the operator\'s sandbox' : ', with no sandbox'}.`)],
]);

function esc(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export function renderHtml(syn, { title = 'Adversarial Code Review' } = {}) {
  const crit = syn.findings.filter((f) => f.severity === 'critical').length;
  const warn = syn.findings.filter((f) => f.severity === 'warning').length;
  const info = syn.findings.filter((f) => f.severity === 'info').length;

  const verdictRows = Object.entries(syn.verdicts).map(([persona, verdict]) => {
    const b = VERDICT_BADGE[verdict] ?? VERDICT_BADGE.unknown;
    const summary = esc(syn.summaries[persona] ?? '');
    return `<tr>
      <td class="reviewer">${esc(persona)}</td>
      <td><span class="badge" style="color:${b.color};background:${b.bg}">${esc(b.label)}</span></td>
      <td>${summary}</td>
    </tr>`;
  }).join('\n');

  // `byConfidence`, not `groups`: `groups` in this codebase are root-cause
  // groups, and these are confidence buckets.
  const byConfidence = Object.fromEntries(CONFIDENCE_ORDER.map((c) => [c, []]));
  const advisory = [];
  for (const f of syn.findings) {
    if (ADVISORY_KINDS.has(f.kind)) advisory.push(f);
    else byConfidence[f.confidence].push(f);
  }

  const rootCauses = syn.rootCauses ?? [];
  const sections = [];
  if (rootCauses.length) {
    sections.push(`
      <section class="findings-group">
        <h2>Root causes — ${rootCauses.filter((rc) => rc.status === 'confirmed').length} confirmed of ${rootCauses.length} proposed</h2>
        <p class="empty">Proposed from the panel's own cluster and co-citation edges, then ruled on in round 2. Confidence is still counted per finding: a group fixes and decides several citations at once, it is not an extra voice.</p>
        ${rootCauses.map(renderRootCause).join('\n')}
      </section>`);
  }
  for (const conf of CONFIDENCE_ORDER) {
    const items = byConfidence[conf];
    if (!items.length) continue;
    sections.push(`
      <section class="findings-group">
        <h2>${esc(CONFIDENCE_LABEL[conf])}</h2>
        ${items.map(renderCard).join('\n')}
      </section>`);
  }
  if (advisory.length) {
    sections.push(`
      <section class="findings-group">
        <h2>Advisory (${[...ADVISORY_KINDS].join(', ')} — recorded, never blocking)</h2>
        ${advisory.map(renderCard).join('\n')}
      </section>`);
  }

  // Which tree. Same reason the Markdown report carries it: a dashboard saved
  // to disk outlives both the run directory and the branch position, and
  // without this the only thing naming the reviewed commit is the shell history
  // of the session that produced it.
  const reviewed = (syn.head || syn.base)
    ? `<p class="summary">Reviewed: ${[
      syn.head ? `at <code>${esc(String(syn.head).slice(0, 12))}</code>` : null,
      syn.base ? `over <code>${esc(String(syn.base).slice(0, 12))}</code>` : null,
    ].filter(Boolean).join(' · ')}</p>`
    : '';

  const round2Skipped = syn.round2Skipped
    ? `<div class="banner-warn">Round 2 skipped: ${esc(syn.round2Skipped)}. Nothing here was cross-examined.</div>`
    : '';
  const degraded = syn.degraded.length
    ? `<div class="banner-warn">Degraded run: <strong>${esc(syn.degraded.join(', '))}</strong> failed and were excluded.</div>`
    : '';

  // The other three reductions this dashboard did not render. It banners a
  // degraded lane and a skipped round 2 and stops, while the empty-findings
  // text below tells the reader that every lane is accounted for "above as not
  // run or degraded" — a sentence that was false in this renderer, because a
  // skipped lane appeared nowhere in the page. A dashboard is the artifact most
  // likely to be read by someone who was not in the session, which is the
  // reader the declaration exists for.
  const skipped = (syn.skipped ?? []).length
    ? `<div class="banner-warn">Lane not run: <strong>${esc((syn.skipped ?? [])
      .map((sk) => `${sk.persona ?? sk}${sk.reason ? ` — ${sk.reason}` : ''}`)
      .join('; '))}</strong>. Nothing here reflects that perspective.</div>`
    : '';
  const depthNote = DEPTH_NOTES.get(syn.depth);
  const depth = depthNote ? `<div class="banner-note">${esc(depthNote)}</div>` : '';
  const probeNote = PROBE_NOTES.get(probeState(syn.probes));
  const probes = probeNote
    ? `<div class="banner-note">${esc(probeNote(syn.probes))}</div>`
    : '';

  const noFindings = syn.findings.length === 0
    ? `<section><h2>Findings</h2><p class="empty">${Object.keys(syn.verdicts).length
      ? 'No findings. All reviewers reported clean.'
      : 'No findings, and no reviewer reported one either — every lane is accounted for'
        + ' above as not run or degraded. This is an empty review, not a clean one.'
    }</p></section>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${esc(title)}</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    :root {
      --fg: #111827; --fg-muted: #4b5563; --bg: #ffffff; --line: #e5e7eb;
      --bg-alt: #f9fafb; --accent: #1d4ed8;
    }
    @media (prefers-color-scheme: dark) {
      :root { --fg: #e5e7eb; --fg-muted: #9ca3af; --bg: #0f172a; --line: #1f2937; --bg-alt: #111827; --accent: #60a5fa; }
    }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 0; background: var(--bg); color: var(--fg);
           font: 14px/1.55 ui-sans-serif, system-ui, -apple-system, sans-serif; }
    .wrap { max-width: 980px; margin: 0 auto; padding: 32px 24px 64px; }
    h1 { font-size: 24px; margin: 0 0 8px; }
    h2 { font-size: 16px; font-weight: 600; margin: 32px 0 12px; color: var(--fg-muted); text-transform: uppercase; letter-spacing: 0.04em; }
    .verdict { font-size: 22px; font-weight: 600; margin: 12px 0; }
    .summary { color: var(--fg-muted); margin: 0 0 24px; }
    table.verdicts { width: 100%; border-collapse: collapse; margin: 0 0 16px; }
    table.verdicts th, table.verdicts td { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--line); vertical-align: top; }
    table.verdicts th { font-size: 12px; text-transform: uppercase; color: var(--fg-muted); letter-spacing: 0.04em; }
    .reviewer { font-weight: 600; }
    .badge { display: inline-block; font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 999px; text-transform: uppercase; letter-spacing: 0.04em; }
    .banner-warn { background: #fef3c7; color: #92400e; padding: 10px 14px; border-radius: 8px; margin: 16px 0; }
    .empty { color: var(--fg-muted); font-style: italic; }
    details.card { border: 1px solid var(--line); border-radius: 8px; margin: 8px 0; background: var(--bg-alt); }
    details.card[open] { background: var(--bg); }
    details.card summary { padding: 12px 16px; cursor: pointer; list-style: none; display: flex; gap: 12px; align-items: center; }
    details.card summary::-webkit-details-marker { display: none; }
    details.card summary::before { content: '▸'; color: var(--fg-muted); transition: transform .15s; }
    details.card[open] summary::before { transform: rotate(90deg); }
    .card .title { font-weight: 600; flex: 1; }
    .card .loc { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 12px; color: var(--fg-muted); }
    .card .body { padding: 0 16px 16px; }
    .card .reporters { font-size: 12px; color: var(--fg-muted); margin: 0 0 8px; }
    .card .kind { font-size: 11px; color: var(--fg-muted); border: 1px solid currentColor; border-radius: 999px; padding: 1px 7px; }
    .card .detail { margin: 8px 0; }
    .card .citations { margin: 8px 0; padding-left: 20px; }
    .card .citations li { margin: 4px 0; }
    .card .cite-meta { font-size: 12px; color: var(--fg-muted); }
    .card .fix { background: var(--bg-alt); padding: 8px 12px; border-radius: 6px; margin: 8px 0 0; }
    .card .fix strong { color: var(--accent); }
    .banner-note { margin: 12px 0; padding: 10px 14px; border-left: 3px solid var(--accent); background: var(--bg-alt); border-radius: 0 6px 6px 0; color: var(--fg-muted); font-size: 13px; }
    .card .probe { margin: 8px 0; padding: 8px 12px; border-left: 3px solid; border-radius: 0 6px 6px 0; font-size: 13px; }
    .card .probe p { margin: 0 0 6px; }
    .card .probe-ok { border-color: #16a34a; background: rgba(22,163,74,0.08); }
    .card .probe-no { border-color: #f59e0b; background: rgba(245,158,11,0.08); }
    .card .probe-output { margin: 6px 0 0; padding: 8px; background: var(--bg-alt); border-radius: 6px; overflow-x: auto; font-size: 12px; white-space: pre-wrap; word-break: break-word; }
    blockquote.validate, blockquote.challenge { margin: 6px 0; padding: 6px 12px; border-left: 3px solid; border-radius: 0 6px 6px 0; font-size: 13px; }
    blockquote.validate { border-color: #16a34a; background: rgba(22,163,74,0.08); }
    blockquote.challenge { border-color: #f59e0b; background: rgba(245,158,11,0.08); }
    footer { color: var(--fg-muted); font-size: 12px; margin-top: 48px; border-top: 1px solid var(--line); padding-top: 16px; }
    @media print {
      details.card { break-inside: avoid; }
      details.card summary::before { display: none; }
      details.card > .body { display: block !important; }
    }
  </style>
</head>
<body>
  <main class="wrap">
    <h1>${esc(title)}</h1>
    <div class="verdict">${esc(syn.consensusLabel)}</div>
    <p class="summary">${crit} critical · ${warn} warning · ${info} info — ${syn.findings.length} total across ${Object.keys(syn.verdicts).length} reviewers</p>
    <p class="summary">Open blocking: <strong>${(syn.openBlocking ?? []).length}</strong> (demonstrated, cross-validated or consensus, not advisory, not info)</p>
    ${reviewed}

    ${degraded}
    ${skipped}
    ${round2Skipped}
    ${depth}
    ${probes}

    <h2>Reviewer verdicts</h2>
    <table class="verdicts">
      <thead><tr><th>Reviewer</th><th>Verdict</th><th>Summary</th></tr></thead>
      <tbody>${verdictRows}</tbody>
    </table>

    ${noFindings}
    ${sections.join('\n')}

    <footer>Generated by adverse — multi-agent adversarial code review.</footer>
  </main>
  <script>
    // Open all expandable cards on '/' or 'e'; collapse all on Escape.
    document.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if (e.key === 'e' || e.key === '/') {
        document.querySelectorAll('details.card').forEach(d => d.open = true);
      } else if (e.key === 'Escape') {
        document.querySelectorAll('details.card').forEach(d => d.open = false);
      }
    });
  </script>
</body>
</html>
`;
}

// One card per root cause, opened by default: a reader who sees four
// citations of one defect as one defect is the entire point of aggregating,
// and that does not survive being folded away behind a disclosure triangle.
function renderRootCause(rc) {
  const sev = SEVERITY_BADGE[rc.severity] ?? SEVERITY_BADGE.info;
  const citations = rc.citations.map((c) => {
    const loc = c.file ? `${c.file}${c.line !== null && c.line !== undefined ? `:${c.line}` : ''}` : '';
    // A contract citation without its counterpart is half a claim: "X
    // contradicts Y" with Y missing. The field is on the record precisely so a
    // group decision copied from here can still match next iteration.
    const against = c.counterpart
      ? ` <span class="loc">contradicts ${esc(c.counterpart)}</span>` : '';
    return `<li><strong>${esc(c.id)}</strong> `
      + `<span class="cite-meta">${esc(citationReporter(c))} · `
      + `${esc(c.severity ?? 'no severity')}·${esc(c.kind ?? 'unclassified')}</span> ${esc(c.title)}`
      + (loc ? ` <span class="loc">${esc(loc)}</span>` : '')
      + against

      + (c.resolved ? '' : ' <em>— not in the report; this citation named a finding synthesis did not build</em>')
      + '</li>';
  }).join('\n');
  const rulings = rc.rulings.map((r) =>
    `<blockquote class="${r.ruling === 'one' ? 'validate' : 'challenge'}">`
    + `<strong>${esc(rulingVoice(r))} rules ${esc(r.ruling)}:</strong> ${esc(r.reason)}</blockquote>`,
  ).join('\n');
  return `<details class="card" open>
    <summary>
      <span class="badge" style="color:${sev.color};background:${sev.bg}">${esc(rc.id)}</span>
      <span class="title">${esc(rc.title)}</span>
      <span class="kind">${esc(rc.status)}</span>
    </summary>
    <div class="body">
      <p class="reporters">${esc(ROOT_CAUSE_STATUS[rc.status] ?? rc.status)} · ${rc.citations.length} citations from ${rc.reporters.length} reviewer(s): ${esc(rc.reporters.join(', '))} · ${rc.blocking ? 'blocking' : 'advisory only'}</p>
      <ul class="citations">${citations}</ul>
      ${rc.fix ? `<div class="fix"><strong>Fix:</strong> ${esc(rc.fix)}</div>` : ''}
      ${rulings}
    </div>
  </details>`;
}

// The dashboard's wording for a reproduction, and the same rule the Markdown
// renderer follows: keyed on `confirmed` rather than `status`, and silent for a
// probe nobody ran, because declining to probe has to cost a reviewer nothing.
//
// `esc` on the captured output is not decoration. That string is the stdout of
// code from the diff under review, which is the most attacker-controlled text
// this renderer handles, and it lands inside a `<pre>` in a file people open in
// a browser.
function renderProbe(p) {
  if (!p || p.source !== 'measured') return '';
  const headline = p.confirmed
    ? `<strong>Probe reproduced.</strong> The tool re-ran it and the predicted behavior occurred.`
    : `<strong>Probe did not reproduce</strong> — ${esc(p.why)}.`;
  const expected = p.claim?.expect ? `<p class="probe-expect">Expected: ${esc(p.claim.expect)}</p>` : '';
  const output = p.ran?.output ? `<pre class="probe-output">${esc(p.ran.output)}</pre>` : '';
  return `<div class="probe ${p.confirmed ? 'probe-ok' : 'probe-no'}">
      <p>${headline}</p>
      ${expected}
      ${output}
    </div>`;
}

function renderCard(f) {
  const sev = SEVERITY_BADGE[f.severity];
  const loc = f.file ? `${f.file}${f.line !== null ? `:${f.line}` : ''}` : '';
  const validates = (f.validators || []).map((v) =>
    `<blockquote class="validate"><strong>${esc(v.persona)} validates:</strong> ${esc(v.reason)}</blockquote>`,
  ).join('\n');
  const challenges = (f.challengers || []).map((c) =>
    `<blockquote class="challenge"><strong>${esc(c.persona)} challenges:</strong> ${esc(c.reason)}</blockquote>`,
  ).join('\n');
  return `<details class="card">
    <summary>
      <span class="badge" style="color:${sev.color};background:${sev.bg}">${sev.label}</span>
      <span class="title">${esc(f.title)}</span>
      <span class="kind">${esc(f.kind ?? 'unclassified')}</span>
      ${loc ? `<span class="loc">${esc(loc)}</span>` : ''}
    </summary>
    <div class="body">
      <p class="reporters">Reported by: ${esc(f.reporters.join(', '))} · confidence: ${esc(f.confidence)}${f.provenance === PROVENANCE.regression ? ` · ${REGRESSION_NOTE}` : ''}${f.counterpart ? ` · contradicts ${esc(f.counterpart)}` : ''}</p>
      <div class="detail">${esc(f.detail).replaceAll('\n', '<br>')}</div>
      ${renderProbe(f.probe)}
      ${f.fix ? `<div class="fix"><strong>Fix:</strong> ${esc(f.fix)}</div>` : ''}
      ${validates}
      ${challenges}
    </div>
  </details>`;
}
