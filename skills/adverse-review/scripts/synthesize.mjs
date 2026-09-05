#!/usr/bin/env node
// Skill bridge: deterministic synthesis. Reads round-1 / round-2 combined
// JSON files and writes the markdown report (and optional JSON / HTML).
// Wraps the same `synthesize` and `renderMarkdown` used by the CLI, so the
// Skill and the standalone CLI produce byte-identical reports given the same
// inputs.

import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync } from 'node:fs';

import { importFromSrc } from './package-root.mjs';

const { synthesize, renderMarkdown, toJsonReport } = await importFromSrc('synthesis.mjs');
const { renderHtml } = await importFromSrc('html.mjs');

const { values } = parseArgs({
  options: {
    round1:     { type: 'string' },
    round2:     { type: 'string' },
    out:        { type: 'string' },
    'json-out': { type: 'string' },
    'html-out': { type: 'string' },
    skipped:    { type: 'string', multiple: true },
    degraded:   { type: 'string', multiple: true },
    'round2-skipped': { type: 'string' },
  },
  strict: true,
});

if (!values.round1) {
  process.stderr.write('Usage: synthesize.mjs --round1 <combined.json> [--round2 <combined.json>] [--out report.md] [--json-out report.json] [--html-out report.html] [--skipped persona=reason] [--degraded persona] [--round2-skipped reason]\n');
  process.exit(2);
}

let round1, round2 = {};
try {
  round1 = JSON.parse(readFileSync(values.round1, 'utf-8'));
  if (values.round2) round2 = JSON.parse(readFileSync(values.round2, 'utf-8'));
} catch (e) {
  process.stderr.write(`synthesize: ${e.message}\n`);
  process.exit(1);
}

// --skipped auditor="reason" records a lane that was deliberately not run, so
// the report cannot present its silence as a clean bill of health.
const skippedPersonas = (values.skipped ?? []).map((spec) => {
  const at = spec.indexOf('=');
  return at === -1
    ? { persona: spec, reason: null }
    : { persona: spec.slice(0, at), reason: spec.slice(at + 1) };
});

// --degraded adversary records a lane that was TRIED and FAILED, which is not
// the same as one deliberately skipped and must not be spelled the same way.
// The stop condition refuses to converge while any lane is degraded — a lane
// that failed did not find nothing, it did not look — and until this flag
// existed there was no way for the Skill's own loop to say so, so `synthesize`
// reported four healthy lanes and three findings as a unanimous SHIP.
const failedPersonas = (values.degraded ?? []).map((spec) => spec.split('=')[0]);

// --round2-skipped makes a skipped round 2 visible in the report; a run whose
// round 2 was skipped and not declared is textually indistinguishable from one
// where the panel cross-examined and found nothing. An EMPTY value is that
// same failure wearing a declaration's clothes (an unset $R2_REASON expands to
// ""), so it is a usage error, not a silent no-op.
if (values['round2-skipped'] !== undefined && values['round2-skipped'].trim() === '') {
  process.stderr.write('synthesize: --round2-skipped requires a non-empty reason\n');
  process.exit(2);
}
const syn = synthesize(round1, round2, {
  skippedPersonas, failedPersonas, round2Skipped: values['round2-skipped'] ?? null,
});
const md = renderMarkdown(syn);

if (values.out) writeFileSync(values.out, md, 'utf-8');
else process.stdout.write(md);

if (values['json-out']) writeFileSync(values['json-out'], JSON.stringify(toJsonReport(syn), null, 2), 'utf-8');
if (values['html-out']) writeFileSync(values['html-out'], renderHtml(syn), 'utf-8');

process.stderr.write(`✅ verdict: ${syn.consensusLabel} · ${syn.findings.length} findings\n`);

if (syn.consensusLabel.startsWith('BLOCK')) {
  process.exit(1);
}
