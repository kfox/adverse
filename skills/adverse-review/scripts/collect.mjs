#!/usr/bin/env node
// Skill bridge: collect source code into a single text block + file list.
// The same logic powers the standalone CLI (`adverse review`).

import path from 'node:path';

import { parseBridgeArgs, usage, writeOutput } from './bridge-io.mjs';
import { importFromSrc } from './package-root.mjs';

const { collectDirectory, collectDiff } = await importFromSrc('collect.mjs');

const USAGE = 'Usage: collect.mjs --target <path> [--diff [base]] --out <file> [--files-out <file>]';

const { values } = parseBridgeArgs({
  prefix: 'collect',
  usage: USAGE,
  options: {
    target:      { type: 'string' },
    diff:        { type: 'string' },
    out:         { type: 'string' },
    'files-out': { type: 'string' },
  },
  strict: true,
});

if (!values.target || !values.out) {
  usage(USAGE);
}

const target = path.resolve(values.target);
try {
  let block, files;
  if (values.diff !== undefined) {
    const base = values.diff === '' ? null : values.diff;
    ({ block, files } = collectDiff(target, base));
  } else {
    ({ block, files } = collectDirectory(target));
  }
  writeOutput('collect', values.out, block);
  if (values['files-out']) {
    writeOutput('collect', values['files-out'], JSON.stringify(files, null, 2));
  }
  process.stdout.write(`collected ${files.length} files (${block.length} chars) -> ${values.out}\n`);
} catch (e) {
  process.stderr.write(`collect: ${e.message}\n`);
  process.exit(1);
}
