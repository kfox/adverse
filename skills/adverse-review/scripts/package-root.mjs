// Skill bridge: locate the adverse package root from this file's real location.
//
// The skill directory is normally *installed* as a symlink into a checkout
// (~/.claude/skills/adverse-review -> …/adverse/skills/adverse-review), so a
// bare `../../../src/x.mjs` specifier resolves only because Node resolves
// module URLs through realpath first. It works, but `ls` on the apparent path
// shows nothing, which reads as a broken import to whoever is debugging — and
// it stops working under `--preserve-symlinks`. Resolving from this file's own
// realpath says out loud where the import lands, and fails with a sentence
// instead of MODULE_NOT_FOUND when the skill has been copied somewhere that
// has no `src/` above it.

import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPTS_DIR = path.dirname(realpathSync(fileURLToPath(import.meta.url)));

export const PACKAGE_ROOT = path.resolve(SCRIPTS_DIR, '..', '..', '..');

export function importFromSrc(moduleFile) {
  const abs = path.join(PACKAGE_ROOT, 'src', moduleFile);
  if (!existsSync(abs)) {
    process.stderr.write(
      `adverse: cannot find ${abs}\n`
      + `  The skill scripts must sit inside an adverse checkout or install\n`
      + `  (they import the shared implementation from its src/). Re-install\n`
      + `  the skill as a symlink to the package rather than copying it.\n`);
    process.exit(1);
  }
  return import(pathToFileURL(abs).href);
}
