#!/usr/bin/env node
// Skill bridge: collect source code into a single text block + file list.
// The same logic powers the standalone CLI (`adverse review`).

import path from 'node:path';

import { makeWriteQueue, parseBridgeArgs, usage } from './bridge-io.mjs';
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
  // Two outputs, so the queue rather than two single writes. `--out` and
  // `--files-out` are a pair — a source block and the list of what is in it —
  // and the caller supplies both paths independently, so nothing stops them
  // naming one file. Written one after the other, that silently left the file
  // list where the block was promised; queued, the second claim on a
  // destination is refused before the first byte is written.
  const out = makeWriteQueue('collect');
  out.queue(values.out, 'source block', block);
  if (values['files-out']) {
    out.queue(values['files-out'], 'file list', JSON.stringify(files, null, 2));
  }
  out.flush('collected');
  process.stdout.write(`collected ${files.length} files (${block.length} chars)\n`);
} catch (e) {
  process.stderr.write(`collect: ${e.message}\n`);
  process.exit(1);
}
