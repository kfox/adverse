#!/usr/bin/env node
// Skill bridge: should the Adversary lane run for this change?
//
// Exit 0 = run it, 1 = it has nothing to look at. Read the reason before
// acting on the exit code, and say out loud when you skip a lane.

import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { importFromSrc } from './package-root.mjs';

const { assessScope } = await importFromSrc('scope.mjs');

const { values } = parseArgs({
  options: {
    repo:  { type: 'string' },
    base:  { type: 'string' },
    files: { type: 'string' },
    json:  { type: 'boolean' },
  },
  strict: true,
});

const repo = values.repo ?? process.cwd();
const base = values.base ?? 'main';

let files, diff;
try {
  files = values.files
    ? readFileSync(values.files, 'utf-8').split('\n').filter(Boolean)
    : execFileSync('git', ['diff', '--name-only', `${base}...HEAD`],
                   { cwd: repo, encoding: 'utf-8' }).split('\n').filter(Boolean);
  diff = execFileSync('git', ['diff', `${base}...HEAD`],
                      { cwd: repo, encoding: 'utf-8', maxBuffer: 256 * 1024 * 1024 });
} catch (e) {
  // Unreadable is not the same as clean. Fail toward running the lane.
  process.stdout.write(`adversary: run (could not read the diff: ${e.message})\n`);
  process.exit(0);
}

const result = assessScope({ files, diff });

if (values.json) {
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} else {
  process.stdout.write(`adversary: ${result.recommend} — ${result.reason}\n`);
  for (const e of result.evidence.slice(0, 8)) {
    process.stdout.write(e.kind === 'path'
      ? `  path    ${e.file} (matched "${e.signal}")\n`
      : `  content /${e.signal}/ — ${e.sample}\n`);
  }
  if (result.evidence.length > 8) {
    process.stdout.write(`  … and ${result.evidence.length - 8} more\n`);
  }
}

process.exit(result.recommend === 'run' ? 0 : 1);
