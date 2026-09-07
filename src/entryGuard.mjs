// Nothing under src/ is a process entry point, and running one now says so.
//
// `node src/cli.mjs synthesize …` used to exit 0 having done nothing: the
// module defines `main()` and only bin/adverse.mjs calls it. Every consumer of
// an exit code — the convergence loop, a CI step, an orchestrating agent —
// reads that 0 as "it ran and it passed" (kfox/adverse#71).
//
// The rule enforced here is the one the tree already follows: a `.mjs` file
// with a shebang is an entry point, one without is a library. It is applied to
// every src/ module rather than to the few that are easy to mistype, because
// "nothing in src/ is runnable" has no exceptions to remember — and four of
// them (collect, decisions, regression, triage) share a basename with a bridge
// that IS runnable, so the mistake is one tab-completion away.
//
// Refusing rather than running `main()`: the translation from a return value
// to an exit status lives in bin/adverse.mjs, so a `run if entry` guard here
// would resolve its promise and exit 0 on a BLOCK verdict unless it duplicated
// that wiring. One place knows how this program exits.

import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

// Node resolves module URLs through realpath before it evaluates them, so
// `import.meta.url` is already canonical. `process.argv[1]` is the literal
// string the caller typed and is not.
const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_DIR = path.resolve(SRC_DIR, '..', 'skills', 'adverse-review', 'scripts');

// The same code the CLI documents for bad arguments and bridge-io.mjs gives a
// run that never got as far as reading its input: exit 1 is a claim about a
// review, and a process that refused to start reviewed nothing.
export const NOT_AN_ENTRY_POINT = 2;

function realOrSelf(filePath) {
  try {
    return realpathSync(filePath);
  } catch {
    return filePath;
  }
}

// The last two segments: `src/cli.mjs`, not a machine-specific absolute path.
export function moduleLabel(modulePath) {
  return path.join(path.basename(path.dirname(modulePath)), path.basename(modulePath));
}

// argv[1] is absent under `node --eval` and in the REPL, where nothing is the
// entry file and no guard should fire.
export function isProcessEntry(moduleUrl) {
  const entry = process.argv[1];
  return !!entry && realOrSelf(entry) === realOrSelf(fileURLToPath(moduleUrl));
}

// What the caller meant. A src/ module sharing a basename with a bridge is the
// likely miss; cli.mjs is the one the binary wraps; anything else gets the
// general rule rather than a guess. The sibling is offered as a question and
// the rule is stated after it, so the message stays true even for a name that
// belongs to one of the two LIBRARIES living in the bridge directory.
//
// `existsSync` is a stat and is deliberately not a read. This path is derived
// from the caller's argv and points into an installed package tree; opening it
// would block forever on a FIFO planted there, which is worse than the silent
// exit 0 this whole guard replaces — src/fsSafe.mjs's header records that
// happening to the triage bridge. Nothing here needs the bytes.
export function runInstead(modulePath) {
  const name = path.basename(modulePath);
  if (name === 'cli.mjs') {
    return 'Run `node bin/adverse.mjs <command>` instead (or the installed `adverse`).';
  }
  const bridge = path.join(BRIDGE_DIR, name);
  if (bridge !== modulePath && existsSync(bridge)) {
    return `Did you mean skills/adverse-review/scripts/${name}?`
      + ' The entry points are bin/adverse.mjs and the shebang scripts under'
      + ' skills/adverse-review/scripts/.';
  }
  return 'The entry points are bin/adverse.mjs and skills/adverse-review/scripts/*.mjs.';
}

export function refuseDirectRun(moduleUrl) {
  if (!isProcessEntry(moduleUrl)) return;
  const modulePath = fileURLToPath(moduleUrl);
  process.stderr.write(`adverse: ${moduleLabel(modulePath)} is a library module,`
    + ` not an entry point.\n  ${runInstead(modulePath)}\n`);
  process.exit(NOT_AN_ENTRY_POINT);
}

refuseDirectRun(import.meta.url);
