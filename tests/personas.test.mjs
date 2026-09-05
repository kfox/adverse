// Tests for the persona set as a SET, not as four independent prompts.
//
// The design rests on one invariant: every `kind` is owned, and no two
// personas own the same ground. Nothing at runtime enforces that — two
// personas who both think documentation drift is theirs will each report it,
// and synthesis will read two independent reports of one issue as
// cross-validated consensus. That is the strongest signal the panel produces
// and the easiest to counterfeit, so the partition is checked here instead.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_PERSONAS, PERSONAS } from '../src/personas.mjs';
import { ADVISORY_KINDS, KINDS } from '../src/prompts.mjs';

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
