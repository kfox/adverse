// Tests for the persona set as a SET, not as four independent prompts.
//
// The design rests on one invariant: every `kind` is owned by someone. Kinds
// are deliberately SHARED — `defect` by the Auditor and the Adversary,
// `behavioral` by three — so what keeps a shared kind from producing duplicate
// findings is not the kind but the EVIDENCE each lane must bring, enforced by
// the exclusion lists in each system prompt. Nothing at runtime checks any of
// it: two personas who both think documentation drift is theirs will each
// report it, and synthesis will read two independent reports of one issue as
// cross-validated consensus. That is the strongest signal the panel produces
// and the easiest to counterfeit, so the map is pinned here instead —
// src/personas.mjs sends a maintainer to OWNERSHIP below to change it.

import { readFileSync, readdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_PERSONAS, PERSONAS, advisoryOnlyLane, crossReviews, isLaneAgent,
  laneAgentOf,
} from '../src/personas.mjs';
import { sizeSkippable } from '../src/scaling.mjs';
import { ADVISORY_KINDS, KINDS } from '../src/taxonomy.mjs';

const all = Object.values(PERSONAS);

test('every persona declares kinds, and only real ones', () => {
  for (const p of all) {
    assert.ok(Array.isArray(p.kinds) && p.kinds.length, `${p.name} declares no kinds`);
    for (const k of p.kinds) {
      assert.ok(KINDS.includes(k), `${p.name} claims unknown kind '${k}'`);
    }
  }
});

test('every kind has an owner', () => {
  const owned = new Set(all.flatMap((p) => p.kinds));
  for (const k of KINDS) {
    assert.ok(owned.has(k), `no persona owns '${k}' — findings of that kind cannot be reported`);
  }
});

test('the advisory kind has exactly one owner', () => {
  for (const advisory of ADVISORY_KINDS) {
    const owners = all.filter((p) => p.kinds.includes(advisory));
    assert.equal(owners.length, 1,
      `'${advisory}' is advisory and must have one owner, has: ${owners.map((p) => p.name)}`);
  }
});

test('a persona that owns only advisory kinds says so in its prompt', () => {
  for (const p of all) {
    if (!p.kinds.every((k) => ADVISORY_KINDS.has(k))) continue;
    assert.match(p.system, /advisory/i,
      `${p.name} can never block and must be told so, or it will calibrate as if it could`);
  }
});

test('every persona hands off to every other persona by name', () => {
  // The exclusion lists are the handoff. A persona that never names another is
  // the one that will duplicate its lane.
  for (const p of all) {
    const scopeSplit = p.system.indexOf('out of scope');
    assert.ok(scopeSplit > 0, `${p.name} has no out-of-scope section`);
    const exclusions = p.system.slice(scopeSplit);
    for (const other of all) {
      if (other.name === p.name) continue;
      assert.ok(exclusions.includes(other.title),
        `${p.name} never hands off to ${other.title} — both may report the same finding, `
        + 'and two reports of one issue read as cross-validated consensus');
    }
  }
});

test('every persona names the kinds it emits', () => {
  for (const p of all) {
    for (const k of p.kinds) {
      assert.ok(p.system.includes(`\`${k}\``), `${p.name}'s prompt never mentions '${k}'`);
    }
  }
});

// The ownership map, pinned. The previous version of this test derived
// `soleOwner` from the very arrays it then asserted against, so its conclusion
// was true by construction and it could not fail for any input — including the
// input it existed to catch, a lane widened into a neighbor's ground. The
// fixture has to be written down independently of the code to be a test at all.
const OWNERSHIP = {
  defect:     ['auditor', 'adversary'],
  behavioral: ['auditor', 'adversary', 'steward'],
  contract:   ['steward'],
  design:     ['pragmatist'],
};

test('each kind is owned by exactly the personas the design assigns it', () => {
  for (const kind of KINDS) {
    const actual = all.filter((p) => p.kinds.includes(kind)).map((p) => p.name).sort();
    const expected = [...(OWNERSHIP[kind] ?? [])].sort();
    assert.deepEqual(actual, expected,
      `'${kind}' is owned by [${actual}], but the design assigns it to [${expected}]. `
      + 'Widening a lane costs findings; narrowing one leaves a kind unclaimed. '
      + 'If this is deliberate, change OWNERSHIP here and the table in personas.mjs.');
  }
});

test('the ownership fixture covers every kind, and invents none', () => {
  assert.deepEqual(Object.keys(OWNERSHIP).sort(), [...KINDS].sort());
});

test('design is owned by exactly one persona, because it cannot block', () => {
  // An advisory kind reported by two lanes would read as cross-validated
  // consensus on a finding that is not allowed to block anything.
  assert.equal(all.filter((p) => p.kinds.includes('design')).length, 1);
});

test('DEFAULT_PERSONAS matches the registry, in a stable order', () => {
  assert.deepEqual([...DEFAULT_PERSONAS], Object.keys(PERSONAS));
});

test('persona titles are distinct — the fake agent and the prompts key on them', () => {
  const titles = all.map((p) => p.title);
  assert.equal(new Set(titles).size, titles.length);
});

test('every lane that always runs solo explains itself from the registry', () => {
  // scaling.mjs reads `soloReason` when it says why a lane runs as one agent.
  // The registry was introduced to stop that rationale living at the call site,
  // and shipped with one entry and one exception — so the Pragmatist's reason
  // was still hard-coded in scaling.mjs, which is the drift it was preventing.
  for (const p of [PERSONAS.steward, PERSONAS.pragmatist]) {
    assert.equal(typeof p.soloReason, 'string', `${p.name} needs a soloReason`);
    assert.ok(p.soloReason.length > 10);
  }
});

// --- isLaneAgent: the id is about to be a filename -------------------------

test('isLaneAgent accepts the ids agentNames can emit, and the bare persona', () => {
  assert.equal(isLaneAgent('auditor', 'auditor'), true);
  for (const suffix of ['a', 'b', 'z']) {
    assert.equal(isLaneAgent('auditor', `auditor-${suffix}`), true, suffix);
  }
});

test('isLaneAgent bounds the suffix LENGTH, not only its alphabet', () => {
  // `/^[a-z]+$/` bounded the character class and not the length, and
  // repair.mjs interpolates the accepted id into a filename: a 300-letter
  // suffix passed this guard and died in writeFileSync with an uncaught
  // ENAMETOOLONG, which is not an exit code at all. `agentNames` emits one
  // letter, so nothing longer is an id this system produces.
  assert.equal(isLaneAgent('auditor', `auditor-${'a'.repeat(300)}`), false);
  assert.equal(isLaneAgent('auditor', 'auditor-ab'), false);
});

test('isLaneAgent refuses another lane, a bad separator, and a non-letter suffix', () => {
  for (const agent of ['adversary', 'adversary-a', 'auditor_a', 'auditor-', 'Auditor-a',
                       'auditor-1', 'auditor-A', 'auditor-a/b', '__proto__', '', null, 42]) {
    assert.equal(isLaneAgent('auditor', agent), false, JSON.stringify(agent));
  }
});

// --- advisoryOnlyLane: its callers, enumerated instead of counted ----------

// Every call site of `advisoryOnlyLane`, and the question that site decides.
// The header comment above the predicate in src/personas.mjs renders this
// table; the table lives HERE because this is the copy a test can check.
//
// It is written down rather than derived from the scan below, or it would be
// true by construction and could not fail. Every COUNT the prose copy ever
// carried was wrong: it said two questions turn on the predicate when three
// did, was corrected to "THREE", and left the sentence four lines below still
// reading "Both callers". So the count is gone from the prose and the names
// are checked from here instead.
const ADVISORY_ONLY_CALLERS = {
  'personas.mjs': 'crossReviews',
  'regression.mjs': 'ELIGIBLE',
  'scaling.mjs': 'sizeSkippable',
};

const SRC_DIR = new URL('../src/', import.meta.url);

// `src/` basenames that CALL the predicate. Comment lines are skipped — half
// the modules discuss it — and so is its own declaration; an `import` names it
// without a following paren and so never matches.
function callersOfAdvisoryOnlyLane() {
  const callers = [];

  for (const name of readdirSync(SRC_DIR)) {
    if (!name.endsWith('.mjs')) continue;
    const calls = readFileSync(new URL(name, SRC_DIR), 'utf-8').split('\n')
      .filter((line) => line.includes('advisoryOnlyLane(')
        && !line.trimStart().startsWith('//')
        && !line.includes('function advisoryOnlyLane('));
    if (calls.length) callers.push(name);
  }

  return callers.sort();
}

// The `//` block immediately above the declaration, and not one line more: the
// whole file mentions these names in passing, so a loose slice would pass on
// prose that says nothing about the callers.
function advisoryOnlyLaneHeader() {
  const lines = readFileSync(new URL('personas.mjs', SRC_DIR), 'utf-8').split('\n');
  const declared = lines.findIndex((l) => l.startsWith('export function advisoryOnlyLane'));
  assert.ok(declared > 0, 'advisoryOnlyLane is not declared where this test looks for it');

  let first = declared;
  while (first > 0 && lines[first - 1].startsWith('//')) first -= 1;

  return lines.slice(first, declared).join('\n');
}

test('the advisoryOnlyLane caller table names every call site, and invents none', () => {
  assert.deepEqual(callersOfAdvisoryOnlyLane(), Object.keys(ADVISORY_ONLY_CALLERS).sort(),
    'a question turns on advisoryOnlyLane that ADVISORY_ONLY_CALLERS does not list, '
    + 'or it lists a module that no longer asks one. Those answers must never '
    + 'disagree, so a new caller is a deliberate edit here and in the table in '
    + 'src/personas.mjs.');
});

test('src/personas.mjs names each caller it answers for, rather than counting them', () => {
  const header = advisoryOnlyLaneHeader();
  for (const [file, symbol] of Object.entries(ADVISORY_ONLY_CALLERS)) {
    assert.ok(header.includes(`src/${file}`),
      `the comment above advisoryOnlyLane never names src/${file}`);
    assert.ok(header.includes(symbol),
      `the comment above advisoryOnlyLane never names \`${symbol}\``);
  }
});

test('an unknown persona reaches its callers in the direction that gives it work', () => {
  // The claim in that comment, run. `advisoryOnlyLane` answering true for a
  // name the registry has never heard of would drop the lane from round 2 and
  // let a small diff skip it — silently, which is the direction this design
  // never takes. scaling.test.mjs pins the `sizeSkippable` half from its own
  // side; asserted here too because the conjunction is what the comment
  // promises, and one caller changing its mind would leave it half true.
  assert.equal(advisoryOnlyLane('scribe'), false, 'an unknown name read as advisory-only');
  assert.equal(crossReviews('scribe', 2), true, 'round 2 dropped an unrecognized lane');
  assert.equal(sizeSkippable('scribe'), false, 'a small diff skipped an unrecognized lane');
  // Not vacuous: the one real advisory-only lane answers the other way on
  // every one of them.
  assert.equal(advisoryOnlyLane('pragmatist'), true, 'the pragmatist is advisory-only');
  assert.equal(crossReviews('pragmatist', 2), false, 'the pragmatist has no round-2 claim');
  assert.equal(sizeSkippable('pragmatist'), true, 'the pragmatist is size-skippable');
});

// --- laneAgentOf: one rule, one default ------------------------------------
//
// `isLaneAgent` says whether an id is well formed; `laneAgentOf` says who to
// attribute the work to when it is not, which is the question every caller
// actually had. It exists because that answer was written out longhand once
// per module — src/synthesis.mjs's `claimedAgent`, src/briefing.mjs's ternary,
// and repair.mjs's, where the answer becomes a filename — and round 2's
// self-validation guard keys on it, so two of them disagreeing hands some
// agent an independent-looking vote on its own finding.

test('laneAgentOf keeps an id of this lane and substitutes the lane for anything else', () => {
  assert.equal(laneAgentOf('auditor', 'auditor-b'), 'auditor-b');
  assert.equal(laneAgentOf('auditor', 'auditor'), 'auditor');
  for (const claimed of ['steward-a', 'auditor_b', 'auditor-ab', 'auditor-', '', null, 42]) {
    assert.equal(laneAgentOf('auditor', claimed), 'auditor',
      `a claimed id of ${JSON.stringify(claimed)} was not coerced to its lane`);
  }
});

test('laneAgentOf returns the persona it was given, untouched', () => {
  // Callers read the lane off a JSON payload, so an absent one has to come
  // back absent rather than as the string "undefined" or a coerced ''.
  for (const persona of [null, undefined, 42]) {
    assert.equal(laneAgentOf(persona, 'auditor-a'), persona,
      `a lane of ${JSON.stringify(persona)} did not survive the call`);
  }
});

// Where the rule is still spelled by hand. `isLaneAgent` answers a second,
// legitimate question — "is this id well formed" — and the guards that ask it
// (src/regression.mjs, combine.mjs) are correct as written and are not listed
// here. What IS listed is a call that uses the answer as a ternary condition
// and supplies its own default, which is `laneAgentOf` written out longhand.
//
// src/briefing.mjs was a fourth. src/synthesis.mjs's `claimedAgent` and
// repair.mjs's filename key are the two that remain, and both are owned
// elsewhere. Every `isLaneAgent` reference under src/, bin/ and
// skills/adverse-review/scripts/ was read to build this list; what the scan
// below cannot see is the same rule written as an `if`/`else` instead of a
// ternary, so this bounds the copies it can recognize and does not claim there
// can never be another.
const HAND_SPELLED_LANE_AGENT_RULE = [
  'skills/adverse-review/scripts/repair.mjs',
  'src/synthesis.mjs',
];

// `isLaneAgent(...)` used as a ternary CONDITION — the longhand form. A guard
// that merely negates it, or a ternary that calls it in a branch, does not
// match. src/personas.mjs is skipped: the one there is the implementation.
const LONGHAND = /isLaneAgent\(.*\)\s*\?/;
const SCANNED_DIRS = ['src', 'bin', 'skills/adverse-review/scripts'];

function handSpelledLaneAgentRule() {
  const root = new URL('../', import.meta.url);
  const sites = [];

  for (const dir of SCANNED_DIRS) {
    const dirUrl = new URL(`${dir}/`, root);
    for (const name of readdirSync(dirUrl)) {
      if (!name.endsWith('.mjs') || `${dir}/${name}` === 'src/personas.mjs') continue;
      const hits = readFileSync(new URL(name, dirUrl), 'utf-8').split('\n')
        .filter((line) => LONGHAND.test(line) && !line.trimStart().startsWith('//'));
      if (hits.length) sites.push(`${dir}/${name}`);
    }
  }

  return sites.sort();
}

test('the longhand detector recognizes the shape, and not the guards beside it', () => {
  // The check below loops over what the scan found, so a detector that matched
  // nothing would pass it vacuously forever. Pinned against literals here so
  // an empty scan means the copies are gone rather than the regex is broken.
  assert.ok(LONGHAND.test(
    'const agent = isLaneAgent(payload.persona, payload.agent) ? payload.agent : payload.persona;'));
  assert.ok(LONGHAND.test('return isLaneAgent(persona, claimed) ? claimed : null;'));
  assert.equal(LONGHAND.test('return lane === null || !isLaneAgent(lane, agent);'), false,
    'a guard that only negates the answer supplies no default and is not a copy');
  assert.equal(
    LONGHAND.test('if (legal ? !legal.includes(agent) : !isLaneAgent(persona, agent)) {'), false,
    'a ternary that calls it in a BRANCH is not the rule written longhand');
});

test('no new module spells the lane-agent fallback by hand instead of calling laneAgentOf', () => {
  // A SUBSET check, deliberately. Converting one of the two listed sites is
  // the open handoff and must not turn this red for whoever lands it; adding a
  // third copy must. Delete an entry here once its site calls `laneAgentOf`.
  for (const site of handSpelledLaneAgentRule()) {
    assert.ok(HAND_SPELLED_LANE_AGENT_RULE.includes(site),
      `${site} decides whose work an agent id names with its own ternary. `
      + 'Call laneAgentOf from src/personas.mjs: the round-2 self-validation '
      + 'guard keys on that answer, so a copy that drifts hands an agent an '
      + 'independent-looking vote on its own finding.');
  }
});
