#!/usr/bin/env node
// Skill bridge: combine N per-persona JSON files into a single keyed-by-persona
// JSON object that the synthesizer accepts.
//
// A duplicate persona across inputs is an error by default — it usually means
// the same file was passed twice. `--merge-personas` is the deliberate case: a
// lane split across two agents (a large diff, partitioned by file) produces two
// payloads under one persona name, and merging unions their findings. The
// worse verdict wins; two reviewers sharing one lane do not average out.

import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync } from 'node:fs';

const { values, positionals } = parseArgs({
  options: {
    round1: { type: 'string', multiple: true },
    round2: { type: 'string', multiple: true },
    out:    { type: 'string' },
    'merge-personas': { type: 'boolean' },
  },
  allowPositionals: true,
  strict: true,
});

// An unrecognized verdict ranks below `reject`, so garbage loses to any real
// verdict when it is the better one and wins as "worse" otherwise — off-contract
// input can only make the merged verdict more conservative, never less.
const VERDICT_RANK = { reject: 0, conditional: 1, approve: 2 };
const worseVerdict = (a, b) => ((VERDICT_RANK[a] ?? -1) <= (VERDICT_RANK[b] ?? -1) ? a : b);

if (!values.out) {
  process.stderr.write('Usage: combine.mjs (--round1 a.json b.json … [--merge-personas]) | (--round2 a.json b.json …) --out <combined.json>\n');
  process.exit(2);
}

const hasRound1 = values.round1 !== undefined;
const hasRound2 = values.round2 !== undefined;
if (hasRound1 === hasRound2) {
  process.stderr.write('combine: provide exactly one of --round1 or --round2\n');
  process.exit(2);
}
// A split lane exists only in round 1; round 2 spawns one agent per persona
// from the briefing. Round-2 payloads carry validates/challenges, not
// findings, so the union below would silently drop the second payload's work.
if (values['merge-personas'] && hasRound2) {
  process.stderr.write('combine: --merge-personas applies only to --round1\n');
  process.exit(2);
}

const inputs = [...(values.round1 ?? values.round2), ...positionals];

const combined = {};
for (const path of inputs) {
  let payload;
  try {
    payload = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (e) {
    process.stderr.write(`combine: ${path}: ${e.message}\n`);
    process.exit(1);
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || typeof payload.persona !== 'string') {
    process.stderr.write(`combine: ${path}: missing or invalid \`persona\` field\n`);
    process.exit(1);
  }
  const existing = combined[payload.persona];
  if (existing && !values['merge-personas']) {
    process.stderr.write(`combine: duplicate persona '${payload.persona}' across inputs`
      + ' (a deliberately split lane needs --merge-personas)\n');
    process.exit(1);
  }
  if (existing) {
    existing.findings = [
      ...(Array.isArray(existing.findings) ? existing.findings : []),
      ...(Array.isArray(payload.findings) ? payload.findings : []),
    ];
    existing.verdict = worseVerdict(existing.verdict, payload.verdict);
  } else {
    combined[payload.persona] = payload;
  }
}

writeFileSync(values.out, JSON.stringify(combined, null, 2), 'utf-8');
process.stdout.write(`combined ${inputs.length} reviews -> ${values.out}\n`);
