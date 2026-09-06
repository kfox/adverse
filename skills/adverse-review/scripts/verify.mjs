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
// round 1.
//
// So does every `verified` entry still `open`. That is the reviewer saying THE
// FIX DID NOT WORK, and it used to be dropped: `findings: payload.added`
// discarded the whole `verified` array, so a payload whose own verdict was
// `reject` reshaped into an empty findings array. `convergenceStatus`
// (src/ledger.mjs) computes `done` over exactly that array and consults no
// verdict, so `converge.mjs` printed "converged: no blocking finding is
// unsettled" and exited 0 — the loop's success signal — on a fix a reviewer
// had just said failed. That is the failure this whole design exists to
// prevent, one layer down: a lane that found nothing must never read the same
// as a lane that did not look.
//
// The erasure is closed here, in Node, and not left to the orchestrating
// model: a model in the stop condition can hallucinate convergence, and
// convergence is the product.
//
// A reopened finding needs the severity and kind it had when it was first
// reported, because `isBlocking` is defined over both — re-emitting an
// unknown-severity finding as `info` would put it straight back in the hole
// this closes. `--briefing` supplies them; without it each reopened finding
// falls back to a blocking `warning`/`behavioral`, which is the noisy
// direction and the recoverable one.
//
// `verified` also rides along on the reshaped file so the operator can read
// every disposition — closed and moot included — while deciding what to record
// in Phase 7. It is not carried into `report.json`; the dispositions that have
// to reach the arithmetic are the open ones, and those are now findings.


import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { makeWriteGuard, readJson, requireKnownPersona, usage } from './bridge-io.mjs';

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
    briefing: { type: 'string' },
  },

  strict: true,
  allowPositionals: true,
});

values.verify = [...(values.verify ?? []), ...positionals];
if (!values.verify.length || !values.outdir) {
  usage('Usage: verify.mjs --verify a.json [--verify b.json …] --outdir <dir>'
      + ' [--briefing briefing.json]');
}

const claimDest = makeWriteGuard('verify');


// The anchor a reopened finding gets when `--briefing` did not supply one.
// Blocking on purpose: `isBlocking` is `kind is not advisory && severity is
// not info`, so any weaker default would silently un-block the verification
// that says a fix failed — reinstating the bug this bridge is fixing.
const REOPENED_FALLBACK = { severity: 'warning', kind: 'behavioral' };

// Every finding the previous round briefed, by the ID the verify payload
// references. Absent without `--briefing`, which is why the fallback above has
// to stand on its own.
const briefed = new Map();
if (values.briefing) {
  const doc = readJson(values.briefing, 'verify');
  for (const f of doc?.findings ?? []) {
    if (f && typeof f.id === 'string') briefed.set(f.id, f);
  }
}

// A verification still `open` is the reviewer saying the fix did not work.
// Re-emitted as a finding so the arithmetic that stops the loop can see it;
// the original anchor is preserved so the ledger can still recognize it, and
// `reason` is carried into `detail` because that is the reviewer's evidence.
function reopenedFinding(v) {
  const original = briefed.get(v.id) ?? {};
  const reason = typeof v.reason === 'string' ? v.reason : '';
  return {
    // The severity it was first reported at, not a promoted one. An `info`
    // finding never blocked, and re-emitting it as a blocker would mean the
    // loop could never converge while any advisory remark stayed open.
    severity: original.severity ?? REOPENED_FALLBACK.severity,
    kind: original.kind ?? REOPENED_FALLBACK.kind,
    file: original.file ?? null,
    line: original.line ?? null,
    counterpart: original.counterpart ?? null,
    title: typeof v.title === 'string' ? v.title : String(v.id),
    detail: `Verification: STILL OPEN after the recorded fix. ${reason}`.trim(),
    fix: original.fix ?? null,
  };
}



let totalClosed = 0, totalOpen = 0, totalMoot = 0, totalAdded = 0;

for (const src of values.verify) {
  const payload = readJson(src, 'verify');

  // Same registry check as triage.mjs and combine.mjs, at the earlier reader:
  // the persona string keys the output filename and, downstream, triage's
  // verdicts map — a re-cased or invented name would mint a phantom reviewer.
  requireKnownPersona(payload?.persona, { prefix: 'verify', file: src, personas: DEFAULT_PERSONAS });

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

  // The reviewer table on the report reads this, and a persona that still
  // calls something open must not render as an approval. The stop condition
  // does NOT read it — it reads `findings`, which is why the reopened
  // verifications below have to be in there and a correct verdict here is not
  // a substitute for them.
  const verdict = open > 0 ? 'reject' : (payload.added.length > 0 ? 'conditional' : 'approve');

  const reopened = payload.verified
    .filter((v) => v.status === 'open')
    .map(reopenedFinding);

  const out = {
    persona: payload.persona,
    verdict,
    summary: `verify: ${closed} closed, ${open} open, ${moot} moot; ${payload.added.length} new finding(s)`,
    findings: [...reopened, ...payload.added],
    verified: payload.verified,
  };


  // The roster check above was here from the start; the collision check was
  // not, so two payloads for one persona still collapsed onto one file.
  const dest = claimDest(`${values.outdir}/round1-${payload.persona}.verified.json`, src);

  writeFileSync(dest, JSON.stringify(out, null, 2), 'utf-8');
  process.stdout.write(`verified ${src} -> ${dest}\n`);
}

process.stdout.write(`${values.verify.length} persona(s) verified: `
  + `${totalClosed} closed, ${totalOpen} open, ${totalMoot} moot, ${totalAdded} new finding(s) added\n`
  + `  ${totalOpen} still-open verification(s) re-emitted as findings, so the stop`
  + ` condition can see them${values.briefing ? '' : ' (no --briefing: severity/kind fall back to warning/behavioral)'}\n`);

