#!/usr/bin/env node
// Like fake-agent.mjs but the adversary always emits unrecoverable garbage
// to test graceful degradation in the CLI.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

let prompt = '';
process.stdin.on('data', (b) => prompt += b);
process.stdin.on('end', () => {
  if (prompt.includes('You are the **Adversary**')) {
    process.stdout.write('not even close to JSON, sorry');
    return;
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  const r = spawnSync('node', [path.join(here, 'fake-agent.mjs')], { input: prompt, encoding: 'utf-8' });
  process.stdout.write(r.stdout);
});
