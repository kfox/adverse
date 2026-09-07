#!/usr/bin/env node
// Skill bridge: the regression pass over one fix commit (Phase 9).
//
// Two modes, because the pass has exactly two deterministic decisions and a
// model must make neither of them:
//
//   --commit <rev>     WHO runs it. src/regression.mjs picks the lane from the
//                      commit's own files and diff and from `--closed-by`, the
//                      personas that reported the findings this commit closed.
//                      The orchestrator is the agent that just fixed the code;
//                      letting it choose its own reviewer is the one selection
//                      an interested party must not make.
//   --payload <file>   WHAT it found. Validates the pass's JSON and reshapes it
//                      into the round-1 shape triage.mjs already reads, the way
//                      verify.mjs reshapes a verification.
//
// The reshape stamps `provenance: "regression"` on every finding it emits.
// Synthesis reads that off the entry (src/synthesis.mjs) and both renderers
// print it, because "the fix introduced this" is a different fact from "round 2
// noticed this" and an operator working a ranked list cannot act on the first
// without knowing which it is.
//
// The verdict is DERIVED, never judged. This pass casts no vote on the change —
// it answers one question about one commit — but every downstream consumer
// reads a verdict, so the field is computed the same way verify.mjs computes
// it: a pass that found something cannot read as an approval, and a pass that
// found nothing cannot read as a rejection.
//
// The output filename ends `.regression.json`, not `.verified.json`, so a lane
// that both verified its own findings and read someone else's fix commit
// produces two files instead of silently overwriting one. Both are round-1
// shaped; pass both to triage.mjs, and `--merge-personas <persona>` when the
// same lane wrote both.
//
// Fold the whole iteration in one call, the way decisions.mjs takes every fix
// payload at once. The fold is per lane, so a second invocation into the same
// outdir rewrites that lane's file with only the passes it was given.
//
// That rewrite is where a Phase 9 LOOP goes wrong, and it is checked now rather
// than described. Pass files are numbered from 1 each iteration and the loop
// reuses $ADVERSE_RUN, so iteration 2 overwrites `regression-auditor-1.json`
// and leaves `-2` and `-3` sitting there for its glob to pick up. Measured on
// the unguarded fold: three passes folded in iteration 1, only pass 1 rewritten
// for iteration 2, and the second fold printed `3 pass(es) from 1 lane(s)` and
// signed `regression pass on ddddddd, bbbbbb2, cccccc3` — two commits from the
// previous iteration presented as this one's evidence. So a source naming a
// commit this outdir already folded is refused (`staleSources`), and `--refold`
// is how a deliberate re-read of the same commit says so.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { readJson, requireKnownPersona, usage } from './bridge-io.mjs';
import { importFromSrc } from './package-root.mjs';

const { chooseRegressionLane, unresolvedLanes } = await importFromSrc('regression.mjs');
const { validateRegression } = await importFromSrc('prompts.mjs');
const { DEFAULT_PERSONAS } = await importFromSrc('personas.mjs');
const { stampedFieldClaim } = await importFromSrc('synthesis.mjs');
const { PROVENANCE } = await importFromSrc('taxonomy.mjs');

// Positionals are payloads, so `--payload run/regression-*.json` works — the
// same reason triage.mjs and verify.mjs accept them: strict parsing without
// this throws on the second path the shell expands, and the glob is the obvious
// thing to type.
const { values, positionals } = parseArgs({
  options: {
    repo:             { type: 'string' },
    commit:           { type: 'string' },
    'closed-by':      { type: 'string', multiple: true },
    'closed-by-none': { type: 'boolean' },
    payload:          { type: 'string', multiple: true },
    outdir:           { type: 'string' },
    refold:           { type: 'boolean' },
    json:             { type: 'boolean' },
  },
  strict: true,
  allowPositionals: true,
});

const USAGE = 'Usage: regression.mjs --repo <dir> --commit <rev>'
  + ' (--closed-by <persona>… | --closed-by-none) [--json]\n'
  + '       regression.mjs --payload a.json [--payload b.json …] --outdir <dir> [--refold]';

const payloads = [...(values.payload ?? []), ...positionals];

if (payloads.length) {
  if (!values.outdir) usage(USAGE);
  foldPayloads(payloads, values.outdir);
} else if (values.commit) {
  chooseLane(values.repo ?? '.', values.commit,
    values['closed-by'] ?? [], values['closed-by-none'] === true);
} else {
  usage(USAGE);
}

// --- who runs it -------------------------------------------------------------

// Same guard triage.mjs and plan.mjs apply to `--base`: a revision in git's
// option position becomes a git option, and one that opens a file for writing
// is a file this bridge truncates on the orchestrator's behalf.
function requireRevision(rev) {
  if (rev.startsWith('-')) {
    process.stderr.write(`regression: --commit ${JSON.stringify(rev)} looks like an option,`
      + ' not a revision\n');
    process.exit(2);
  }
  return rev;
}

// An unreadable commit is not an empty one. Returning `[]`/`''` here would hand
// assessScope the shape it reads as "nothing to assess", which recommends
// running the Adversary — the same fail-toward-the-boundary direction the rest
// of this tool takes, and the reason the failure is reported rather than fatal.
// `--end-of-options` is the argv-side half of src/trace.mjs's rule: "two
// independent guards, because either alone is one flag away from being
// bypassed". `requireRevision` is the pattern half and runs first, so nothing
// here is reachable today — which is the point. A revision that stops looking
// like an option to the pattern (a future spelling, a caller that skips the
// guard) still cannot become one to git.
function readCommit(repo, rev) {
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf-8' });
  try {
    return {
      files: git('show', '--pretty=format:', '--name-only', '--end-of-options', rev)
        .split('\n').filter(Boolean),
      diff: git('show', '--format=', '--end-of-options', rev),
    };
  } catch (e) {
    process.stderr.write(`  ! regression: cannot read ${rev} in ${repo}: ${e.message.trim()}\n`
      + '    choosing the lane from an unread diff, which fails toward the Adversary\n');
    process.exitCode = 1;
    return { files: [], diff: '' };
  }
}

// The registry check `readPayload` makes on a payload's persona forty lines
// below, applied to the one input a CALLER supplies. `chooseRegressionLane`
// resolved each name and dropped what it could not read — tolerable for the
// library, fail-open here, because the caller is the orchestrator that just
// fixed the code and the whole point of this bridge is that it does not get to
// pick its own reviewer.
//
// Three different rejects, all reachable and all measured:
//
//   --closed-by Auditor     one capital from the registry's spelling; excluded
//                           nobody, exited 0, printed "auditor: … and it
//                           reported none of the findings this commit closed"
//                           over the reporting lane reviewing its own fix.
//   --closed-by auditor-ab  names the auditor lane but is not a half
//                           `agentNames` emits. A concurrent commit tightened
//                           that suffix from /^[a-z]+$/ to /^[a-z]$/ and
//                           silently flipped this one from choosing steward to
//                           choosing auditor.
//
// Refused by value rather than repaired, exactly as `requireKnownPersona`
// refuses a re-cased persona: a name this bridge has to guess at is a name the
// orchestrator should retype. `chooseRegressionLane` still excludes generously
// if this guard is ever bypassed, so neither layer is the only one.
//
// Exit 2, not 1, per bridge-io.mjs's contract — exit 1 is a claim about a
// review, and this run never got as far as choosing who would do one.
//
// The third reject is the one the first two hid: NO exclusion input at all.
// Both arms above were closed while the plain omission kept exiting 0 —
// `regression.mjs --repo . --commit HEAD` printed "auditor: … and it reported
// none of the findings this commit closed" with nothing excluded, a clean
// artifact asserting a disinterest nobody checked, which is the same fail-open
// as `--closed-by Auditor` reached by typing less rather than by typing
// something wrong.
//
// So the flag is REQUIRED, and `--closed-by-none` is the only way to run the
// pass with nothing excluded: it makes "this commit closes no reported finding"
// a claim the caller signs rather than a silence the tool fills in. The two
// cannot be combined — a commit either closes findings some lane reported or it
// does not, and a caller that says both has not decided which.
//
// src/regression.mjs throws on the same three inputs, so neither layer is the
// only one; this one exists to turn them into exit 2 and a sentence instead of
// a stack trace.
function requireExclusionArgs(closedBy, closesNothing) {
  if (closesNothing && closedBy.length) {
    process.stderr.write('regression: --closed-by-none contradicts the'
      + ` ${closedBy.length} --closed-by name(s) given; pass one or the other\n`);
    process.exit(2);
  }
  if (!closesNothing && !closedBy.length) {
    process.stderr.write('regression: --closed-by is required: name every persona that reported'
      + ' a finding this commit closed, so the pass can go to a lane that did not.\n'
      + '    If this commit closes no reported finding, say so with --closed-by-none —'
      + ' omitting the flag would have this pass claim a disinterest nothing checked.\n');
    process.exit(2);
  }

  const unresolved = unresolvedLanes(closedBy);
  if (!unresolved.length) return closedBy;

  process.stderr.write('regression: --closed-by '
    + `${unresolved.map((n) => JSON.stringify(n)).join(', ')} names no agent id this`
    + ` review produces (expected one of ${DEFAULT_PERSONAS.join(', ')}, lowercase,`
    + " or a split lane's half like auditor-a)\n");
  process.exit(2);
}

function chooseLane(repo, rev, closedBy, closesNothing) {
  const commit = requireRevision(rev);
  requireExclusionArgs(closedBy, closesNothing);
  const { files, diff } = readCommit(repo, commit);
  const choice = chooseRegressionLane({ closedBy, files, diff, closesNothing });

  if (values.json) {
    process.stdout.write(`${JSON.stringify({ ...choice, commit: rev }, null, 2)}\n`);
    return;
  }
  process.stdout.write(`regression lane for ${rev}: ${choice.persona}\n`
    + `  ${choice.reason}\n`);
  // Printed as its own line, not folded into the reason: a pass run by a lane
  // that had already reported into the commit is the one result an operator has
  // to read differently, and a caveat inside a sentence is a caveat that gets
  // skimmed.
  if (choice.conflicted) {
    process.stdout.write('  CONFLICTED: this lane reported a finding this commit closed.'
      + ' Its silence is worth less than another lane\'s.\n');
  }
}

// --- what it found -----------------------------------------------------------

function readPayload(src) {
  const payload = readJson(src, 'regression');

  // Same registry check the other lane-scoped bridges make at their earliest
  // reader: the persona keys the output filename and, downstream, triage's
  // roster — an invented or re-cased name mints a phantom reviewer.
  requireKnownPersona(payload?.persona,
    { prefix: 'regression', file: src, personas: DEFAULT_PERSONAS });

  // The stamp this bridge is about to apply, refused on the way in: a pass
  // payload that pre-stamps its own findings `provenance: "regression"` is
  // claiming this bridge's authority, and the one field a payload must not
  // write is the one that says which program wrote it. Same check validate.mjs
  // makes at the earliest reader of every other agent-written payload.
  const err = stampedFieldClaim(payload) ?? validateRegression(payload, payload.persona);
  if (err) {
    process.stderr.write(`regression: ${src}: ${err}\n`);
    process.exit(1);
  }
  return payload;
}

// The staleness check the header describes. A pass file is per fix COMMIT, so
// the commit is the only thing in a payload that can say whether this outdir
// has folded it before — the path cannot (iteration 2 reuses `-1`), and the
// mtime cannot (a leftover is not touched). Keyed on the commit alone rather
// than on the whole pass record, so a leftover that a later iteration reformats
// or re-answers is still recognized as a leftover.
//
// An unreadable or unparsable lane file is refused too, and that is the same
// choice made twice: a fold that cannot tell what this outdir already holds
// cannot claim its output is one iteration's evidence.
function foldedCommits(dest) {
  if (!existsSync(dest)) return new Set();
  try {
    const prior = JSON.parse(readFileSync(dest, 'utf-8'));
    return new Set((prior?.passes ?? []).map((pass) => pass?.commit));
  } catch (e) {
    process.stderr.write(`regression: ${dest} exists but cannot be read as an earlier fold`
      + ` (${e.message.trim()}), so this fold cannot tell which passes it would re-sign\n`);
    process.exit(2);
  }
}

function staleSources(byPersona, outdir) {
  const stale = [];
  for (const [persona, lane] of byPersona) {
    const folded = foldedCommits(`${outdir}/round1-${persona}.regression.json`);
    lane.passes.forEach((pass, i) => {
      if (folded.has(pass.commit)) stale.push(`${lane.sources[i]} (${pass.commit})`);
    });
  }
  return stale;
}

// One file per LANE, not one per pass. An iteration lands several fix commits
// and each gets its own pass, so one lane routinely runs more than one — and a
// file per pass would either collide on the name or arrive at triage as a lane
// claiming three payloads, which `checkRoster` refuses (a split lane is exactly
// two). Unioning here keeps the pass per commit, which is the doctrine, without
// inventing a lane per commit, which is not.
//
// A Map, not an object literal: the key is a persona, and although
// `requireKnownPersona` has already refused anything outside the registry,
// nothing downstream should have to know that to be safe.
function foldPayloads(sources, outdir) {
  const byPersona = new Map();
  for (const src of sources) {
    const payload = readPayload(src);
    const lane = byPersona.get(payload.persona)
      ?? { findings: [], passes: [], sources: [] };
    // The stamp goes on the ENTRY, because that is what survives every merge
    // downstream: mergeSplitReviews unions two payloads' finding lists under a
    // single header, so a marker living only on the header is a marker the
    // merge drops. The header carries it too, for whoever reads this file.
    lane.findings.push(
      ...payload.added.map((f) => ({ ...f, provenance: PROVENANCE.regression })));
    // The four answers ride along, unread by anything downstream, exactly as
    // verify.mjs carries `verified`: "silence is a claim" is only inspectable
    // if what the pass says it checked survives the reshape.
    lane.passes.push({ commit: payload.commit, checked: payload.checked });
    lane.sources.push(src);
    byPersona.set(payload.persona, lane);
  }

  // Before anything is written, and for EVERY lane: a fold that refuses one
  // lane's stale pass after overwriting another lane's file has already
  // published half of what it refused.
  const stale = staleSources(byPersona, outdir);
  if (stale.length && !values.refold) {
    process.stderr.write(`regression: ${stale.join(', ')} name commits this outdir has already`
      + ' folded.\n    Pass numbering restarts each iteration, so these are an earlier'
      + " iteration's leftovers, and folding them again re-signs them as this iteration's"
      + ' evidence.\n    Delete them, fold into a fresh --outdir, or pass --refold if you'
      + ' meant to re-read those commits.\n');
    process.exit(2);
  }

  let findings = 0;
  for (const [persona, lane] of byPersona) {
    const commits = lane.passes.map((p) => p.commit).join(', ');
    const out = {
      persona,
      // Derived, never judged — see the header. `conditional` and `approve` are
      // the only two reachable, the same pair verify.mjs derives when nothing
      // it verified is still open.
      verdict: lane.findings.length ? 'conditional' : 'approve',
      summary: `regression pass on ${commits}: ${lane.findings.length} finding(s)`,
      provenance: PROVENANCE.regression,
      findings: lane.findings,
      passes: lane.passes,
    };
    const dest = `${outdir}/round1-${persona}.regression.json`;
    writeFileSync(dest, JSON.stringify(out, null, 2), 'utf-8');
    findings += lane.findings.length;
    process.stdout.write(`regression ${lane.sources.join(' + ')} -> ${dest}\n`);
  }

  // "found by", not "introduced by": a regression entry is classified
  // `intended-inert`, `intended-undocumented` or `unintended`, and only the
  // last was introduced in the sense a reader takes from that word. Same
  // correction src/html.mjs's REGRESSION_NOTE already carries; this line and
  // the report cell are the two an operator reads, so they make one claim.
  process.stdout.write(`${sources.length} pass(es) from ${byPersona.size} lane(s):`
    + ` ${findings} finding(s), stamped so the report can say a fix commit's regression`
    + ' pass found them\n');
}
