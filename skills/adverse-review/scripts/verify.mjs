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

import { makeWriteQueue, parseBridgeArgs, readJson, requireKnownPersona, usage } from './bridge-io.mjs';

import { importFromSrc } from './package-root.mjs';

const { briefingEntries } = await importFromSrc('decisions.mjs');
const { validateVerify } = await importFromSrc('prompts.mjs');
const { stampedFieldClaim } = await importFromSrc('synthesis.mjs');
const { DEFAULT_PERSONAS } = await importFromSrc('personas.mjs');
const { KINDS, SEVERITIES } = await importFromSrc('taxonomy.mjs');

// Positionals are verify payloads, so `--verify run/verify-*.json` works —
// same reason as triage.mjs and repair.mjs: strict parsing without this throws
// on the second path the shell expands, and the glob is the obvious thing to
// type.
const USAGE = 'Usage: verify.mjs --verify a.json [--verify b.json …] --outdir <dir>'
  + ' [--briefing briefing.json] [--report report.json]';

const { values, positionals } = parseBridgeArgs({
  prefix: 'verify',
  usage: USAGE,
  options: {
    verify: { type: 'string', multiple: true },
    outdir: { type: 'string' },
    briefing: { type: 'string' },
    report: { type: 'string' },
  },
  strict: true,
  allowPositionals: true,
});

values.verify = [...(values.verify ?? []), ...positionals];
if (!values.verify.length || !values.outdir) {
  usage(USAGE);
}

// Nothing reaches disk until every payload has been read and validated — see
// bridge-io.mjs. A refusal on payload N used to leave payloads 1..N-1 published
// as `round1-<persona>.verified.json`, which is the opposite of the standard
// regression.mjs's fold states two files away.
const writes = makeWriteQueue('verify');


const normalizeTitle = (s) => (typeof s === 'string' ? s.trim().toLowerCase().replace(/\s+/g, ' ') : '');

// The anchor a reopened finding gets when `--briefing` did not supply one.
// Blocking on purpose: `isBlocking` is `kind is not advisory && severity is
// not info`, so any weaker default would silently un-block the verification
// that says a fix failed — reinstating the bug this bridge is fixing.
const REOPENED_FALLBACK = { severity: 'warning', kind: 'behavioral' };

// Every finding the previous round briefed, by the ID the verify payload
// references. Absent without `--briefing`, which is why the fallback above has
// to stand on its own.
//
// Also indexed by TITLE, because an id lookup alone cannot reach a whole class
// of finding. `briefing.json` IS the round-2 prompt, built from round 1, and
// `report.json` carries no ids at all — so a finding a round-2 reviewer ADDED
// has no briefing id, ever, and its verification is unbindable however
// carefully the operator names it. Measured: a `design`/`info` addition
// reopened by an unbindable id came back `behavioral`/`warning` with a null
// anchor and BLOCKED the loop, with `--briefing` passed and the title matching
// exactly. That breaks two rules at once — "`design` findings never block", and
// this Skill's own remedy for the fallback ("recoverable by passing the flag",
// which for this class it is not).
//
// A title match is not a weaker key than an id here, it is the stronger one:
// the id is reviewer-supplied and unbound, and `bindToBriefing` already refuses
// an id whose entry disagrees with the payload's title. The attack that
// motivated that check — name an `info` id to make a critical come back
// non-blocking — is not reachable through a title, because matching a
// finding's title IS naming that finding.
// First writer wins, and an ambiguous title indexes null: two findings
// sharing one title cannot be told apart by it, and guessing which is
// meant is how a severity gets copied off the wrong finding. The null is a
// sentinel, not a miss — a consumer must ask `has()` before falling back to
// any other source, or the refusal it encodes silently becomes a guess.
function indexByTitle(doc) {
  const byTitle = new Map();
  for (const f of doc?.findings ?? []) {
    if (!f) continue;
    const key = normalizeTitle(f.title);
    if (key) byTitle.set(key, byTitle.has(key) ? null : f);
  }
  return byTitle;
}

const briefed = new Map();
let briefedByTitle = new Map();
if (values.briefing) {
  const doc = readJson(values.briefing, 'verify');
  // The same list decisions.mjs binds an id against, imported rather than
  // spelled again. Hand-written here, this index took an entry on its `id`
  // alone: a title-less entry then answered `v.id`'s lookup, `anchorOf` read
  // `undefined` as the briefing's anchor, and a still-open critical was
  // re-emitted at `warning` with no file and no line — with `id "F3" is
  // undefined in the briefing` on stderr and exit 1, blaming the payload.
  for (const f of briefingEntries(doc)) briefed.set(f.id, f);
  briefedByTitle = indexByTitle(doc);
}

// The previous iteration's report.json, as the anchor source of last resort:
// it is the only file that holds a finding a round-2 reviewer ADDED, because
// triage's only finding input is `--round1` and report.json carries no ids at
// all. Title-bound with the same ambiguity rule as the briefing index, and
// consulted after both briefing routes — a briefed finding is this iteration's
// statement of the same finding and wins.
const reportedByTitle = values.report
  ? indexByTitle(readJson(values.report, 'verify'))
  : new Map();


// The briefing entry a verification is actually ABOUT, or null.
//
// `v.id` is reviewer-supplied and `validateVerify` leaves it untyped and
// unbound, so looking it up and copying severity off whatever it landed on
// let a payload say "the critical fix is STILL OPEN" while naming the id of
// any `info`/`design` finding: the reopened finding came back non-blocking,
// `isBlocking` dropped it, and the loop reported done. That is verbatim the
// erasure this bridge exists to prevent, reintroduced through the flag
// SKILL.md tells the operator to always pass.
//
// So the id has to agree with the title before anything is inherited from it.
// A mismatch is not fatal — the verification is still real and still reopens
// the finding — but it falls back to the blocking default and says so, and an
// id that resolves to nothing is reported the way repair.mjs reports one.
function bindToBriefing(v, src) {
  // EVERY index, or the title routes are unreachable for the anchor sources
  // that motivated them: a document whose findings carry no `id` fills only
  // the title maps and leaves `briefed` empty, and this line returned first.
  if (!briefed.size && !briefedByTitle.size && !reportedByTitle.size) return null;
  let entry = briefed.get(v.id);
  if (!entry) {
    // The id named nothing. Fall back to the title, which is the join key every
    // downstream edge already rides on. The class this reaches is a BRIEFED
    // finding cited by a stale or invented id: `briefing.mjs` re-mints ids
    // positionally on every triage run, so an id copied from an earlier
    // iteration's briefing names nothing here, or worse, names a different
    // finding. A round-2 ADDITION is in `briefing.json` under no key at all —
    // triage's only finding input is `--round1` — which is what `--report`
    // exists for: the previous report.json is the one file that holds it.
    // Without that flag its verification lands on REOPENED_FALLBACK with a
    // null anchor: noisy rather than silent, which is the safe direction.
    // `has` before `get`, in each index: an ambiguous title is stored as a
    // null SENTINEL, and `??` reads that refusal as a miss — which is how an
    // ambiguous briefing title fell through to an unrelated report.json entry
    // and inherited its severity at exit 0.
    const key = normalizeTitle(v.title);
    const byTitle = briefedByTitle.has(key)
      ? briefedByTitle.get(key)
      : reportedByTitle.get(key);
    if (byTitle) return byTitle;
    if (briefedByTitle.has(key) || reportedByTitle.has(key)) {
      process.stderr.write(`  ! verify: ${src}: title ${JSON.stringify(v.title)} matches more`
        + ' than one finding, so binding it would guess — anchor not inherited\n');
      process.exitCode = 1;
      return null;
    }
    process.stderr.write(`  ! verify: ${src}: unresolvable id ${JSON.stringify(v.id)}`
      + ` and no briefed or reported finding titled ${JSON.stringify(v.title)}`
      + ' — anchor not inherited\n');
    process.exitCode = 1;
    return null;
  }
  if (normalizeTitle(entry.title) !== normalizeTitle(v.title)) {
    process.stderr.write(`  ! verify: ${src}: id ${JSON.stringify(v.id)} is`
      + ` ${JSON.stringify(entry.title)} in the briefing, but this verification calls it`
      + ` ${JSON.stringify(v.title)} — anchor not inherited\n`);
    process.exitCode = 1;
    return null;
  }
  return entry;
}

// A verification still `open` is the reviewer saying the fix did not work.
// Re-emitted as a finding so the arithmetic that stops the loop can see it;
// the original anchor is preserved so the ledger can still recognize it, and
// `reason` is carried into `detail` because that is the reviewer's evidence.
function reopenedFinding(v, src) {
  const original = bindToBriefing(v, src) ?? {};
  const reason = typeof v.reason === 'string' ? v.reason : '';

  // Only an in-enum value may be inherited. An out-of-enum severity would be
  // rejected downstream by `buildFinding`, which drops the finding entirely —
  // erasing the verification instead of merely mis-ranking it.
  const severity = SEVERITIES.includes(original.severity)
    ? original.severity : REOPENED_FALLBACK.severity;
  const kind = KINDS.includes(original.kind) ? original.kind : REOPENED_FALLBACK.kind;

  // A title is the join key every downstream edge rides on, so an empty one
  // is not a cosmetic problem: the finding cannot be matched, and
  // `buildFinding` drops it, which converges the loop on a failed fix.
  const title = normalizeTitle(v.title) ? v.title
    : `still-open verification ${typeof v.id === 'string' && v.id ? v.id : '(unidentified)'}`;

  return {
    // The severity it was first reported at, not a promoted one. An `info`
    // finding never blocked, and re-emitting it as a blocker would mean the
    // loop could never converge while any advisory remark stayed open.
    severity,
    kind,
    file: original.file ?? null,
    line: original.line ?? null,
    counterpart: original.counterpart ?? null,
    title,
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

  const err = validateVerify(payload, payload.persona)
    // `provenance` is what makes the report say a fix commit's regression pass
    // found a finding, and this bridge is its EARLIEST reader: SKILL.md never
    // runs `validate.mjs --phase verify`, so the check the regression fold got
    // has no counterpart on this path. Measured before this line existed: an
    // `added` entry carrying `provenance: "regression"` validated clean, exit
    // 0, and the key rode into `round1-<persona>.verified.json` verbatim — a
    // reviewer labelling its own new finding as one a landed commit
    // introduced, in the tool's own voice.
    ?? stampedFieldClaim(payload);
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
    .map((v) => reopenedFinding(v, src));

  const out = {
    persona: payload.persona,
    verdict,
    summary: `verify: ${closed} closed, ${open} open, ${moot} moot; ${payload.added.length} new finding(s)`,
    // Only a ledger entry may write `adjudicated`; a reviewer payload carrying
    // one would settle its own finding downstream.
    findings: [...reopened, ...payload.added.map(({ adjudicated: _selfDeclared, ...f }) => f)],
    verified: payload.verified,
  };


  // The roster check above was here from the start; the collision check was
  // not, so two payloads for one persona still collapsed onto one file. It is
  // made at QUEUE time, so the collision is refused before the first file is
  // written rather than after the colliding payload's sibling is on disk.
  writes.queue(`${values.outdir}/round1-${payload.persona}.verified.json`, src,
    JSON.stringify(out, null, 2));
}

writes.flush('verified');

process.stdout.write(`${values.verify.length} persona(s) verified: `
  + `${totalClosed} closed, ${totalOpen} open, ${totalMoot} moot, ${totalAdded} new finding(s) added\n`
  + `  ${totalOpen} still-open verification(s) re-emitted as findings, so the stop`
  + ` condition can see them${values.briefing ? '' : ' (no --briefing: severity/kind fall back to warning/behavioral)'}\n`);

