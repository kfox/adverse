// Tests for skills/adverse-review/scripts/repair.mjs — round-2 repair.
//
// This bridge had no test coverage at all before its readJson call was moved
// onto the shared skills/adverse-review/scripts/bridge-io.mjs helper (which
// changed its exit code for an unreadable input from 1 to 2, matching every
// other bridge). These tests cover the change plus the script's basic
// contract, not a full spec of the repair logic.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPAIR = path.join(here, '..', 'skills', 'adverse-review', 'scripts', 'repair.mjs');

function runRepair(args) {
  return spawnSync(process.execPath, [REPAIR, ...args], { encoding: 'utf-8', timeout: 30_000 });
}

function freshTmp() {
  return mkdtempSync(path.join(tmpdir(), 'adverse-repair-'));
}

test('a paraphrased title is repaired to the briefing\'s canonical string', () => {
  const dir = freshTmp();
  try {
    const briefing = path.join(dir, 'briefing.json');
    writeFileSync(briefing, JSON.stringify({
      findings: [{ id: 'F1', title: 'Canonical Title', reporter: 'auditor' }],
    }));
    const round2 = path.join(dir, 'round2-steward.json');
    writeFileSync(round2, JSON.stringify({
      persona: 'steward',
      validate: [{ id: 'F1', title: 'a paraphrase', from: 'someone' }],
    }));
    const r = runRepair(['--briefing', briefing, '--round2', round2, '--outdir', dir]);
    assert.equal(r.status, 0, r.stderr);
    const repaired = JSON.parse(readFileSync(path.join(dir, 'round2-steward.repaired.json'), 'utf-8'));
    assert.equal(repaired.validate[0].title, 'Canonical Title');
    assert.equal(repaired.validate[0].from, 'auditor');
    assert.match(r.stdout, /1 titles repaired, 0 unresolved/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a whitespace briefing title is not repaired INTO the round-2 edge', () => {
  // The third hand-written index over `briefing.findings`, and the only one
  // that WRITES: a whitespace title is truthy, so `canonical` was truthy and
  // the reviewer's correct title was overwritten with whitespace — the join key
  // every downstream edge rides on, corrupted in silence by the function that
  // exists to repair it. `briefing.mjs` copies the titles, so a blank one is
  // this tool's own output, not the payload's mistake.
  const dir = freshTmp();
  try {
    const briefing = path.join(dir, 'briefing.json');
    writeFileSync(briefing, JSON.stringify({
      findings: [{ id: 'F1', title: '   ', reporter: 'auditor' }],
    }));
    const round2 = path.join(dir, 'round2-steward.json');
    writeFileSync(round2, JSON.stringify({
      persona: 'steward',
      validate: [{ id: 'F1', title: 'the guard is unreachable', from: 'someone' }],
    }));

    const r = runRepair(['--briefing', briefing, '--round2', round2, '--outdir', dir]);

    // Exit 1, because the edge is unresolved and every unresolved edge sets
    // it. That is the honest answer here: the id named an entry this tool
    // could not use, so the title was checked against nothing.
    assert.equal(r.status, 1, `${r.stdout}${r.stderr}`);
    const repaired = JSON.parse(
      readFileSync(path.join(dir, 'round2-steward.repaired.json'), 'utf-8'));
    assert.equal(repaired.validate[0].title, 'the guard is unreachable',
      'the reviewer\'s title stands: there was nothing to repair it against');
    assert.match(r.stderr, /this briefing states that id/, r.stderr);
    assert.match(r.stderr, /nothing to repair the title against/, r.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an id the briefing does not carry is still the citation to correct', () => {
  // The control for the sentence above: an id absent from the file gets the
  // ordinary report and none of the triage-output wording.
  const dir = freshTmp();
  try {
    const briefing = path.join(dir, 'briefing.json');
    writeFileSync(briefing, JSON.stringify({
      findings: [{ id: 'F1', title: 'a real one', reporter: 'auditor' }],
    }));
    const round2 = path.join(dir, 'round2-steward.json');
    writeFileSync(round2, JSON.stringify({
      persona: 'steward',
      validate: [{ id: 'F9', title: 'invented', from: 'someone' }],
    }));

    const r = runRepair(['--briefing', briefing, '--round2', round2, '--outdir', dir]);

    assert.match(r.stderr, /unresolvable id "F9"/, r.stderr);
    assert.doesNotMatch(r.stderr, /this briefing states that id/, r.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a --briefing whose findings is not an array is exit 2, naming the file', () => {
  // `.map` on an object is a raw TypeError at exit 1, and exit 1 means this
  // bridge read a payload that failed its schema. The same input is a named
  // exit-2 refusal in decisions.mjs and verify.mjs.
  const dir = freshTmp();
  try {
    const briefing = path.join(dir, 'briefing.json');
    writeFileSync(briefing, JSON.stringify({ findings: { F1: 'a real one' } }));
    const round2 = path.join(dir, 'round2-steward.json');
    writeFileSync(round2, JSON.stringify({
      persona: 'steward', validate: [{ id: 'F1', title: 't', from: 'someone' }],
    }));

    const r = runRepair(['--briefing', briefing, '--round2', round2, '--outdir', dir]);

    assert.equal(r.status, 2, `${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /briefing\.json/, r.stderr);
    assert.doesNotMatch(r.stderr, /is not a function|TypeError/, r.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an id absent from the briefing is unresolved, reported, and left untouched', () => {
  const dir = freshTmp();
  try {
    const briefing = path.join(dir, 'briefing.json');
    writeFileSync(briefing, JSON.stringify({ findings: [] }));
    const round2 = path.join(dir, 'round2-steward.json');
    writeFileSync(round2, JSON.stringify({
      persona: 'steward',
      validate: [{ id: 'F99', title: 'invented', from: 'someone' }],
    }));
    const r = runRepair(['--briefing', briefing, '--round2', round2, '--outdir', dir]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /unresolvable id "F99"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a ruling on a group the briefing proposed passes through untouched', () => {
  const dir = freshTmp();
  try {
    const briefing = path.join(dir, 'briefing.json');
    writeFileSync(briefing, JSON.stringify({
      findings: [{ id: 'F1', title: 'Canonical Title', reporter: 'auditor' }],
      groups: [{ id: 'G1', members: ['F1'] }],
    }));
    const round2 = path.join(dir, 'round2-steward.json');
    writeFileSync(round2, JSON.stringify({
      persona: 'steward', validate: [], challenge: [], added: [],
      groups: [{ id: 'G1', ruling: 'one', reason: 'one guard, seen twice' }],
    }));
    const r = runRepair(['--briefing', briefing, '--round2', round2, '--outdir', dir]);
    assert.equal(r.status, 0, r.stderr);
    const repaired = JSON.parse(readFileSync(path.join(dir, 'round2-steward.repaired.json'), 'utf-8'));
    assert.deepEqual(repaired.groups, [{ id: 'G1', ruling: 'one', reason: 'one guard, seen twice' }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a ruling on a group the briefing never proposed is unresolved and reported', () => {
  const dir = freshTmp();
  try {
    const briefing = path.join(dir, 'briefing.json');
    writeFileSync(briefing, JSON.stringify({ findings: [], groups: [{ id: 'G1', members: [] }] }));
    const round2 = path.join(dir, 'round2-steward.json');
    writeFileSync(round2, JSON.stringify({
      persona: 'steward', validate: [], challenge: [], added: [],
      groups: [{ id: 'G7', ruling: 'one', reason: 'invented' }],
    }));
    const r = runRepair(['--briefing', briefing, '--round2', round2, '--outdir', dir]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /steward\/groups: unresolvable id "G7"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a briefing predating root-cause groups still repairs, rather than crashing on a missing key', () => {
  const dir = freshTmp();
  try {
    const briefing = path.join(dir, 'briefing.json');
    writeFileSync(briefing, JSON.stringify({ findings: [{ id: 'F1', title: 'T', reporter: 'auditor' }] }));
    const round2 = path.join(dir, 'round2-steward.json');
    writeFileSync(round2, JSON.stringify({
      persona: 'steward', validate: [{ id: 'F1', title: 'T', from: 'auditor' }], challenge: [], added: [],
    }));
    const r = runRepair(['--briefing', briefing, '--round2', round2, '--outdir', dir]);
    assert.equal(r.status, 0, r.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('missing required arguments is a usage error', () => {
  const r = runRepair(['--briefing', 'x.json']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Usage: repair\.mjs/);
});

test('an unreadable --briefing file is exit 2, not exit 1 — this run could not read its input', () => {
  const dir = freshTmp();
  try {
    const bad = path.join(dir, 'briefing-bad.json');
    writeFileSync(bad, '{ not valid json');
    const round2 = path.join(dir, 'round2-steward.json');
    writeFileSync(round2, JSON.stringify({ persona: 'steward', validate: [] }));
    const r = runRepair(['--briefing', bad, '--round2', round2, '--outdir', dir]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /repair:.*briefing-bad\.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- the persona keys the output filename -----------------------------------
//
// verify.mjs added exactly this guard in the same change that created this
// bridge, and wrote down why: "the persona string keys the output filename …
// a re-cased or invented name would mint a phantom reviewer". The reasoning
// was not applied to the bridge sitting next to it.

function briefingAt(dir) {
  const briefing = path.join(dir, 'briefing.json');
  writeFileSync(briefing, JSON.stringify({
    findings: [{ id: 'F1', title: 'T', reporter: 'auditor' }],
  }));
  return briefing;
}

function round2At(dir, name, persona, agent = undefined) {
  const file = path.join(dir, name);
  writeFileSync(file, JSON.stringify({
    persona, agent, validates: [], challenges: [], added: [],
  }));
  return file;
}

test('an invented persona is refused rather than minting a phantom reviewer', () => {
  const dir = freshTmp();
  try {
    const src = round2At(dir, 'round2-referee.json', 'referee');
    const r = runRepair(['--briefing', briefingAt(dir), '--round2', src, '--outdir', dir]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /unknown persona "referee"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a re-cased persona is refused — it is a different key to the synthesizer', () => {
  const dir = freshTmp();
  try {
    const src = round2At(dir, 'round2-Auditor.json', 'Auditor');
    const r = runRepair(['--briefing', briefingAt(dir), '--round2', src, '--outdir', dir]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /unknown persona "Auditor"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A split lane sends TWO round-2 payloads under one persona now
// (kfox/adverse#50). Keying the destination on the persona collapsed them onto
// one path, where the write guard — doing its job — refused the second half and
// took the whole phase down.
test('a split lane\'s two halves repair to two files, one per agent', () => {
  const dir = freshTmp();
  try {
    const a = round2At(dir, 'round2-auditor-a.json', 'auditor', 'auditor-a');
    const b = round2At(dir, 'round2-auditor-b.json', 'auditor', 'auditor-b');
    const r = runRepair(['--briefing', briefingAt(dir), '--round2', a, '--round2', b, '--outdir', dir]);
    assert.equal(r.status, 0, r.stderr);
    for (const agent of ['auditor-a', 'auditor-b']) {
      const out = JSON.parse(readFileSync(path.join(dir, `round2-${agent}.repaired.json`), 'utf-8'));
      assert.equal(out.agent, agent);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an agent id that is not this lane\'s does not get to name a file', () => {
  // The id is model-written and it is about to be interpolated into a path.
  // Anything but the persona plus a letter suffix falls back to the persona,
  // where the write guard is still watching.
  const dir = freshTmp();
  try {
    const a = round2At(dir, 'round2-auditor-a.json', 'auditor', '../escaped');
    const r = runRepair(['--briefing', briefingAt(dir), '--round2', a, '--outdir', dir]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /round2-auditor\.repaired\.json/);
    assert.doesNotMatch(r.stdout, /escaped/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an over-long agent id never reaches writeFileSync — ENAMETOOLONG is not an exit code', () => {
  // `isLaneAgent`'s `/^[a-z]+$/` bounded the alphabet and not the length, so
  // `auditor-` plus 300 letters passed the guard, passed the write guard, and
  // died in writeFileSync with an uncaught stack trace — taking the remaining
  // payloads of the same invocation with it, since the loop has no per-payload
  // try. The id falls back to the persona instead.
  const dir = freshTmp();
  try {
    const src = round2At(dir, 'round2-auditor-a.json', 'auditor', `auditor-${'a'.repeat(300)}`);
    const r = runRepair(['--briefing', briefingAt(dir), '--round2', src, '--outdir', dir]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /round2-auditor\.repaired\.json/);
    assert.doesNotMatch(r.stderr, /ENAMETOOLONG|Error:/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('two payloads claiming one persona refuse to collide, rather than one overwriting the other', () => {
  const dir = freshTmp();
  try {
    const a = round2At(dir, 'round2-auditor.json', 'auditor');
    const b = round2At(dir, 'round2-auditor-stale.json', 'auditor');
    const r = runRepair(['--briefing', briefingAt(dir), '--round2', a, '--round2', b, '--outdir', dir]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /already claimed this run/);
    assert.doesNotMatch(r.stderr, /already written/,
      'nothing has been written yet: the claim is made at queue time');
    assert.throws(() => readFileSync(path.join(dir, 'round2-auditor.repaired.json')),
      'the collision is refused before the first file is written, not after');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a refused payload leaves no half-published outdir', () => {
  // The third bridge with the publish-then-refuse shape: repair validated and
  // wrote in one loop too, so an invented persona in the second payload exited
  // 1 with the first payload's `round2-<agent>.repaired.json` already on disk,
  // where the next glob reads it as a complete set. bridge-io.mjs's write queue
  // holds all three to the standard regression.mjs's fold states.
  const dir = freshTmp();
  try {
    const good = round2At(dir, 'round2-auditor.json', 'auditor');
    const bad = round2At(dir, 'round2-referee.json', 'referee');
    const r = runRepair(['--briefing', briefingAt(dir), '--round2', good,
                         '--round2', bad, '--outdir', dir]);
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stderr, /unknown persona "referee"/);
    assert.throws(() => readFileSync(path.join(dir, 'round2-auditor.repaired.json')),
      'the honest payload repaired cleanly, but publishing it is a claim this run withdrew');
    assert.equal(r.stdout, '', 'nor may it report a file it did not leave behind');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const [label, payload, named] of [
  ['a groups that is not an array', { persona: 'steward', groups: { G1: 'accept' } },
   '`groups` must be an array'],
  ['a groups that is null', { persona: 'steward', groups: null },
   '`groups` must be an array'],
  ['a validate that is null', { persona: 'steward', validate: null },
   '`validate` must be an array'],
  ['a null group ruling', { persona: 'steward', groups: [null] },
   '`groups[0]` is not an object'],
  ['a null edge', { persona: 'steward', validate: [null] },
   '`validate[0]` is not an object'],
  ['an edge that is a string', { persona: 'steward', challenge: ['F1'] },
   '`challenge[0]` is not an object'],
]) {
  // Every list this payload can carry, checked the same way: `groups` had
  // neither guard and the other two had only the array one, so `{"groups":{…}}`
  // was `object is not iterable` and `{"validate":[null]}` was `Cannot read
  // properties of null` — raw stack traces from a bridge whose exit 1 means
  // "this payload failed its schema", which is what it should have said.
  test(`${label} is named, not a stack trace`, () => {
    const dir = freshTmp();
    try {
      const briefing = path.join(dir, 'briefing.json');
      writeFileSync(briefing, JSON.stringify({
        findings: [{ id: 'F1', title: 'Canonical Title', reporter: 'auditor' }],
        groups: [{ id: 'G1', title: 'one root cause' }],
      }));
      const round2 = path.join(dir, 'round2-steward.json');
      writeFileSync(round2, JSON.stringify(payload));

      const r = runRepair(['--briefing', briefing, '--round2', round2, '--outdir', dir]);

      assert.equal(r.status, 1, `${r.stdout}${r.stderr}`);
      assert.ok(r.stderr.includes(named), `names the list and the index: ${r.stderr}`);
      assert.doesNotMatch(r.stderr, /TypeError|not iterable|at file:/, r.stderr);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('a null entry in `groups` does not take the whole phase down', () => {
  // The same `f &&` guard `findings` has, on the list that was indexed without
  // it: `[null]` is a triage output one element short of its shape, and
  // `.map((g) => g.id)` answered it with a raw TypeError at exit 1 — this
  // bridge's code for a payload that failed its schema, on a briefing the
  // payload did not write.
  const dir = freshTmp();
  try {
    const briefing = path.join(dir, 'briefing.json');
    writeFileSync(briefing, JSON.stringify({
      findings: [{ id: 'F1', title: 'Canonical Title', reporter: 'auditor' }],
      groups: [null, { id: 'G1', title: 'one root cause' }],
    }));
    const round2 = path.join(dir, 'round2-steward.json');
    writeFileSync(round2, JSON.stringify({
      persona: 'steward',
      groups: [{ id: 'G1', ruling: 'accept' }],
    }));

    const r = runRepair(['--briefing', briefing, '--round2', round2, '--outdir', dir]);

    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    assert.doesNotMatch(r.stderr, /TypeError|unresolvable id/, r.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const [label, groups] of [
  ['an object', { G1: 'one root cause' }],
  // `null` is what a serializer writes for a field it had no value for, so it
  // is the likeliest spelling of a malformed list — and `briefingEntries`
  // already refuses a `"findings": null`, so tolerating it here made the two
  // lists disagree about the one shape most likely to arrive. Only an ABSENT
  // key is no groups at all.
  ['null', null],
]) test(`a \`groups\` that is ${label} is refused, not read as no groups at all`, () => {
  // Read as empty, it reports every group ruling in every payload as
  // unresolvable — which sends the reviewer to check citations that are
  // correct, and blames the payloads for the shape of the briefing.
  const dir = freshTmp();
  try {
    const briefing = path.join(dir, 'briefing.json');
    writeFileSync(briefing, JSON.stringify({
      findings: [{ id: 'F1', title: 'Canonical Title', reporter: 'auditor' }],
      groups,
    }));
    const round2 = path.join(dir, 'round2-steward.json');
    writeFileSync(round2, JSON.stringify({
      persona: 'steward',
      groups: [{ id: 'G1', ruling: 'accept' }],
    }));

    const r = runRepair(['--briefing', briefing, '--round2', round2, '--outdir', dir]);

    assert.equal(r.status, 2, `${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /briefing\.json: `groups` is not an array/, r.stderr);
    assert.doesNotMatch(r.stderr, /unresolvable id/,
      'the payload cited a group correctly; the briefing is what could not be read');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
