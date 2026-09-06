#!/usr/bin/env node
// Skill bridge: Phase 9 verification. Validates each persona's verify payload
// against the schema (src/prompts.mjs's validateVerify) and reshapes it into
// the round-1 shape triage.mjs already reads via --round1, so a verify pass
// can loop back through triage -> synthesize the same way round 1 did.
//
// Why this exists. Every other leg of the flow — collect, triage, repair,
// combine, synthesize, converge — has a deterministic bridge that checks a
// model's JSON before anything downstream trusts it. validateVerify was
// written for Phase 9 and had no caller: the one round whose entire output is
// a claim about whether earlier decisions held was the round where the
// orchestrating model, not Node code, checked the payload shape. This is the
// missing bridge.
//
// `added` becomes `findings`: brand-new defects this persona is reporting this
// round, which triage.mjs claim-checks and assigns fresh IDs exactly like
// round 1. `verified` — the dispositions on findings this persona already
// reported — has no triage-side counterpart (triage does not re-litigate an
// old finding's status), so it rides along unchanged: Phase 7 needs every
// disposition to decide whether to record `fixed`, and dropping the field here
// would be exactly the kind of silent loss this codebase treats as a defect.

import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { readJson, usage } from './bridge-io.mjs';
import { importFromSrc } from './package-root.mjs';

const { validateVerify } = await importFromSrc('prompts.mjs');
const { DEFAULT_PERSONAS } = await importFromSrc('personas.mjs');

// Positionals are verify payloads, so `--verify run/verify-*.json` works —
// same reason as triage.mjs and repair.mjs: strict parsing without this throws
// on the second path the shell expands, and the glob is the obvious thing to
// type.
const { values, positionals } = parseArgs({
  options: {
    verify: { type: 'string', multiple: true },
    outdir: { type: 'string' },
  },
  strict: true,
  allowPositionals: true,
});

values.verify = [...(values.verify ?? []), ...positionals];
if (!values.verify.length || !values.outdir) {
  usage('Usage: verify.mjs --verify a.json [--verify b.json …] --outdir <dir>');
}

const KNOWN_PERSONAS = new Set(DEFAULT_PERSONAS);

let totalClosed = 0, totalOpen = 0, totalMoot = 0, totalAdded = 0;

for (const src of values.verify) {
  const payload = readJson(src, 'verify');

  // Same registry check as triage.mjs and combine.mjs, at the earlier reader:
  // the persona string keys the output filename and, downstream, triage's
  // verdicts map — a re-cased or invented name would mint a phantom reviewer.
  if (!KNOWN_PERSONAS.has(payload?.persona)) {
    process.stderr.write(`verify: ${src}: unknown persona ${JSON.stringify(payload?.persona)}`
      + ` (expected one of ${DEFAULT_PERSONAS.join(', ')})\n`);
    process.exit(1);
  }
  const err = validateVerify(payload, payload.persona);
  if (err) {
    process.stderr.write(`verify: ${src}: ${err}\n`);
    process.exit(1);
  }

  const closed = payload.verified.filter((v) => v.status === 'closed').length;
  const open = payload.verified.filter((v) => v.status === 'open').length;
  const moot = payload.verified.filter((v) => v.status === 'moot').length;
  totalClosed += closed;
  totalOpen += open;
  totalMoot += moot;
  totalAdded += payload.added.length;

  // The stop condition reads findings, not this field (src/synthesis.mjs's
  // `isOpenBlocking`), so getting this wrong cannot un-block a real finding —
  // but the reviewer table on the report still reads it, and a persona that
  // still calls something open should not render as an approval.
  const verdict = open > 0 ? 'reject' : (payload.added.length > 0 ? 'conditional' : 'approve');

  const out = {
    persona: payload.persona,
    verdict,
    summary: `verify: ${closed} closed, ${open} open, ${moot} moot; ${payload.added.length} new finding(s)`,
    findings: payload.added,
    verified: payload.verified,
  };

  const dest = `${values.outdir}/round1-${payload.persona}.verified.json`;
  writeFileSync(dest, JSON.stringify(out, null, 2), 'utf-8');
  process.stdout.write(`verified ${src} -> ${dest}\n`);
}

process.stdout.write(`${values.verify.length} persona(s) verified: `
  + `${totalClosed} closed, ${totalOpen} open, ${totalMoot} moot, ${totalAdded} new finding(s) added\n`);
