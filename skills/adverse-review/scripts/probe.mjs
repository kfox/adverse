#!/usr/bin/env node
// Skill bridge: re-run the reproductions round 1 attached, and record what
// happened.
//
// Why this exists is src/probe.mjs's header: `behavioral` findings block, they
// are defined as settleable by execution, and until this script nothing in the
// flow executed anything — so every one of them was settled by argument, and
// the report could not say which. This is the leg that turns a reviewer's
// account into a fact.
//
// The routing rule is the same one src/regression.mjs documents, and it is the
// whole point rather than a precaution: the reviewer PROPOSES a reproduction
// and this script CONFIRMS it. A claim only the reporter observed is not
// better evidence than an argument, and the interested party must not be the
// one that confirms its own work. Nothing a payload writes can set `confirmed`
// — src/probe.mjs computes it here, from an exit code this process collected,
// and src/prompts.mjs refuses a payload that tries to supply one.
//
// This script only measures. It never decides whether the review may proceed
// and it never fails a run: a probe can add evidence to a finding and can
// subtract none, so every way of not getting a result — probes not enabled, a
// script this process would not open, a lane over its cap, a timeout — is
// recorded as `declined` and changes nothing. That is why there is no exit 1
// below. Exit 1 under this contract is a claim about a review, and the worst
// news this script can carry is that a reproduction did not reproduce, which
// is a fact ABOUT a finding for round 2 to read and not a verdict on the change.
//
// ## What this does and does not isolate
//
// It runs untrusted code. The scripts come from reviewers, the behavior they
// reproduce comes from the diff under review, and the Adversary probing an
// injection finding is running an exploit on purpose — that is the capability,
// not a misuse of it.
//
// What is enforced here: a fresh detached worktree per probe, never the user's
// checkout; a hard timeout; no stdin; a script path that must resolve inside
// the reporter's own directory and must be a regular file, opened with
// O_NOFOLLOW; proxy variables scrubbed.
//
// What is NOT enforced here is the network. Node cannot unshare a namespace,
// and a tool that printed "no network" without one would be making exactly the
// unmeasured promise src/gate.mjs was written to refuse. So `--sandbox` takes
// whatever real containment the operator has — `bwrap --unshare-net --`,
// `sandbox-exec -f …`, a container runner — the record says which was applied,
// and `--allow-execute` has to be passed on purpose before any of this runs at
// all.
//
// Exit codes follow the bridge contract (bridge-io.mjs):
//   0  the record was written, whatever the probes said
//   2  usage, or the record could not be written. Nothing was established.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { parseBridgeArgs, readJson, usage } from './bridge-io.mjs';
import { importFromSrc } from './package-root.mjs';

const { DEFAULT_PROBE_TIMEOUT_MS, MAX_PROBES_PER_LANE, declinedProbe, parseProbeClaim, runProbe } =
  await importFromSrc('probe.mjs');
const { worktreeDigest } = await importFromSrc('gate.mjs');
const { DEFAULT_PERSONAS, laneAgentOf } = await importFromSrc('personas.mjs');
const { parseProbePolicy, runLanes } = await importFromSrc('scaling.mjs');
const { resolveRef } = await importFromSrc('trace.mjs');

const USAGE = 'Usage: probe.mjs --round1 a.json [--round1 b.json …] --repo <dir>'
  + ' [--allow-execute] [--plan plan.json] [--sandbox \'<command prefix>\']'
  + ' [--timeout <ms>] [--max-per-lane <n>] --out <probes.json>\n'
  + '  Without --allow-execute nothing is run: every attached probe is recorded\n'
  + '  as declined, which is the correct state for a run whose Phase 0 could not\n'
  + '  confirm a worktree runs the repo\'s gate.';

const { values, positionals } = parseBridgeArgs({
  prefix: 'probe',
  usage: USAGE,
  options: {
    round1: { type: 'string', multiple: true },
    repo: { type: 'string' },
    out: { type: 'string' },
    'allow-execute': { type: 'boolean' },
    plan: { type: 'string' },
    sandbox: { type: 'string' },
    timeout: { type: 'string' },
    'max-per-lane': { type: 'string' },
  },
  strict: true,
  allowPositionals: true,
});

// `--round1 run/*/round1-*.json` is the documented invocation and the natural
// one to type; the shell expands it and the second and later paths arrive as
// positionals. Same accommodation triage.mjs and combine.mjs make.
const sources = [...(values.round1 ?? []), ...positionals];
if (!sources.length || !values.repo || !values.out) usage(USAGE);

function positiveNumber(flag, raw, fallback) {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    usage(`probe: ${flag} must be a positive number, got: ${raw}\n${USAGE}`);
  }
  return n;
}

const timeoutMs = positiveNumber('--timeout', values.timeout, DEFAULT_PROBE_TIMEOUT_MS);

// The plan's own policy, read as data rather than retyped — the same reason
// triage.mjs and combine.mjs take `--plan`. Two independent yeses are required
// before anything runs: the plan saying this is a run where reproductions are
// worth their wall-clock, and `--allow-execute` from an operator who confirmed
// Phase 0 that a worktree here can actually run things. Without `--plan` the
// operator's flag stands alone, which is the standalone invocation.
const planFile = values.plan ? readJson(values.plan, 'probe') : null;
const policy = planFile ? parseProbePolicy(planFile.probes) : null;

// Which lanes this run may execute code on behalf of. The persona registry
// always; the plan's own run-lane roster too, when a plan was given.
//
// triage.mjs applies the same rule one phase later and calls it the roster
// check: a payload from a lane the plan never ran is a stale file from an
// earlier run or a spoof. It matters more here than it does there. There, a
// phantom lane shapes a prompt; here it names a script this process is about
// to SPAWN, and a probe from a lane nobody spawned could never have attached
// to a finding anyway — `probeKey` is (lane, title) and synthesis only looks
// up lanes that reported. So this refuses code that could not have changed the
// report even if it ran.
const roster = new Set(
  planFile && Array.isArray(planFile.lanes)
    ? runLanes(planFile.lanes).map((l) => l.persona).filter((p) => DEFAULT_PERSONAS.includes(p))
    : DEFAULT_PERSONAS);
const maxPerLane = positiveNumber('--max-per-lane', values['max-per-lane'],
  policy ? policy.perLane : MAX_PROBES_PER_LANE);

// Split on whitespace, which is all a prefix needs and is the one form that
// cannot smuggle a shell: the parts become argv entries, never a command line.
const sandbox = values.sandbox ? values.sandbox.trim().split(/\s+/).filter(Boolean) : [];

const repo = path.resolve(values.repo);
const head = resolveRef(repo, 'HEAD');
if (head === null) {
  process.stderr.write(`probe: ${repo}: cannot resolve HEAD`
    + ' — the record could not be bound to a commit\n');
  process.exit(2);
}

// ---------- gather the claims -------------------------------------------------

// The reporter's own directory: the one its payload landed in, which is where
// SKILL.md Phase 2 tells each agent to write. Derived from the payload path
// rather than taken as a flag, so a probe can only ever name a script beside
// the payload that claims it — a lane cannot point at a sibling lane's script,
// and the orchestrator has nothing extra to retype.
function claimsFrom(file) {
  const review = readJson(file, 'probe');
  const persona = typeof review?.persona === 'string' ? review.persona : null;
  // Coerced toward the lane by `laneAgentOf` rather than by a ternary, the
  // same fallback src/briefing.mjs and src/synthesis.mjs apply to the same
  // field: an id that does not name its own lane is a phantom reviewer, and
  // this string is written into a record a human reads.
  const agent = laneAgentOf(persona, review?.agent);
  const root = path.resolve(path.dirname(file));

  const out = [];
  for (const f of Array.isArray(review?.findings) ? review.findings : []) {
    if (!f || typeof f !== 'object' || Array.isArray(f)) continue;
    const claim = parseProbeClaim(f.probe);
    if (!claim) continue;
    out.push({ persona, agent, title: typeof f.title === 'string' ? f.title : '', claim, root });
  }
  return out;
}

// A lane the roster does not carry is refused BEFORE anything spawns, and it is
// declined rather than an exit code: this bridge's whole contract is that it
// never fails a run, and a stale file in the run directory is the operator's
// problem to notice, not a reason to lose the probes that are legitimate.
function offRoster(claim) {
  return roster.has(claim.persona)
    ? null
    : declinedProbe(claim, `no lane named ${JSON.stringify(claim.persona)} is part of this run;`
      + ' its probe was not executed');
}

// The cap is per LANE, not per payload, because a split lane's two halves are
// one reviewer's budget: letting each half attach the maximum doubles what the
// lane spends on scripts for no more coverage of the diff. Payload order
// decides which survive, which is deterministic given the same inputs.
function capPerLane(claims) {
  const spent = new Map();
  return claims.map((c) => {
    const n = (spent.get(c.persona) ?? 0) + 1;
    spent.set(c.persona, n);
    return n > maxPerLane
      ? declinedProbe(c, `lane ${c.persona} attached more than ${maxPerLane} probe(s);`
        + ' this one was not run')
      : c;
  });
}

// `enabled` is the two independent yeses this needs, and nothing else: the
// operator's flag, and the plan's own policy. It is deliberately NOT folded in
// with "was any probe attached" — writing `enabled: false` on a run that
// enabled probes and simply had none to run would be a false claim to every
// reader of this file, all of which treat that flag as "these results do not
// stand".
const enabled = values['allow-execute'] === true
  && (policy === null || policy.allowed)
  && maxPerLane > 0;

// Why nothing ran, when nothing did. Ordered by which gate answered first, so
// the reason a reader gets is the reason that actually applied — the cap
// message reads "more than 0 probe(s)" on a run the plan simply never offered
// probes to, which is true and useless.
const OFF = values['allow-execute'] !== true
  ? 'probe execution was not enabled for this run (--allow-execute)'
  : (enabled ? 'no probe was attached to run'
    : `the plan does not offer probes on this run (${policy?.reason || 'no probes allowed'})`);

// The cap is applied only once both gates said yes. Reaching it on a run that
// is not going to execute anything would overwrite the real reason with a
// budget one.
const attached = sources.flatMap(claimsFrom);
const claims = (enabled ? capPerLane(attached) : attached.map((c) => declinedProbe(c, OFF)))
  .map((c) => (c.source === undefined ? offRoster(c) ?? c : c));
const runnable = claims.filter((c) => c.source === undefined);

// ---------- run them ----------------------------------------------------------

// A worktree per probe, torn down before the next one. Reusing one would let
// probe 1's mutations decide probe 2's exit code, and a reproduction is
// allowed — expected, even — to mutate the tree it runs in.
//
// Detached at HEAD and then patched with whatever is uncommitted, because
// Phase 0's second scope rule reviews uncommitted changes: a worktree at HEAD
// alone does not contain the code under review in that case, and a probe would
// be re-run against a tree that never had the behavior in it. When the patch
// will not apply this refuses to run anything rather than reporting a verdict
// from the wrong tree.
function uncommittedPatch() {
  try {
    return execFileSync('git', ['-C', repo, 'diff', 'HEAD'],
      { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return null;
  }
}

function makeWorktree(patchFile) {
  const dir = mkdtempSync(path.join(tmpdir(), 'adverse-probe.'));
  const at = path.join(dir, 'tree');
  execFileSync('git', ['-C', repo, 'worktree', 'add', '--detach', at, head], { stdio: 'pipe' });
  if (patchFile) execFileSync('git', ['-C', at, 'apply', patchFile], { stdio: 'pipe' });
  return { dir, at };
}

function removeWorktree(wt) {
  try {
    execFileSync('git', ['-C', repo, 'worktree', 'remove', '--force', wt.at], { stdio: 'pipe' });
  } catch {
    // Best effort: the prune below reaps the registration either way, and a
    // teardown failure must not lose the results already collected.
  }
  try {
    rmSync(wt.dir, { recursive: true, force: true });
  } catch { /* the OS reaps the temp directory */ }
}

// Captured before any probe runs. Nothing here writes into `repo` — every
// probe runs in a worktree of its own — but the same rule gate.mjs follows
// costs nothing and does not depend on that staying true.
const worktree = worktreeDigest(repo);

const patch = runnable.length ? uncommittedPatch() : null;
const patchState = patch === null ? 'unreadable' : (patch.trim() ? 'applied' : 'none');

let patchFile = null;
if (patch && patch.trim()) {
  patchFile = path.join(mkdtempSync(path.join(tmpdir(), 'adverse-probe-patch.')), 'uncommitted.diff');
  writeFileSync(patchFile, patch, 'utf-8');
}

function runAll() {
  const results = [];
  for (const c of runnable) {
    let wt = null;
    try {
      wt = makeWorktree(patchFile);
    } catch (e) {
      results.push(declinedProbe(c, 'no clean checkout could be prepared to run it in'
        + ` (${String(e.message).trim().split('\n')[0]})`));
      continue;
    }
    try {
      results.push(runProbe(c, { cwd: wt.at, root: c.root, timeoutMs, sandbox }));
    } finally {
      removeWorktree(wt);
    }
  }
  try {
    execFileSync('git', ['-C', repo, 'worktree', 'prune'], { stdio: 'pipe' });
  } catch { /* nothing this run registered is left to prune */ }
  return results;
}

const measured = runnable.length ? runAll() : [];
const byClaim = new Map(runnable.map((c, i) => [c, measured[i] ?? declinedProbe(c, OFF)]));
const probes = claims.map((c) => byClaim.get(c) ?? c);

// ---------- write the record --------------------------------------------------

const record = {
  enabled,
  // Bound to the commit AND to the uncommitted state, the pair src/gate.mjs
  // binds a gate to and for the same reason: a run that reaches Phase 9 loops
  // back through this directory, and a probes.json left by an earlier
  // iteration must not go on confirming findings against a tree that moved.
  head,
  worktree,
  // What was actually applied, never what was intended. `network` says
  // `inherited` unless a sandbox was supplied, because that is the truth and
  // an operator reading this file is entitled to it.
  isolation: {
    worktree: 'detached, one per probe',
    uncommitted: patchState,
    timeoutMs,
    maxPerLane,
    sandbox: sandbox.length ? sandbox.join(' ') : null,
    network: sandbox.length ? 'delegated to the sandbox' : 'inherited',
  },
  probes,
};

try {
  writeFileSync(values.out, `${JSON.stringify(record, null, 2)}\n`, 'utf-8');
} catch (e) {
  // Exit 2, not 1: a run that could not write its record established nothing.
  process.stderr.write(`probe: ${values.out}: cannot be written (${e.message.trim()})\n`);
  process.exit(2);
}

const confirmed = probes.filter((p) => p.confirmed);
const contradicted = probes.filter((p) => p.source === 'measured' && !p.confirmed);
const declined = probes.filter((p) => p.source !== 'measured');

process.stdout.write(
  `probed ${probes.length} attached reproduction(s) from ${sources.length} payload(s)`
  + ` -> ${values.out}\n`
  + `  reproduced under re-run (buys \`demonstrated\`): ${confirmed.length}\n`
  + `  ran without reproducing (annotated, never disproved): ${contradicted.length}\n`
  + `  not run (declined, costs the finding nothing): ${declined.length}\n`
  + `  isolation: ${record.isolation.worktree}, uncommitted ${patchState},`
  + ` ${timeoutMs}ms timeout, network ${record.isolation.network}\n`);

for (const p of contradicted) {
  process.stderr.write(`probe: ${p.persona}: ${p.title}: ${p.why}\n`);
}
