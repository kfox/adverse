#!/usr/bin/env node
// Skill bridge: thin shell over `adverse synthesize` (src/cli.mjs). Both
// entry points read the same round-1/round-2 JSON and emit the same report,
// so this bridge no longer keeps its own copy of that logic — a prior copy
// here is exactly how --skipped/--degraded ended up reachable only from the
// Skill and not from the standalone CLI (issue #3).

import { importFromSrc } from './package-root.mjs';

const { main } = await importFromSrc('cli.mjs');

process.exit(await main(['synthesize', ...process.argv.slice(2)]));
