// Command-line entry point: `adverse review <target> [options]`.

import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { collectDirectory, collectDiff } from './collect.mjs';
import { refuseDirectRun } from './entryGuard.mjs';
import { PERSONAS, DEFAULT_PERSONAS, crossReviews } from './personas.mjs';
import {
  buildPhase1Prompt,
  buildPhase2Prompt,
  validatePhase1,
  validatePhase2,
} from './prompts.mjs';
import { AgentRunner, runParallel } from './runner.mjs';
import { agentNames, parsePlan, runLanes } from './scaling.mjs';
import { renderMarkdown, synthesize, toJsonReport } from './synthesis.mjs';

refuseDirectRun(import.meta.url);

const HELP = `Usage: adverse <command> [options]

Commands:
  review [target]   Run an adversarial review on a target.
  personas          List available personas and their lenses.
  synthesize        Read round-1/round-2 JSON from disk and emit a report.
                    Standalone use — the Claude Code Skill reaches the same
                    logic through skills/adverse-review/scripts/synthesize.mjs.
  help              Show this help.

Options for 'review':
  --agent <cmd>            Coding-agent CLI command. Prompt is sent over stdin.
                           Default: 'claude -p' (or $ADVERSE_AGENT).
                           Examples: 'codex exec --quiet', 'gemini',
                                     'ollama run llama3.1'.
  --personas <list>        Comma-separated personas (default: ${DEFAULT_PERSONAS.join(',')}).
  --diff [base]            Review a git diff. No value: uncommitted changes.
                           With base (e.g. 'main'): changes since branch fork.
  --out <path>             Write the markdown report to this path (default: stdout).
  --json-out <path>        Also write the structured synthesis JSON.
  --html-out <path>        Also write a self-contained HTML dashboard.
  --timeout <seconds>      Per-agent-call timeout (default: 600).
  --single-round           Skip the cross-review round (faster, less rigorous).
  --save-artifacts <dir>   Save raw per-persona JSON for debugging.
  --verbose, -v            Log subprocess events to stderr.

Options for 'synthesize':
  --round1 <path>          Path to a JSON file: { "<persona>": <round1Payload>, … }.
  --round2 <path>          Same shape, but with round-2 cross-reviews. Optional.
  --briefing <path>        triage.mjs's briefing.json. Its candidate root-cause
                           groups, plus round 2's rulings on them, become the
                           report's root-cause section. Optional.
  --out <path>             Markdown output path. Default: stdout.
  --json-out <path>        JSON synthesis output path.
  --html-out <path>        HTML dashboard output path.
  --skipped <persona=reason>  A lane deliberately not run (repeatable).
  --degraded <persona>     A lane that was tried and failed, not skipped (repeatable).
  --round2-skipped <reason>   Declare that round 2 did not run, and why.
  --plan <path>            plan.mjs's plan.json. Every lane it ran must be
                           accounted for by a payload, --skipped, or --degraded,
                           or synthesize refuses. Optional.

Exit codes:
  0  approve / conditional / hold
  1  reject verdict (CI gate)
  2  bad arguments
  3  fewer than 2 reviewers produced valid output

Environment:
  ADVERSE_AGENT     Default value for --agent.
`;

function die(msg, code = 2) {
  process.stderr.write(`adverse: ${msg}\n`);
  process.exit(code);
}

function logProgress(msg) {
  process.stderr.write(`${msg}\n`);
}

function resolvePersonas(spec) {
  const names = spec.split(',').map((n) => n.trim().toLowerCase()).filter(Boolean);
  const unknown = names.filter((n) => !(n in PERSONAS));
  if (unknown.length) {
    die(
      `unknown persona(s): ${JSON.stringify(unknown)}. Available: ${Object.keys(PERSONAS).join(', ')}.\n` +
        `Tip: pass --personas ${Object.keys(PERSONAS).join(',')} to use all of them.`,
    );
  }
  if (names.length < 2) {
    die('at least 2 personas are required for adversarial review.');
  }
  return names;
}

function saveArtifact(dir, name, payload) {
  mkdirSync(dir, { recursive: true });
  const target = path.join(dir, name);
  if (typeof payload === 'string') {
    writeFileSync(target, payload, 'utf-8');
  } else {
    writeFileSync(target, JSON.stringify(payload, null, 2), 'utf-8');
  }
}

async function cmdReview(rest) {
  const { values, positionals } = parseArgs({
    args: rest,
    options: {
      agent:           { type: 'string' },
      personas:        { type: 'string' },
      diff:            { type: 'string' },
      out:             { type: 'string', short: 'o' },
      'json-out':      { type: 'string' },
      'html-out':      { type: 'string' },
      timeout:         { type: 'string' },
      'single-round':  { type: 'boolean' },
      'save-artifacts': { type: 'string' },
      verbose:         { type: 'boolean', short: 'v' },
      help:            { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
    strict: true,
  });

  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }

  const target = path.resolve(positionals[0] ?? '.');
  const agentCmd = values.agent ?? process.env.ADVERSE_AGENT ?? 'claude -p';
  const personaNames = resolvePersonas(values.personas ?? DEFAULT_PERSONAS.join(','));
  const personas = personaNames.map((n) => PERSONAS[n]);
  const timeoutMs = (parseInt(values.timeout ?? '600', 10) || 600) * 1000;
  const verbose = !!values.verbose;
  const artifactsDir = values['save-artifacts'] ? path.resolve(values['save-artifacts']) : null;

  // 1. Source collection
  logProgress('⏳ collecting source...');
  let block, files;
  try {
    if (values.diff !== undefined) {
      const base = values.diff === '' ? null : values.diff;
      const dir = await import('node:fs').then((fs) => (fs.statSync(target).isDirectory() ? target : path.dirname(target)));
      ({ block, files } = collectDiff(dir, base));
      logProgress(`   diff vs ${base ?? 'HEAD'} (${files.length} files)`);
    } else {
      const fs = await import('node:fs');
      if (!fs.existsSync(target)) die(`no such path: ${target}`, 2);
      if (!fs.statSync(target).isDirectory()) {
        die(`target must be a directory (or use --diff): ${target}`, 2);
      }
      ({ block, files } = collectDirectory(target));
      logProgress(`   ${files.length} files in ${target}`);
    }
  } catch (e) {
    die(e.message, 2);
  }

  if (artifactsDir) {
    saveArtifact(artifactsDir, 'source.txt', block);
    saveArtifact(artifactsDir, 'scope.json', { target, files });
  }

  const runner = AgentRunner.fromString(agentCmd, { timeoutMs, verbose });

  // 2. Phase 1
  logProgress(`⏳ round 1: ${personas.length} reviewers in parallel...`);
  const phase1Jobs = personas.map((p) => ({
    persona: p.name,
    phase: 'round1',
    prompt: buildPhase1Prompt(p, block),
    validate: (obj) => validatePhase1(obj, p.name),
  }));
  const phase1 = await runParallel(runner, phase1Jobs);

  const round1 = {};
  const failed = [];
  for (const r of phase1) {
    if (artifactsDir) {
      saveArtifact(artifactsDir, `round1_${r.persona}.stdout.txt`, r.rawStdout);
      if (r.parsed) saveArtifact(artifactsDir, `round1_${r.persona}.json`, r.parsed);
    }
    if (r.error || !r.parsed || typeof r.parsed !== 'object') {
      logProgress(`   ✗ ${r.persona}: ${r.error ?? 'no parsed output'}`);
      failed.push(r.persona);
      continue;
    }
    round1[r.persona] = r.parsed;
    const tag = r.retried ? ' (retried)' : '';
    logProgress(
      `   ✓ ${r.persona}: ${(r.parsed.findings ?? []).length} findings, ` +
        `${r.parsed.verdict ?? '?'}${tag} (${(r.durationMs / 1000).toFixed(1)}s)`,
    );
  }

  if (Object.keys(round1).length < 2) {
    die(`round 1 produced fewer than 2 valid reviews (failed: ${failed.join(', ')}). ` +
        `Cannot synthesize. Re-run with --verbose for details.`, 3);
  }

  // 3. Phase 2 (cross-review)
  const round2 = {};
  if (!values['single-round'] && Object.keys(round1).length >= 2) {
    logProgress(`⏳ round 2: ${Object.keys(round1).length} reviewers cross-examining...`);
    // A lane whose every kind is advisory has no blocking claim to validate or
    // challenge, so spawning it in round 2 buys nothing and its `challenge`
    // entries are applied by synthesis like anyone else's — one challenger
    // relabels a finding `disputed` however many personas reported it. The
    // Skill bridge refuses such a payload; this path was producing one itself
    // on every run.
    const phase2Jobs = Object.keys(round1).filter((name) => crossReviews(name, 2)).map((name) => ({
      persona: name,
      phase: 'round2',
      prompt: buildPhase2Prompt(PERSONAS[name], block, round1),
      validate: (obj) => validatePhase2(obj, name),
    }));
    const phase2 = await runParallel(runner, phase2Jobs);
    for (const r of phase2) {
      if (artifactsDir) {
        saveArtifact(artifactsDir, `round2_${r.persona}.stdout.txt`, r.rawStdout);
        if (r.parsed) saveArtifact(artifactsDir, `round2_${r.persona}.json`, r.parsed);
      }
      if (r.error || !r.parsed || typeof r.parsed !== 'object') {
        logProgress(`   ✗ ${r.persona}: ${r.error ?? 'no parsed output'} (continuing without their cross-review)`);
        continue;
      }
      round2[r.persona] = r.parsed;
      const v = (r.parsed.validate ?? []).length;
      const c = (r.parsed.challenge ?? []).length;
      const a = (r.parsed.added ?? []).length;
      const tag = r.retried ? ' (retried)' : '';
      logProgress(
        `   ✓ ${r.persona}: ${v} validated, ${c} challenged, ${a} added${tag} ` +
          `(${(r.durationMs / 1000).toFixed(1)}s)`,
      );
    }
  }

  // 4. Synthesize and render
  logProgress('⏳ synthesizing...');
  const syn = synthesize(round1, round2, { failedPersonas: failed });
  const md = renderMarkdown(syn);

  if (values.out) {
    writeFileSync(values.out, md, 'utf-8');
    logProgress(`✅ report written to ${values.out}`);
  } else {
    process.stdout.write(md);
  }

  if (values['json-out']) {
    writeFileSync(values['json-out'], JSON.stringify(toJsonReport(syn), null, 2), 'utf-8');
    logProgress(`✅ json written to ${values['json-out']}`);
  }
  if (values['html-out']) {
    const { renderHtml } = await import('./html.mjs');
    writeFileSync(values['html-out'], renderHtml(syn), 'utf-8');
    logProgress(`✅ html written to ${values['html-out']}`);
  }

  return syn.consensusLabel.startsWith('BLOCK') ? 1 : 0;
}

function readJsonArg(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf-8'));
  } catch (e) {
    die(`synthesize: ${file}: ${e.message}`);
  }
}

async function cmdSynthesize(rest) {
  const { values } = parseArgs({
    args: rest,
    options: {
      round1:     { type: 'string' },
      round2:     { type: 'string' },
      briefing:   { type: 'string' },
      out:        { type: 'string' },
      'json-out': { type: 'string' },
      'html-out': { type: 'string' },
      skipped:    { type: 'string', multiple: true },
      degraded:   { type: 'string', multiple: true },
      'round2-skipped': { type: 'string' },
      plan:       { type: 'string' },
      help:       { type: 'boolean', short: 'h' },
    },
    strict: true,
  });
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (!values.round1) die('synthesize: --round1 is required');
  const round1 = readJsonArg(values.round1);
  const round2 = values.round2 ? readJsonArg(values.round2) : {};

  // The same rule src/roster.mjs applies in the Skill bridge. It lived only
  // there, so the shipped binary still accepted a round-2 payload from a lane
  // that never cross-reviews — and a single such `challenge` moves a critical
  // reported by two lanes out of `Open blocking`. Two paths, one rule.
  for (const persona of Object.keys(round2)) {
    if (!crossReviews(persona, 2)) {
      die(`synthesize: ${values.round2}: '${persona}' does not cross-review: every kind it`
        + ` owns is advisory, so it has no blocking claim to validate or challenge.`
        + ` A round-2 payload under its name is a stale round-1 file or a spoof.`);
    }
  }

  // The candidate root causes triage proposed. Optional: without it the report
  // is exactly what it was before grouping existed, one section per finding —
  // which is also what a run whose briefing proposed nothing produces.
  const briefing = values.briefing ? readJsonArg(values.briefing) : null;
  if (briefing && !Array.isArray(briefing.groups)) {
    die(`synthesize: ${values.briefing}: not a briefing.json (no \`groups\` array)`);
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
  const failedPersonas = (values.degraded ?? []).map((spec) => spec.split('=')[0]);

  // --plan closes the gap between the run the plan describes and the run the
  // payloads prove: a planned lane with no payload reviewed nothing, and
  // "reviewed and found nothing" is the same input downstream as "never
  // looked". The set subtraction is arithmetic the orchestrator was trusted to
  // do by hand through --skipped/--degraded; with the plan on disk it is
  // checked instead.
  if (values.plan) {
    let planned;
    try {
      planned = runLanes(parsePlan(readJsonArg(values.plan)).lanes);
    } catch (e) {
      die(`synthesize: --plan ${values.plan}: ${e.message}`);
    }
    const accounted = new Set([
      ...Object.keys(round1),
      ...skippedPersonas.map((s) => s.persona),
      ...failedPersonas,
    ]);
    // A split lane is accounted under either spelling: combine.mjs unions its
    // halves under the bare persona, while raw per-agent payloads and the
    // --skipped/--degraded flags speak agentNames' persona-a/-b. Requiring one
    // spelling false-refuses the other's fully reported lane.
    const unaccounted = planned.flatMap((lane) => {
      if (accounted.has(lane.persona)) return [];
      return agentNames([lane]).filter((name) => !accounted.has(name));
    });
    if (unaccounted.length) {
      die(`synthesize: the plan ran ${unaccounted.join(', ')} but no payload, --skipped, or`
        + ' --degraded accounts for it — a lane that failed did not find nothing, it did not'
        + ' look');
    }
  }

  // An EMPTY --round2-skipped value is a silent undeclared skip wearing a
  // declaration's clothes (an unset shell var expands to ""), so it is a
  // usage error, not a no-op.
  if (values['round2-skipped'] !== undefined && values['round2-skipped'].trim() === '') {
    die('synthesize: --round2-skipped requires a non-empty reason');
  }

  const syn = synthesize(round1, round2, {
    skippedPersonas, failedPersonas, round2Skipped: values['round2-skipped'] ?? null,
    rootCauseGroups: briefing?.groups ?? [],
  });
  const md = renderMarkdown(syn);

  if (values.out) writeFileSync(values.out, md, 'utf-8');
  else process.stdout.write(md);

  if (values['json-out']) writeFileSync(values['json-out'], JSON.stringify(toJsonReport(syn), null, 2), 'utf-8');
  if (values['html-out']) {
    const { renderHtml } = await import('./html.mjs');
    writeFileSync(values['html-out'], renderHtml(syn), 'utf-8');
  }

  logProgress(`✅ verdict: ${syn.consensusLabel} · ${syn.findings.length} findings`);
  return syn.consensusLabel.startsWith('BLOCK') ? 1 : 0;
}

function cmdPersonas() {
  for (const p of Object.values(PERSONAS)) {
    process.stdout.write(`${p.name.padEnd(12)}  ${p.title.padEnd(12)}  ${p.lens}\n`);
  }
  return 0;
}

export async function main(argv = process.argv.slice(2)) {
  const cmd = argv[0];
  const rest = argv.slice(1);
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    process.stdout.write(HELP);
    return cmd ? 0 : 2;
  }
  try {
    if (cmd === 'review') return await cmdReview(rest);
    if (cmd === 'synthesize') return await cmdSynthesize(rest);
    if (cmd === 'personas') return cmdPersonas();
  } catch (e) {
    if (typeof e.code === 'string' && e.code.startsWith('ERR_PARSE_ARGS')) {
      die(`${cmd}: ${e.message.split('\n')[0]}\n\n${HELP}`);
    }
    die(e.message ?? String(e));
  }
  die(`unknown command: ${cmd}\n\n${HELP}`);
}
