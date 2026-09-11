// Unit tests for src/taxonomy.mjs — the kind and severity axes shared across
// prompts, synthesis, rendering, scaling, and the ledger with no prompt prose.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ADVISORY_KINDS, CONFIDENCES, KINDS, ROOT_CAUSE_STATUSES, SEVERITIES,
         SEVERITY_RANK, assertCoversConfidences, citationReporter, citesLaneNames,
         claimedLanes, isLaneList, isLaneName } from '../src/taxonomy.mjs';

test('every advisory kind is a real kind', () => {
  for (const k of ADVISORY_KINDS) assert.ok(KINDS.includes(k), `${k} is not in KINDS`);
});

test('design and contract are advisory; defect and behavioral block', () => {
  assert.deepEqual([...ADVISORY_KINDS].sort(), ['contract', 'design']);
  assert.deepEqual(KINDS.filter((k) => !ADVISORY_KINDS.has(k)), ['defect', 'behavioral']);
});

test('severity rank has exactly one entry per severity, and it is a total order', () => {
  assert.deepEqual(Object.keys(SEVERITY_RANK).sort(), [...SEVERITIES].sort());
  const ranks = Object.values(SEVERITY_RANK);
  assert.equal(new Set(ranks).size, ranks.length, 'ranks must be distinct');
});

test('KINDS, ADVISORY_KINDS, SEVERITIES, and SEVERITY_RANK are frozen', () => {
  assert.ok(Object.isFrozen(KINDS));
  assert.ok(Object.isFrozen(ADVISORY_KINDS));
  assert.ok(Object.isFrozen(SEVERITIES));
  assert.ok(Object.isFrozen(SEVERITY_RANK));
});

test('the root-cause status vocabulary has one home', () => {
  // The five names were spelled in three places — synthesis's status ternary
  // and its label map, and html.mjs's — with nothing keeping them in step, so
  // a sixth status added to one would fall back silently in the others.
  assert.deepEqual([...ROOT_CAUSE_STATUSES].sort(),
    ['confirmed', 'contested', 'oversized', 'proposed', 'split']);
  assert.ok(Object.isFrozen(ROOT_CAUSE_STATUSES));
});

// --- The confidence vocabulary ------------------------------------------------
//
// Spelled out in five places before it lived here — synthesis's sort rank, its
// section titles, its bucket map, and html.mjs's two — with nothing keeping
// them in step. A label added to one was a silent gap in the others: a finding
// in no bucket, dropped from the report with no error at all. `demonstrated`
// was the fifth, and this is the check that makes the sixth loud.

test('the confidence vocabulary carries the label a probe buys', () => {
  assert.ok(CONFIDENCES.includes('demonstrated'));
  assert.equal(new Set(CONFIDENCES).size, CONFIDENCES.length);
});

test('a map missing a confidence is refused at load, naming which', () => {
  assert.throws(
    () => assertCoversConfidences({ solo: 1, disputed: 1 }, 'somewhere'),
    /somewhere: confidence labels are out of step with taxonomy; missing demonstrated/);
});

test('a map inventing a confidence is refused too', () => {
  const extra = Object.fromEntries([...CONFIDENCES, 'vibes'].map((c) => [c, 1]));
  assert.throws(() => assertCoversConfidences(extra, 'somewhere'), /unknown vibes/);
});

// Both forms are checked because both are enumerators: html.mjs derives its
// order from the KEYS of its label map, and synthesis keeps a separate ordered
// ARRAY for its sections.
test('an array of labels is checked the same way a map is', () => {
  assert.deepEqual(assertCoversConfidences([...CONFIDENCES], 'somewhere'), [...CONFIDENCES]);
  assert.throws(() => assertCoversConfidences(['solo'], 'somewhere'), /missing/);
});

// What a citation claims, read one way for every reader of one. `null` is the
// answer that means "not lane names", and every caller refuses on it — so the
// table below is also the list of shapes that stop a report being built.
for (const [label, citation, expected] of [
  ['a resolved citation, by the list synthesis put on it',
    { reporters: ['auditor', 'steward'], reporter: 'adversary' }, ['auditor', 'steward']],
  ['an unresolved citation, by the reporter it claimed',
    { reporters: null, reporter: 'adversary' }, ['adversary']],
  // The absence this exists to distinguish from a claim: it used to contribute
  // an `undefined` that serialized as `null`, counted as a reviewer in the PR
  // comment and rendered as the word "null" in the dashboard.
  ['a citation claiming nobody', { reporters: null }, []],
  ['a citation whose only claim is null', { reporter: null }, []],
  // And the values that are claims this tool cannot read. A bare string is the
  // one the whole vocabulary exists for: `"auditor"` is iterable, so a reader
  // that wrapped it in a list would call it one reviewer and a reader that
  // spread it would call it seven.
  ['a reporters that is a string', { reporters: 'auditor' }, null],
  ['a reporters that is an object', { reporters: { lane: 'auditor' } }, null],
  ['a reporter that is a number', { reporter: 42 }, null],
  ['a reporters holding something that is not a lane name', { reporters: ['auditor', 7] }, null],
  // An absence inside a list is not the absence above it: `[null]` is a list
  // that got a lane wrong, and reading it as "claims nobody" would have given
  // one file two answers, since the predicate below calls it what it is.
  ['a reporters holding an absence', { reporters: [null] }, null],
  // A name of no characters is not a lane that declined to identify itself.
  ['a reporter that is the empty string', { reporter: '' }, null],
  ['a reporter that is only whitespace', { reporter: '  ' }, null],
  // One codepoint past what `trim` reaches. Each of these printed as nothing
  // beside the citation id and was still counted as a reviewer.
  ['a reporter that is a zero-width space', { reporter: '\u200b' }, null],
  ['a reporter that is a word joiner', { reporter: '\u2060' }, null],
  ['a reporter that is a byte-order mark', { reporter: '\ufeff' }, null],
  ['a reporter that is a control character', { reporter: '\u0000' }, null],
  // A name with one of those beside it is not the name it looks like. It
  // deduped as a second entry against the real `auditor`, printed
  // identically, and published "2 reviewers" — the same double vouching,
  // reached by duplication rather than by emptiness.
  ['a reporter carrying an invisible character', { reporter: 'auditor\u200b' }, null],
  // The three that the category test still admitted, each of which prints as
  // no character: a filler that is a LETTER, a blank that is a SYMBOL, and a
  // variation selector that is a MARK.
  ['a reporter that is a Hangul filler', { reporter: '\u3164' }, null],
  ['a reporter that is a blank braille pattern', { reporter: '\u2800' }, null],
  ['a reporter that is a variation selector', { reporter: '\ufe0f' }, null],
  ['a reporter with a space inside it', { reporter: 'audi tor' }, null],
  // And the names this tool actually writes.
  ['a persona', { reporter: 'auditor' }, ['auditor']],
  ['one half of a split lane', { reporter: 'auditor-b' }, ['auditor-b']],
]) test(`claimedLanes reads ${label}`, () => {
  assert.deepEqual(claimedLanes(citation), expected);
});

// And whether those fields are lane names at all, which is a different
// question from which lanes they name: the reading above prefers `reporters`,
// and both renderers print the singular `reporter` verbatim. A check made of
// only the first passed a citation carrying a good list beside a junk
// singular, which then reached three artifacts as `[object Object]`.
for (const [label, citation, expected] of [
  ['a citation naming lanes in both fields',
    { reporters: ['auditor'], reporter: 'auditor' }, true],
  ['a citation naming nobody at all', {}, true],
  ['a citation whose fields are both null', { reporters: null, reporter: null }, true],
  ['a citation whose singular reporter is junk', { reporter: 42 }, false],
  ['a citation whose list is junk', { reporters: ['auditor', 7] }, false],
  // The one the reading above cannot see, because it stops at `reporters`.
  ['a citation with a good list beside a junk singular',
    { reporters: ['auditor'], reporter: { lane: 'auditor' } }, false],
  ['a citation whose list holds an absence', { reporters: [null] }, false],
  ['a citation whose reporter is the empty string', { reporter: '' }, false],
]) test(`citesLaneNames judges ${label}`, () => {
  assert.equal(citesLaneNames(citation), expected);
});

// One way, and only one. The judgement is the stricter of the two — it reads
// the singular that the renderers print, which the reading skips whenever a
// list is there — so a citation it accepts is always one the reading can read,
// and that is the direction `buildRootCauses` depends on: it asks the
// judgement first and then spreads the reading, which must not be `null`.
//
// The converse is false, and load-bearing that it is false: a good list beside
// a junk singular reads as `['auditor']` and is judged not lane names, which
// is the whole reason there are two of these. Asserted as an equivalence, this
// loop would pass only for as long as nobody added that shape to it.
test('a citation the judgement accepts is one the reading can read', () => {
  for (const citation of [
    {}, { reporters: null }, { reporter: null }, { reporter: 'auditor' },
    { reporters: [] }, { reporters: ['auditor'] }, { reporters: [null] },
    { reporters: 'auditor' }, { reporter: 42 }, { reporters: ['auditor', 7] },
    { reporter: '' }, { reporters: ['auditor'], reporter: 42 },
  ]) {
    if (!citesLaneNames(citation)) continue;
    assert.notEqual(claimedLanes(citation), null, JSON.stringify(citation));
  }
});

test('the stricter of the two is the one the renderers read', () => {
  const bothWays = { reporters: ['auditor'], reporter: 42 };
  assert.deepEqual(claimedLanes(bothWays), ['auditor']);
  assert.equal(citesLaneNames(bothWays), false);
});

// A lane list is what the ledger, the PR comment and the dashboard all read,
// and a blank name cleared every one of them while printing as nothing.
test('a lane name with no name in it is not a lane name', () => {
  assert.equal(isLaneList(['auditor', '']), false);
  assert.equal(isLaneList(['auditor', '  ']), false);
  assert.equal(isLaneList(['auditor']), true);
});

// Each of these prints as no character and counted as one reviewer in a
// permanent PR comment. Two rounds of naming what a name may NOT contain each
// closed the list one codepoint short — `trim()` at the format characters, and
// the three invisible CATEGORIES at a filler that is a letter, a blank that is
// a symbol and a selector that is a mark.
test('a lane name of invisible characters is not a lane name', () => {
  for (const blank of ['\u200b', '\u2060', '\u180e', '\ufeff', '\u0000', '\u00a0',
    '\u3164', '\u2800', '\ufe0f', '\u115f', '\u200b\u2060 ', '  ', '']) {
    assert.equal(isLaneList([blank]), false, JSON.stringify(blank));
  }
});

// Identity, which no blocklist could settle: a name is one spelling, so the
// set that counts reviewers counts each lane once. `auditor` and
// `auditor\u200b` printed identically and were two.
test('a lane has one spelling, so two of them are two lanes', () => {
  assert.equal(isLaneList(['auditor\u200b']), false, 'not the name it looks like');
  assert.equal(isLaneList([' auditor ']), false, 'nor is it padded');
  // Every way of re-spelling one lane, against the one spelling it has. A set
  // built off this list used to have five entries and publish five reviewers.
  assert.deepEqual(
    ['auditor', 'Auditor', 'AUDITOR', 'auditor_a', 'auditor-ab', 'auditor\u200b',
      ' auditor '].filter(isLaneName),
    ['auditor'],
    'one lane, one spelling');
  // And the two halves of a split lane are two, because the tool writes both.
  assert.deepEqual(['auditor-a', 'auditor-b'].filter(isLaneName),
    ['auditor-a', 'auditor-b']);
});

// A lane name reaches report.md, the dashboard and a permanent PR comment
// escaped and unclipped, so it is bounded where `AGENT_LABEL` and `GROUP_ID`
// are bounded.
test('a lane name is bounded, like the other identifiers held to a shape', () => {
  assert.equal(isLaneName('a'.repeat(32)), true);
  assert.equal(isLaneName('a'.repeat(33)), false);
  assert.equal(isLaneName(`${'a'.repeat(32)}-b`), true, 'the half suffix is not the bound');
});

// What a citation line says about who reported it: the claim, then what
// synthesis resolved, then words. The middle one is why this exists — a
// citation that claimed nobody and resolved anyway said "no reporter" in the
// same card whose header named two reviewers.
for (const [label, citation, expected] of [
  ['the claim, where there is one', { reporter: 'auditor', reporters: ['steward'] }, 'auditor'],
  ['what synthesis resolved, where there is no claim',
    { reporters: ['auditor', 'steward'] }, 'auditor, steward'],
  ['words, where there is neither', { reporters: [] }, 'no reporter'],
  ['words, for a citation that is not there at all', undefined, 'no reporter'],
  // Each half asks the same predicate its neighbors ask. `??` fell through
  // only on an absence, so a blank claim printed as nothing — inside the
  // helper written to stop exactly that.
  ['what synthesis resolved, where the claim is blank',
    { reporter: '', reporters: ['auditor'] }, 'auditor'],
  ['words, where the claim is blank and nothing was resolved',
    { reporter: '\u200b' }, 'no reporter'],
  // And the value this vocabulary exists for, in the one reader here that
  // would have crashed on it rather than refused it: `"auditor".length` is 7,
  // and its `join` is not a function.
  ['words, where the resolved lanes are a bare string',
    { reporters: 'auditor' }, 'no reporter'],
]) test(`citationReporter names ${label}`, () => {
  assert.equal(citationReporter(citation), expected);
});
