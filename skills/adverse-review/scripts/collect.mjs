#!/usr/bin/env node
// Skill bridge: collect source code into a single text block + file list.
// The same logic powers the standalone CLI (`adverse review`).

import path from 'node:path';

import { makeWriteQueue, oneLine, parseBridgeArgs, usage } from './bridge-io.mjs';
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

// Two output flags, taken from argv independently, and nothing about them says
// they name different files. `--out d/both.json --files-out d/./both.json` wrote
// the source block and then replaced it with the file list, at exit 0, leaving a
// file list where a source block was promised. An argv contradiction, answered
// where every other one is: before any work is done, and as a usage error.
if (values['files-out']
  && path.resolve(values['files-out']) === path.resolve(values.out)) {
  // Both spellings and the path they resolve to, because the operator typed two
  // different strings and naming one of them shows the spelling that is not
  // wrong. `d/both.json` alone, from `--files-out d/./both.json`, reads as a
  // refusal of the flag that was fine.
  usage(`collect: --out and --files-out name one file:\n`
    + `  --out       ${oneLine(values.out)}\n`
    + `  --files-out ${oneLine(values['files-out'])}\n`
    + `  both resolve to ${oneLine(path.resolve(values.out))}\n${USAGE}`);
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
  // The queue rather than two single writes: these two outputs are a pair — a
  // source block and the list of what is in it — so a failure on the second
  // must not publish the first, and neither is written until both are held.
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
