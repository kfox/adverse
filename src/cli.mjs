// Command-line entry point: `adverse review <target> [options]`.

import { parseArgs } from 'node:util';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { collectDirectory, collectDiff } from './collect.mjs';
import { PERSONAS, DEFAULT_PERSONAS } from './personas.mjs';
import {
  buildPhase1Prompt,
  buildPhase2Prompt,
  validatePhase1,
  validatePhase2,
} from './prompts.mjs';
import { AgentRunner, runParallel } from './runner.mjs';
import { renderMarkdown, synthesize, toJsonReport } from './synthesis.mjs';

const HELP = `Usage: adverse <command> [options]

Commands:
  review [target]   Run an adversarial review on a target.
  personas          List available personas and their lenses.
  synthesize        Read round-1/round-2 JSON from disk and emit a report.
                    (Used by the Claude Code Skill; see skills/adverse-review.)
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
  --out <path>             Markdown output path. Default: stdout.
  --json-out <path>        JSON synthesis output path.
  --html-out <path>        HTML dashboard output path.

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
    },
    allowPositionals: true,
    strict: true,
  });

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
    const phase2Jobs = Object.keys(round1).map((name) => ({
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

async function cmdSynthesize(rest) {
  const { values } = parseArgs({
    args: rest,
    options: {
      round1:     { type: 'string' },
      round2:     { type: 'string' },
      out:        { type: 'string' },
      'json-out': { type: 'string' },
      'html-out': { type: 'string' },
    },
    strict: true,
  });
  if (!values.round1) die('synthesize: --round1 is required');
  const fs = await import('node:fs');
  const round1 = JSON.parse(fs.readFileSync(values.round1, 'utf-8'));
  const round2 = values.round2 ? JSON.parse(fs.readFileSync(values.round2, 'utf-8')) : {};
  const syn = synthesize(round1, round2);
  const md = renderMarkdown(syn);

  if (values.out) writeFileSync(values.out, md, 'utf-8');
  else process.stdout.write(md);

  if (values['json-out']) writeFileSync(values['json-out'], JSON.stringify(toJsonReport(syn), null, 2), 'utf-8');
  if (values['html-out']) {
    const { renderHtml } = await import('./html.mjs');
    writeFileSync(values['html-out'], renderHtml(syn), 'utf-8');
  }
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
    die(e.message ?? String(e));
  }
  die(`unknown command: ${cmd}\n\n${HELP}`);
}
