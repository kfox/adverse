// A reproduction a reviewer attached to a finding, and what happened when this
// module re-ran it.
//
// `behavioral` is defined in src/taxonomy.mjs as a finding "settled by
// executing it OR by an argument about execution", and until this module every
// behavioral finding on every run was settled by the second clause. That
// matters because behavioral findings BLOCK, and because cross-validation is
// weaker evidence for them than for a `defect`: two lanes agreeing on a defect
// means two lanes read the same line and saw the same thing, while two lanes
// agreeing on a behavioral finding is two arguments about runtime, and two
// reviewers can share a wrong model of runtime as easily as one can. The
// confidence label could not tell those apart, so `cross-validated` meant
// something materially different depending on `kind` and the report did not
// say so.
//
// The capability was already there and already paid for: Phase 1 gives each
// reviewer its own detached worktree precisely because "some of them mutate
// the tree to test a claim", and every persona has Bash. What was missing was
// a CHANNEL for the result. A reviewer that reproduced a bug in its worktree
// wrote prose about it into `detail`, the worktree was deleted at hand-over,
// and nothing downstream could tell that finding from one that was reasoned
// out.
//
// So: the reviewer proposes and this module confirms — the same routing rule
// src/regression.mjs documents for fix commits, and for the same reason. A
// claim only the reporter observed is not better evidence than an argument,
// and the interested party must not be the one that confirms its own
// reproduction. `confirmed` is computed HERE, from an exit code this process
// collected, and it is the only thing that buys a finding the `demonstrated`
// label.
//
// The asymmetry is deliberate, and it is the same one src/gate.mjs makes.
// Everything that is not a reproduction this module ran and watched succeed —
// a declined probe, an unrunnable script, a run nobody enabled, a claim with
// no script behind it — is `confirmed: false`, which changes nothing about the
// finding. A probe can only ever ADD evidence. It cannot subtract any, it
// cannot make a lane report less, and it cannot move an advisory kind: a
// `design` finding with a reproduced probe is still advisory, because what a
// probe changes is what a finding is WORTH and not what a lane is allowed to
// say.
//
// What this module deliberately does NOT do is disprove a finding. A probe
// that runs and exits non-zero is recorded as `not-reproduced` and annotated
// loudly for round 2 to read, never marked DISPROVED the way a cited file that
// does not exist is. The two are not the same kind of fact: a missing file is
// mechanically certain, while a reproduction that fails to reproduce is either
// a finding that was wrong or a shell script that was, and this module cannot
// tell those apart. Dropping the finding is the silent failure and annotating
// it is the noisy one, so it annotates.

import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { refuseDirectRun } from './entryGuard.mjs';
import { closeQuietly, openRegularFileSync } from './fsSafe.mjs';

refuseDirectRun(import.meta.url);

// A probe is a reproduction, so it is written the way a failing test is: exit 0
// when the predicted behavior was observed. Everything else is the absence of
// that observation, and a script that could not run at all is neither.
export const PROBE_OUTCOMES = Object.freeze(['reproduced', 'not-reproduced', 'inconclusive']);

// Where a probe's result came from. `measured` means this module spawned the
// script and read its exit code; `declined` covers every way a claim reached
// here without being run — probes off for the run, past the lane's cap, no
// script attached, a script this module refused to open. The distinction is
// the point of the file, so it is a field and not a convention about how `why`
// is worded.
export const PROBE_SOURCES = Object.freeze(['measured', 'declined']);

// Long enough for a reproduction that has to build or start something, short
// enough that four lanes' probes cannot hold a review open. A probe that needs
// longer than this is one the reporter should be declaring `inconclusive`
// instead — see the module header on why declining has to stay free.
// The four states a probe declaration can be in, as one predicate. The WORDING
// is per renderer — Markdown, HTML and a pull-request comment address different
// readers, the way the root-cause status labels already do — but which of the
// four a run is in must not be decided three times. That is the shape with the
// track record here: every fact stated in several places with only one of them
// executable has drifted.
export const PROBE_STATES = Object.freeze(
  ['not-offered', 'unrecorded', 'not-enabled', 'ran']);

export const DEFAULT_PROBE_TIMEOUT_MS = 60_000;

// The output IS the evidence a human reads beside the finding, so this is far
// more generous than gate.mjs's one-line `lastMeaningfulLine`. It is still
// bounded: the string is rendered into a Markdown report and an HTML
// dashboard, and a probe that prints a gigabyte is a probe that ate the report.
export const MAX_PROBE_OUTPUT_CHARS = 4_000;

// How many probes one lane may attach. Small on purpose, and it is a budget
// rule rather than a safety one: a reviewer's job is to read code, and a lane
// that spends its call writing shell scripts has reviewed less of the diff than
// a lane that wrote none. Two is enough for the case this exists for — a lane
// that found one or two behavioral claims worth settling by execution — and few
// enough that attaching them cannot become the lane's default work.
//
// Enforced by the bridge, not by the prompt: a cap a reviewer is asked to
// respect is a cap that holds until a reviewer does not.
export const MAX_PROBES_PER_LANE = 2;

// How a script is run, keyed on its extension. An explicit table rather than a
// shebang or the executable bit, for two reasons: the file arrives from a
// reviewer's subdirectory and never needs to be made executable, and the set
// of interpreters this flow will spawn is then readable in one place instead
// of being whatever the first line of an agent-written file happens to say.
//
// Null prototype, as this repo does for every lookup keyed by something a
// payload names — and here it is genuinely belt-and-braces rather than the
// defense, which is worth writing down so nobody removes the real one by
// mistake. `path.extname` always returns a LEADING DOT, so the key is
// `.constructor` and never `constructor`, and no Object.prototype member is
// reachable through it: a plain object refuses `probes/x.constructor` exactly
// as this does. Measured, by making the object a plain one and re-running the
// suite: nothing went red. The null prototype stays because the cost is zero
// and the property should not depend on `extname` continuing to behave that
// way, but the guarantee is the dot.
export const INTERPRETERS = Object.freeze(Object.assign(Object.create(null), {
  '.sh': ['sh'],
  '.bash': ['bash'],
  '.js': ['node'],
  '.mjs': ['node'],
  '.py': ['python3'],
}));

// Proxy variables are unset and `no_proxy` is set for every probe. This is a
// HINT and not containment, and saying which it is matters more than the
// scrubbing does: a probe runs whatever the diff under review contains, and a
// reviewer probing an injection finding is running an exploit on purpose. The
// record this module writes reports `network: 'inherited'` unless the caller
// passed a real sandbox, because claiming an isolation this process cannot
// enforce is the same failure mode as an asserted gate.
const PROXY_VARS = Object.freeze(
  ['http_proxy', 'https_proxy', 'all_proxy', 'ftp_proxy',
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'FTP_PROXY']);

function clip(text) {
  if (typeof text !== 'string' || !text) return '';
  return text.length > MAX_PROBE_OUTPUT_CHARS
    ? `${text.slice(0, MAX_PROBE_OUTPUT_CHARS)} [clipped at ${MAX_PROBE_OUTPUT_CHARS} chars]`
    : text;
}

function coerceStr(v) {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

// The reviewer's half of the record, canonicalized. Everything is optional and
// nothing here is trusted: `outcome` is what the REPORTER says it saw, and it
// is kept beside what this module saw so a reader can compare them. An
// unrecognized outcome normalizes to `inconclusive`, the value that claims
// nothing — the same direction src/synthesis.mjs's `normalizeVerdict` takes,
// where garbage must not be able to buy a stronger word than the vocabulary
// allows.
export function parseProbeClaim(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const outcome = coerceStr(raw.outcome);
  return {
    script: coerceStr(raw.script),
    expect: coerceStr(raw.expect) ?? '',
    observed: coerceStr(raw.observed) ?? '',
    outcome: PROBE_OUTCOMES.includes(outcome) ? outcome : 'inconclusive',
  };
}

// Either the absolute path this module may spawn, or the reason it may not.
// Modeled on src/triage.mjs's `resolveCited`, and it has the same job: a path
// out of reviewer JSON that is about to become an argument to something.
//
// `root` is the reviewer's own run subdirectory. A probe may only name a file
// inside it — not the checkout, not a sibling lane's directory, not anywhere
// else on the machine — so a probe cannot run a script the reviewer did not
// write, and cannot reach for one another lane wrote.
export function resolveScript(root, script) {
  if (typeof script !== 'string' || !script) return { why: 'no script was attached' };

  const abs = path.resolve(root, script);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    return { why: `script escapes the reporter's own directory: ${script}` };
  }

  const ext = path.extname(abs).toLowerCase();
  const argv = INTERPRETERS[ext];
  if (!argv) {
    return { why: `no interpreter for ${ext || 'a script with no extension'}`
      + ` (known: ${Object.keys(INTERPRETERS).join(', ')})` };
  }

  // Opened rather than stat'd, for the reason src/fsSafe.mjs exists: this path
  // is about to be handed to a subprocess, and a check against the path leaves
  // a window for a symlink to be swapped in before the spawn lands. The
  // descriptor is closed immediately — it proves the path was a regular file
  // and refuses a symlink, a FIFO and a directory, which is the whole of what
  // is checkable before an exec.
  let fd = null;
  try {
    fd = openRegularFileSync(abs);
  } catch {
    return { why: `script is not a readable regular file: ${script}` };
  }
  if (fd === null) return { why: `script is not a regular file: ${script}` };
  closeQuietly(fd);

  return { path: abs, argv };
}

// The environment a probe runs in. Not a sandbox — see PROXY_VARS.
function probeEnv(env) {
  const out = { ...env };
  for (const v of PROXY_VARS) delete out[v];
  out.no_proxy = '*';
  out.NO_PROXY = '*';
  // A probe that shells back into this flow would recurse, and would append a
  // telemetry line for a review nobody ran.
  out.ADVERSE_NO_TELEMETRY = '1';
  return out;
}

// What THIS module observed, from an exit code it collected itself. A script
// that could not be spawned, or that the timeout killed, observed nothing:
// that is `inconclusive`, never a pass and never a failure. Folding it into
// either one is how "we could not tell" becomes a verdict, which is the class
// of bug src/gate.mjs was written to close and this module inherits.
function observed(r) {
  if (r.error != null || r.signal != null || typeof r.status !== 'number') return 'inconclusive';
  return r.status === 0 ? 'reproduced' : 'not-reproduced';
}

// Compute `confirmed` and, when it is false, the one-line reason. Everything
// downstream reads about a probe's weight comes from here and nowhere else, so
// there is one place to audit and one place a new source has to be handled.
//
// Three conditions, and all three are necessary. The run has to have HAPPENED
// (`source`), this module has to have SEEN the behavior (`status`), and the
// reporter has to have CLAIMED it — a reviewer whose own probe says
// `not-reproduced` is not asking anyone to believe a reproduction, and a
// finding cannot collect the report's strongest label off a script its author
// never said proved anything.
function finalize(record) {
  const { source, status, claim } = record;

  let why = '';
  if (source !== 'measured') why = record.why || 'the probe was not run';
  else if (status === 'inconclusive') why = 'the probe could not be run to a verdict';
  else if (status === 'not-reproduced') {
    why = claim.outcome === 'reproduced'
      ? 'the reporter recorded a reproduction, and re-running it did not reproduce'
      : 'the probe ran and the predicted behavior did not occur';
  } else if (claim.outcome !== 'reproduced') {
    why = `the probe reproduced, but its reporter recorded \`${claim.outcome}\``;
  }

  return { ...record, confirmed: why === '', why };
}

function identity({ persona, agent, title }) {
  return { persona, agent, title };
}

// A claim nothing ran, and the reason. Never an error: declining to probe has
// to stay free, or reviewers invent probes, and a fabricated reproduction is
// worse than an honest argument.
export function declinedProbe(entry, why) {
  return finalize({
    ...identity(entry),
    claim: entry.claim,
    source: 'declined',
    status: 'inconclusive',
    ran: null,
    why,
  });
}

// Run one probe and record what happened. `run` is injected so the tests do
// not have to spawn anything, and so a caller that already has a result can
// build a record without re-running it.
export function runProbe(entry, {
  cwd,
  root,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
  run = spawnSync,
  env = process.env,
  sandbox = [],
} = {}) {
  const claim = entry.claim;
  const resolved = resolveScript(root, claim.script);
  if (resolved.why) return declinedProbe(entry, resolved.why);

  // `sandbox` is whatever containment the OPERATOR supplied, prepended
  // verbatim — `bwrap --unshare-net --`, `sandbox-exec -f probe.sb`, a
  // container runner. Nothing here validates it and nothing here invents one:
  // this process cannot enforce network isolation on its own, and a tool that
  // claimed to would be making the same unmeasured promise src/gate.mjs exists
  // to refuse. What it can do is run what it was given and record what that
  // was, which is what `isolation` in the written record reports.
  const argv = [...sandbox, ...resolved.argv, resolved.path];

  const started = Date.now();
  const r = run(argv[0], argv.slice(1), {
    cwd,
    encoding: 'utf-8',
    timeout: timeoutMs,
    env: probeEnv(env),
    // A probe reads nothing. Leaving stdin open lets a script that prompts sit
    // until the timeout kills it and report `inconclusive` for a reason that
    // has nothing to do with the finding.
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  return finalize({
    ...identity(entry),
    claim,
    source: 'measured',
    status: observed(r),
    ran: {
      exitCode: typeof r.status === 'number' ? r.status : null,
      durationMs: Date.now() - started,
      // Both streams, in that order, because a reproduction says what it saw
      // wherever it likes and the whole point of keeping this is that a human
      // can read it next to the finding.
      output: clip([r.stdout, r.stderr].filter(Boolean).join('\n').trim()),
      failure: r.error?.message ?? (r.signal ? `killed by ${r.signal}` : null),
    },
    why: '',
  });
}

// The join key between a probe record and the finding it belongs to: the lane
// that reported it, and its title case-folded with runs of whitespace
// collapsed and trailing punctuation dropped — src/synthesis.mjs's `normTitle`,
// which is the join every other cross-round edge in this flow makes.
//
// The one addition is the leading `.trim()`, and it is load-bearing rather
// than tidiness. The two sides of this join see the same title in two states:
// `buildFinding` trims before it keys, while a probe record carries the raw
// string its payload wrote. Without the trim, `"  x  "` keys as `" x "` on one
// side and `"x"` on the other, and the probe silently fails to attach — no
// error, no missing field, just a finding that is never `demonstrated`.
// Trimming inside the one function BOTH sides call is what keeps them in step;
// it is safe here precisely because nothing compares this key to `normTitle`'s.
export function probeKey(persona, title) {
  const normalized = String(title ?? '').trim().toLowerCase()
    .split(/\s+/).join(' ')
    .replace(/[.:,;!?]+$/, '');
  return `${persona} ${normalized}`;
}

// Records indexed for lookup by the readers that attach them to findings. A
// Map, not an object: both halves of the key are payload-supplied strings.
// First record wins — a lane that filed two probes under one title has filed
// one finding twice, and the second cannot add evidence the first did not.
export function indexProbes(records) {
  const byKey = new Map();
  for (const r of records ?? []) {
    if (!r || typeof r !== 'object') continue;
    const key = probeKey(r.persona, r.title);
    if (!byKey.has(key)) byKey.set(key, r);
  }
  return byKey;
}

// Canonicalize whatever arrived — nothing, or a file written by the probe
// bridge — into the one shape every reader expects, and re-bind it to the tree
// actually under review.
//
// Re-running `finalize` here rather than trusting a stored `confirmed` is the
// same rule src/gate.mjs's `normalizeGate` follows, and so is the re-binding:
// the stored flag was computed when the script ran, before anyone knew which
// commit would be reviewed, so staleness is only knowable now. A convergence
// loop makes that concrete — Phase 9 lands fix commits and loops back through
// the same run directory, and a `probes.json` an earlier iteration left there
// would otherwise go on confirming findings against a tree that has moved
// underneath it.
//
// Every failure lands on `declined`, which confirms nothing. That is the
// direction this module fails in everywhere: a probe can only add evidence, so
// losing one costs a label and never a finding.
export function normalizeProbes(value, { head = null } = {}) {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return null;

  const fileHead = coerceStr(value.head);
  const enabled = value.enabled === true;
  const stale = head != null && fileHead !== head;

  let voided = '';
  if (!enabled) voided = 'probe execution was not enabled for this run';
  else if (stale) {
    voided = fileHead === null
      ? 'these probes are not bound to a commit, so they may describe a different tree'
      : `these probes ran against ${fileHead.slice(0, 8)}, not the tree under review`
        + ` (${head.slice(0, 8)})`;
  }

  const list = Array.isArray(value.probes) ? value.probes : [];
  return {
    enabled,
    head: fileHead,
    isolation: value.isolation ?? null,
    probes: list
      .filter((p) => p && typeof p === 'object' && !Array.isArray(p))
      .map((p) => finalize({
        persona: coerceStr(p.persona),
        agent: coerceStr(p.agent),
        title: typeof p.title === 'string' ? p.title : '',
        claim: parseProbeClaim(p.claim) ?? parseProbeClaim({}),
        source: voided || !PROBE_SOURCES.includes(p.source) ? 'declined' : p.source,
        status: PROBE_OUTCOMES.includes(p.status) ? p.status : 'inconclusive',
        ran: p.ran && typeof p.ran === 'object' && !Array.isArray(p.ran) ? p.ran : null,
        why: voided || (typeof p.why === 'string' ? p.why : ''),
      })),
  };
}

// A probe record reduced to counts: how often a panel attached a reproduction
// at all, how often re-running it confirmed what the reporter said, and how
// often it contradicted them.
//
// Counts only, and deliberately: this is shared with the telemetry row, whose
// whole contract is that it carries no script paths, no probe output and no
// `why` strings. `enabled` is the denominator every other number here needs —
// zero probes on a run that never enabled execution is not the same data point
// as zero on a run that did.
export function probeSummary(record) {
  if (!record) return null;
  const list = record.probes ?? [];
  const measured = list.filter((p) => p.source === 'measured');
  return {
    enabled: record.enabled === true,
    attached: list.length,
    ran: measured.length,
    confirmed: measured.filter((p) => p.confirmed).length,
    contradicted: measured.filter((p) => !p.confirmed).length,
    sandboxed: Boolean(record.isolation?.sandbox),
  };
}

// The run's own answer to what execution was asked of this panel, for the
// report to carry. #75's rule, applied to the last declaration that was still
// prose: a reduced run must say so, or it reads exactly like a full one that
// found nothing. A report with no probe on any finding is produced by a run
// that never offered them, a run that offered them and recorded none, a run
// whose reviewers attached some and where execution was never enabled, and a
// run that ran them and reproduced nothing — four different claims.
//
// Two inputs because they are two facts, not one fact twice. The plan's policy
// says whether the panel could attach a reproduction at all, and it is on disk
// for every run — including the common one, where SKILL.md Phase 2.5 is
// skipped outright and no probes.json is ever written, which is precisely the
// case a flag carried on the record cannot reach. The record says what
// execution then did. Neither input can answer for the other, and `null` on
// either is "not recorded" rather than "no" — the distinction `depth: null`
// exists to keep.
export function probeDeclaration(record, policy = null) {
  const summary = probeSummary(record);
  if (!summary && !policy) return null;
  return {
    offered: policy ? policy.allowed === true : null,
    reason: (policy?.reason && String(policy.reason)) || null,
    ...(summary ?? {
      enabled: null, attached: null, ran: null,
      confirmed: null, contradicted: null, sandboxed: null,
    }),
  };
}

// Which of PROBE_STATES a run is in, decided once for all three renderers.
// The WORDING is per renderer — Markdown, HTML and a pull-request comment
// address different readers, the way the root-cause status labels already do —
// but the state must not be decided three times. That is the shape with the
// track record here: every fact stated in several places with only one of them
// executable has drifted.
export function probeState(declaration) {
  if (!declaration) return null;
  // Execution is checked FIRST, and the order is the whole point. A plan that
  // forbade probes cannot make it true that none ran: the two yeses are
  // checked independently (this module's `enabled`), so the only way to reach
  // a policy of `false` beside a record of `true` is for one of them to be
  // wrong, and of the two possible reports the false one is "nothing here was
  // settled by running the code" next to a finding a reproduction confirmed.
  // Counts describe what happened; a policy only describes what was allowed.
  if (declaration.enabled === true) return 'ran';
  if (declaration.offered === false) return 'not-offered';
  if (declaration.enabled === null) return 'unrecorded';
  return 'not-enabled';
}
