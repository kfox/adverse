// Bounds two layers have to agree on.
//
// Same reasoning as src/taxonomy.mjs's header, one layer over. The test is
// whose subject the number is — not how far it travels, and not how many
// modules read it. A cap belongs here when it is nobody's subject and two
// layers have to agree on it anyway, one enforcing it and one describing it.
// `MAX_REASON_CHARS` is enforced by `clipReason` in src/ledger.mjs and quoted
// by the fix prompt in src/prompts.mjs, which tells an agent not to hide a
// property in a field that gets clipped — and a prompt module reaching through
// the ledger to synthesis.mjs to learn one integer is the same shape
// taxonomy.mjs was split out to stop.
//
// `MAX_PROBES_PER_LANE` is read outside src/probe.mjs by the fix prompt, the
// planner and the probe bridge, and stays there anyway, because probes are that
// module's subject: every one of those is asking a question about probes, and
// the module that answers it is the right place to ask. No count here on
// purpose — the header said "two readers" while there were three, and a number
// nothing checks was the wrong thing to put in a paragraph whose whole claim is
// that the count is not what decides. `MAX_LEDGER_ENTRIES` is the same and
// easier: nothing outside the ledger reads it.
//
// `MAX_REASON_CHARS` is not like either. The ledger's subject is adjudication,
// and the function enforcing this cap — `clipReason` — is a general
// bound-and-strip helper for every string this tool reads off disk, not a rule
// about `reason`. So the number is not the ledger's to own; it is a width two
// layers have to agree on, one enforcing it and one describing it to an agent,
// and a leaf both import leaves neither depending on the other for an integer.
//
// Not a cycle fix: src/ledger.mjs already imports src/synthesis.mjs, so nothing
// here narrowed a cycle surface.

import { refuseDirectRun } from './entryGuard.mjs';

refuseDirectRun(import.meta.url);

// How much of any single disk-read string survives `clipReason`
// (src/ledger.mjs) — not just a decision's `reason`, which is only the longest
// of them and the reason for the name. This is the length of the KEPT prefix:
// a clipped string comes back as that prefix plus `… [clipped]`, so the
// longest value the function can return is eleven characters more than this. It also bounds matched ids,
// dispositions, commit strings, group titles, citation titles and FILE PATHS,
// so sizing it to suit one sentence truncates a path in an
// `unsupportedFixes` message.
//
// Every one of those reaches a later prompt as text, which makes this a trust
// boundary and not a display choice: the ledger is a JSON file on disk, so its
// contents are as attacker-chosen as anything else read from there.
export const MAX_REASON_CHARS = 500;
