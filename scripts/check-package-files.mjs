#!/usr/bin/env node
// CI check: the published tarball actually carries what the package promises.
//
// `package.json`'s `files` array decides what `npm install adverse` gets, and
// nothing else in the repository checks it. A new top-level directory — another
// sibling of `skills/`, say — would ship as an empty install, with no error
// anywhere until a user reported that the Skill was missing.
//
// Usage: npm pack --dry-run --json | node scripts/check-package-files.mjs

const REQUIRED = [
  'bin/adverse.mjs',
  'src/ledger.mjs',
  'src/synthesis.mjs',
  'skills/adverse-review/SKILL.md',
  'skills/adverse-review/scripts/converge.mjs',
  'README.md',
  'LICENSE',
];

// npm 10 (which ships with Node 22) emits an array of pack results; npm 11
// (Node 24 and 26) emits an object keyed by package name. The matrix spans both.
function packedPaths(raw) {
  const parsed = JSON.parse(raw);
  const result = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
  if (!Array.isArray(result?.files)) {
    throw new Error('no `files` array in the `npm pack --json` output');
  }
  return result.files.map((f) => f.path);
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let buf = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => { buf += chunk; });
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', reject);
  });
}

let paths;
try {
  paths = packedPaths(await readStdin());
} catch (e) {
  process.stderr.write(`check-package-files: ${e.message}\n`);
  process.exit(2);
}

const missing = REQUIRED.filter((f) => !paths.includes(f));
if (missing.length) {
  process.stderr.write(
    'Not in the published tarball:\n'
    + missing.map((f) => `  - ${f}\n`).join('')
    + '\nCheck the `files` array in package.json.\n');
  process.exit(1);
}

process.stdout.write(`${paths.length} files in the tarball, all required paths present.\n`);
