// Tests for src/synthesis.mjs — deterministic merge, consensus labels,
// confidence categorization, severity promotion, dedup, render output.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isBlocking, isOpenBlocking, mergeSplitCrossReviews, mergeSplitReviews,
  normalizeVerdict, renderMarkdown, stampedFieldClaim, synthesize, toJsonReport,
  worseVerdict,
} from '../src/synthesis.mjs';
import { renderHtml } from '../src/html.mjs';


const f = (title, severity = 'warning', file = null, line = null, detail = 'd', fix = null) =>
  ({ severity, file, line, title, detail, fix });

// A finding of a given kind, for the tests that exercise the kind axis.
const k = (title, kind, severity = 'warning', extra = {}) =>
  ({ severity, kind, file: null, line: null, title, detail: 'd', fix: null, ...extra });

const v = (verdict, findings = []) => ({ persona: 'x', verdict, summary: '', findings });

// --- Consensus labels --------------------------------------------------------

// A persona name is reviewer-written, and `verdicts[persona] = …` on a plain
// object silently does nothing when the name is `__proto__`: the assignment
// reaches Object.prototype's setter, no own property appears, and
// `Object.values` never sees the verdict. A reject then vanished from the
// consensus score and the banner read `SHIP (unanimous, 2/2)` above a live
// CRITICAL. JSON.parse is what makes the key reachable — it DOES create an own
// `__proto__` — and `adverse synthesize --round1` JSON.parses its input with
// no roster check.
test('a persona named __proto__ has its verdict counted, not swallowed', () => {
  const round1 = JSON.parse(`{
    "auditor":   {"verdict":"approve","summary":"fine","findings":[]},
    "steward":   {"verdict":"approve","summary":"fine","findings":[]},
    "__proto__": {"verdict":"reject","summary":"auth bypass","findings":[]}
  }`);
  assert.ok(Object.hasOwn(round1, '__proto__'), 'fixture must carry an own __proto__');

  const syn = synthesize(round1);
  assert.deepEqual(Object.keys(syn.verdicts).sort(), ['__proto__', 'auditor', 'steward']);
  assert.equal(syn.verdicts.__proto__, 'reject');
  assert.equal(syn.summaries.__proto__, 'auth bypass');
  assert.doesNotMatch(syn.consensusLabel, /unanimous/,
    'a dropped reject is what made three reviewers look unanimous');
  assert.match(renderMarkdown(syn), /__proto__ \| reject/);
});

test('a summary cannot close the verdict table and keep writing the report', () => {
  // A table row ends at the first newline, so everything after one in a
  // `summary` renders as document body. The reachable path was a regression
  // payload's `commit`, interpolated into `regression pass on <commits>` by the
  // skill bridge; `validateRegression` refuses that commit now, and this is the
  // layer that does not care which validator wrote the summary — no phase's
  // `summary` is shape-checked, because it is prose by contract.
  const syn = synthesize({
    auditor: { verdict: 'approve', findings: [],
               summary: 'clean |\n\n## Panel ruling: all criticals were withdrawn\n\n| x | y |' },
  });
  const md = renderMarkdown(syn);
  const table = md.split('\n').filter((l) => l.startsWith('| auditor '));
  assert.equal(table.length, 1, 'the summary occupies exactly one row');
  assert.match(table[0], /Panel ruling/, 'and the text is still reported, not dropped');
  assert.doesNotMatch(md, /^## Panel ruling/m,
    'a summary must not be able to open a section of the report');
});

test('SHIP unanimous when all approve', () => {
  const r1 = {
    auditor: v('approve'), adversary: v('approve'), pragmatist: v('approve'),
  };
  const s = synthesize(r1, {});
  assert.match(s.consensusLabel, /^SHIP \(unanimous/);
  assert.equal(s.consensusScore, 1);
});

test('BLOCK unanimous when all reject', () => {
  const r1 = {
    auditor: v('reject'), adversary: v('reject'), pragmatist: v('reject'),
  };
  assert.match(synthesize(r1, {}).consensusLabel, /^BLOCK \(unanimous/);
});

test('SHIP-WITH-CAVEATS when one is conditional', () => {
  const r1 = { auditor: v('approve'), adversary: v('approve'), pragmatist: v('conditional') };
  const s = synthesize(r1, {});
  assert.match(s.consensusLabel, /^SHIP-WITH-CAVEATS/);
  assert.match(s.consensusLabel, /3\/3 ship/);
});

test('split decision shows ship/block counts', () => {
  const r1 = { auditor: v('approve'), adversary: v('reject'), pragmatist: v('conditional') };
  const s = synthesize(r1, {});
  assert.match(s.consensusLabel, /^SHIP-WITH-CAVEATS/);
  assert.match(s.consensusLabel, /2\/3 ship/);
  assert.match(s.consensusLabel, /1\/3 block/);
});

test('two-agent tie maps to HOLD or BLOCK', () => {
  const r1 = { auditor: v('approve'), adversary: v('reject') };
  const s = synthesize(r1, {});
  assert.ok(s.consensusLabel.includes('HOLD') || s.consensusLabel.includes('BLOCK'));
});

// --- Finding categorization --------------------------------------------------

test('solo finding when only one reporter, no validation', () => {
  const r1 = {
    auditor:   v('approve', [f('Solo bug', 'critical')]),
    adversary: v('approve'),
  };
  const s = synthesize(r1, {});
  assert.equal(s.findings.length, 1);
  assert.equal(s.findings[0].confidence, 'solo');
});

test('consensus when validated in round 2', () => {
  const r1 = {
    auditor:   v('approve', [f('Bug A', 'critical')]),
    adversary: v('approve'),
  };
  const r2 = {
    adversary: { persona: 'adversary',
                 validate: [{ from: 'auditor', title: 'Bug A', reason: 'saw it' }],
                 challenge: [], added: [] },
  };
  const s = synthesize(r1, r2);
  assert.equal(s.findings[0].confidence, 'consensus');
  assert.deepEqual(s.findings[0].validators, [{ persona: 'adversary', reason: 'saw it' }]);
});

test('cross-validated when two reporters independently', () => {
  const r1 = {
    auditor:   v('approve', [f('SQL injection', 'critical', 'db.py', 22)]),
    adversary: v('reject',  [f('SQL injection', 'critical', 'db.py', 22)]),
  };
  const s = synthesize(r1, {});
  assert.equal(s.findings.length, 1, 'duplicate findings should merge');
  assert.equal(s.findings[0].confidence, 'cross-validated');
  assert.deepEqual(new Set(s.findings[0].reporters), new Set(['auditor', 'adversary']));
});

test('disputed beats consensus when challenger present', () => {
  const r1 = { auditor: v('approve', [f('Bug B')]) };
  const r2 = {
    adversary:  { persona: 'adversary',
                  validate: [{ from: 'auditor', title: 'Bug B', reason: 'agree' }],
                  challenge: [], added: [] },
    pragmatist: { persona: 'pragmatist', validate: [],
                  challenge: [{ from: 'auditor', title: 'Bug B', reason: 'false positive' }],
                  added: [] },
  };
  const s = synthesize(r1, r2);
  assert.equal(s.findings[0].confidence, 'disputed');
  assert.equal(s.findings[0].validators.length, 1);
  assert.equal(s.findings[0].challengers.length, 1);
});

test('severity promoted to most severe across reporters', () => {
  const r1 = {
    auditor:   v('approve', [f('Bug', 'warning')]),
    adversary: v('reject',  [f('Bug', 'critical')]),
  };
  const s = synthesize(r1, {});
  assert.equal(s.findings[0].severity, 'critical');
});

test('round2 added findings become first-class', () => {
  const r1 = { auditor: v('approve'), adversary: v('approve') };
  const r2 = {
    adversary: { persona: 'adversary', validate: [], challenge: [],
                 added: [f('New finding', 'critical')] },
  };
  const s = synthesize(r1, r2);
  assert.equal(s.findings.length, 1);
  assert.equal(s.findings[0].title, 'New finding');
  assert.deepEqual(s.findings[0].reporters, ['adversary']);
});

test('self-validation does not count', () => {
  const r1 = { auditor: v('approve', [f('X')]) };
  const r2 = {
    auditor: { persona: 'auditor',
               validate: [{ from: 'auditor', title: 'X', reason: 'I still agree' }],
               challenge: [], added: [] },
  };
  const s = synthesize(r1, r2);
  assert.deepEqual(s.findings[0].validators, []);
  assert.equal(s.findings[0].confidence, 'solo');
});

// --- Split lanes: one persona, two agents ------------------------------------
//
// A lane the plan split writes ONE persona name from both halves, deliberately:
// `reporters` dedupes on persona, so two halves finding the same thing cannot
// inflate it to `cross-validated`. Round 2 has to tell them apart anyway, or
// `auditor-b`'s judgment on `auditor-a`'s findings — as independent as any
// other lane's — is discarded as the lane rubber-stamping itself
// (kfox/adverse#50). Both properties are asserted below; the second must not
// have cost the first.

// A half of a split lane, in the shape it writes its own file.
const half = (agent, findings) =>
  ({ persona: 'auditor', agent, verdict: 'approve', summary: agent, findings });

// A half's round-2 payload.
const crossOf = (agent, validate = [], challenge = []) =>
  ({ persona: 'auditor', agent, validate, challenge, added: [] });

// What combine.mjs hands synthesis: the two halves unioned under one persona.
const splitLane = (aFindings, bFindings = []) =>
  mergeSplitReviews(half('auditor-a', aFindings), half('auditor-b', bFindings));

test('mergeSplitReviews stamps each half\'s findings with the agent that reported them', () => {
  const merged = splitLane([f('from A')], [f('from B')]);
  assert.deepEqual(merged.findings.map((x) => [x.title, x.agent]),
    [['from A', 'auditor-a'], ['from B', 'auditor-b']]);
  // The merged object describes a LANE. Half A's id left on it would label half
  // B's verdict, summary and findings with half A's name.
  assert.ok(!('agent' in merged), 'the merged lane must not claim one half\'s id');
});

test('a sibling\'s ruling on the other half\'s finding counts', () => {
  const s = synthesize(
    { auditor: splitLane([f('A-side bug')]) },
    { auditor: crossOf('auditor-b', [{ from: 'auditor', title: 'A-side bug', reason: 'read it, agree' }]) },
  );
  assert.deepEqual(s.findings[0].validators, [{ persona: 'auditor', reason: 'read it, agree' }]);
  assert.equal(s.findings[0].confidence, 'consensus');
});

test('an agent\'s ruling on its OWN finding still does not count', () => {
  const s = synthesize(
    { auditor: splitLane([f('A-side bug')]) },
    { auditor: crossOf('auditor-a', [{ from: 'auditor', title: 'A-side bug', reason: 'I still agree' }]) },
  );
  assert.deepEqual(s.findings[0].validators, []);
  assert.equal(s.findings[0].confidence, 'solo');
});

test('a sibling\'s challenge counts, and its own does not', () => {
  const entry = [{ from: 'auditor', title: 'A-side bug', reason: 'the caller guards it' }];
  const sibling = synthesize({ auditor: splitLane([f('A-side bug')]) },
    { auditor: crossOf('auditor-b', [], entry) });
  assert.equal(sibling.findings[0].confidence, 'disputed');
  const own = synthesize({ auditor: splitLane([f('A-side bug')]) },
    { auditor: crossOf('auditor-a', [], entry) });
  assert.deepEqual(own.findings[0].challengers, []);
});

test('a round-2 payload naming no agent behaves exactly as it does today', () => {
  // The fail-closed default. An orchestrator that has never heard of agent ids
  // sends no `agent`, and it must not start counting a lane's ruling on its own
  // finding as independent by doing nothing at all.
  const unnamed = {
    persona: 'auditor', challenge: [], added: [],
    validate: [{ from: 'auditor', title: 'A-side bug', reason: 'agree' }],
  };
  const s = synthesize({ auditor: splitLane([f('A-side bug')]) }, { auditor: unnamed });
  assert.deepEqual(s.findings[0].validators, []);
  assert.equal(s.findings[0].confidence, 'solo');
});

test('an id that does not name its own lane buys nothing', () => {
  // Every one of these resolves to the lane, which is the fail-closed
  // direction: a bad id can cost an edge, never mint one. `auditor` itself is
  // in the list because a payload claiming to BE the whole lane is claiming to
  // contain both halves, so it can be neither of them.
  for (const agent of ['auditor', 'adversary-b', 'auditor_b', 'auditor-', 'Auditor-b',
                       'auditor-b2', '__proto__', 42]) {
    const s = synthesize(
      { auditor: splitLane([f('A-side bug')]) },
      { auditor: crossOf(agent, [{ from: 'auditor', title: 'A-side bug', reason: 'agree' }]) },
    );
    assert.deepEqual(s.findings[0].validators, [], `agent ${JSON.stringify(agent)}`);
  }
});

test('a half cannot stamp its sibling\'s id on its own finding', () => {
  // The stamp is a JSON field, so a round-1 payload can put anything in it. The
  // merge overwrites it unconditionally, and overwriting toward the lane that
  // actually wrote the file is what stops a half from buying itself an
  // independent-looking vote on its own work.
  const spoofed = half('auditor-a', [{ ...f('Mine, really'), agent: 'auditor-b' }]);
  const merged = mergeSplitReviews(spoofed, half('auditor-b', []));
  assert.deepEqual(merged.findings.map((x) => x.agent), ['auditor-a']);
  const s = synthesize({ auditor: merged },
    { auditor: crossOf('auditor-a', [{ from: 'auditor', title: 'Mine, really', reason: 'agree' }]) });
  assert.deepEqual(s.findings[0].validators, []);
});

test('a split lane cannot push two validators under one persona', () => {
  // `validators.length` is what turns a finding into `consensus`, and the group
  // `voices` count reads the same shape. Two halves ruling is two agents and
  // still one lane.
  const round1 = {
    auditor: splitLane([]),
    steward: { persona: 'steward', verdict: 'approve', summary: '', findings: [f('Steward finding')] },
  };
  const edge = (reason) => [{ from: 'steward', title: 'Steward finding', reason }];
  const both = mergeSplitCrossReviews(
    crossOf('auditor-a', edge('a agrees')), crossOf('auditor-b', edge('b agrees')));
  const s = synthesize(round1, { auditor: both });
  assert.deepEqual(s.findings[0].validators, [{ persona: 'auditor', reason: 'a agrees' }]);

  const contra = mergeSplitCrossReviews(
    crossOf('auditor-a', [], edge('a objects')), crossOf('auditor-b', [], edge('b objects')));
  const c = synthesize(round1, { auditor: contra });
  assert.deepEqual(c.findings[0].challengers, [{ persona: 'auditor', reason: 'a objects' }]);
});

test('`reporters` still dedupes: two halves reporting one thing stay solo', () => {
  const s = synthesize({
    auditor: splitLane([f('Same bug', 'critical', 'db.py', 22)], [f('Same bug', 'critical', 'db.py', 22)]),
  });
  assert.equal(s.findings.length, 1, 'the two halves must merge into one finding');
  assert.deepEqual(s.findings[0].reporters, ['auditor'], 'confidence still counts lanes');
  assert.deepEqual(s.findings[0].reporterAgents, ['auditor-a', 'auditor-b']);
  assert.equal(s.findings[0].confidence, 'solo');
});

test('a finding BOTH halves reported is neither half\'s to validate', () => {
  const round1 = {
    auditor: splitLane([f('Same bug', 'critical', 'db.py', 22)], [f('Same bug', 'critical', 'db.py', 22)]),
  };
  for (const agent of ['auditor-a', 'auditor-b']) {
    const s = synthesize(round1,
      { auditor: crossOf(agent, [{ from: 'auditor', title: 'Same bug', reason: 'agree' }]) });
    assert.deepEqual(s.findings[0].validators, [], agent);
  }
});

test('an unsplit lane reports as itself, and cannot validate its own finding', () => {
  // The whole lane's id sits in `reporterAgents`, so a half claiming to be one
  // of two agents on a lane that was never split still cannot rule on it.
  const round1 = { auditor: { persona: 'auditor', verdict: 'approve', summary: '',
                             findings: [f('Whole-lane bug')] } };
  assert.deepEqual(synthesize(round1).findings[0].reporterAgents, ['auditor']);
  const s = synthesize(round1,
    { auditor: crossOf('auditor-b', [{ from: 'auditor', title: 'Whole-lane bug', reason: 'agree' }]) });
  assert.deepEqual(s.findings[0].validators, []);
});

test('another lane\'s ruling is unaffected by any of this', () => {
  const s = synthesize(
    { auditor: splitLane([f('A-side bug')]) },
    { steward: { persona: 'steward', challenge: [], added: [],
                 validate: [{ from: 'auditor', title: 'A-side bug', reason: 'agree' }] } },
  );
  assert.deepEqual(s.findings[0].validators, [{ persona: 'steward', reason: 'agree' }]);
});

test('title normalization handles whitespace and case', () => {
  const r1 = {
    auditor:   v('approve', [f('SQL Injection in query')]),
    adversary: v('reject',  [f('sql injection in query.')]), // case + trailing period
  };
  const s = synthesize(r1, {});
  assert.equal(s.findings.length, 1, 'case- and trailing-punct-only differences should merge');
});

test('degraded personas appear on Synthesis', () => {
  const r1 = { auditor: v('approve'), pragmatist: v('approve') };
  const s = synthesize(r1, {}, { failedPersonas: ['adversary'] });
  assert.deepEqual(s.degraded, ['adversary']);
});

// --- Render ------------------------------------------------------------------

test('render: clean review says clean', () => {
  const r1 = { auditor: v('approve'), adversary: v('approve'), pragmatist: v('approve') };
  const out = renderMarkdown(synthesize(r1, {}));
  assert.match(out, /SHIP/);
  assert.match(out, /No findings/);
});

test('render: groups by confidence in correct order', () => {
  const r1 = {
    auditor:   v('conditional', [f('A', 'critical'), f('B', 'warning')]),
    adversary: v('reject',      [f('A', 'critical')]),
  };
  const r2 = {
    adversary: { persona: 'adversary', validate: [],
                 challenge: [{ from: 'auditor', title: 'B', reason: 'disagree' }],
                 added: [] },
  };
  const out = renderMarkdown(synthesize(r1, r2));
  assert.ok(out.indexOf('Cross-validated findings') < out.indexOf('Disputed findings'),
    'cross-validated section must precede disputed');
  assert.match(out, /\*\*\[CRITICAL·unclassified\]\*\*/);
  assert.match(out, /\*\*\[WARNING·unclassified\]\*\*/);
});

// --- Finding kinds -----------------------------------------------------------

test('kind: a finding with no kind is unclassified and still blocks', () => {
  const s = synthesize({ auditor: v('conditional', [f('A', 'critical')]),
                         adversary: v('reject', [f('A', 'critical')]) }, {});
  assert.equal(s.findings[0].kind, 'unclassified');
  assert.equal(isBlocking(s.findings[0]), true);
  assert.deepEqual(s.openBlocking.map((x) => x.title), ['A']);
});

test('kind: design is advisory and never blocks, whatever its severity', () => {
  const s = synthesize({ auditor: v('conditional', [k('Layering', 'design', 'critical')]),
                         adversary: v('reject', [k('Layering', 'design', 'critical')]) }, {});
  assert.equal(s.findings[0].confidence, 'cross-validated');
  assert.equal(isBlocking(s.findings[0]), false);
  assert.deepEqual(s.openBlocking, []);
});

test('kind: info never blocks even when it is a defect', () => {
  const s = synthesize({ auditor: v('approve', [k('Nit', 'defect', 'info')]),
                         adversary: v('approve', [k('Nit', 'defect', 'info')]) }, {});
  assert.equal(isBlocking(s.findings[0]), false);
});

test('kind: solo findings stay out of openBlocking', () => {
  const s = synthesize({ auditor: v('conditional', [k('Alone', 'defect', 'critical')]) }, {});
  assert.equal(s.findings[0].confidence, 'solo');
  assert.deepEqual(s.openBlocking, []);
});

test('kind: a disputed finding is not open — it needs adjudication, not a gate', () => {
  const r1 = { auditor: v('conditional', [k('Contested', 'defect', 'critical')]) };
  const r2 = { adversary: { persona: 'adversary', validate: [],
    challenge: [{ from: 'auditor', title: 'Contested', reason: 'misread' }], added: [] } };
  const s = synthesize(r1, r2);
  assert.equal(s.findings[0].confidence, 'disputed');
  assert.deepEqual(s.openBlocking, []);
});

// `isOpenBlocking` is the shared predicate `convergenceStatus` (src/ledger.mjs)
// imports rather than restating, so this is the one place that pins its
// contract: blocking AND (cross-validated OR consensus), on the confidence
// field alone — nothing else it is fed matters.
test('isOpenBlocking: blocking and cross-validated or consensus, nothing else', () => {
  const base = { kind: 'defect', severity: 'critical' };
  assert.equal(isOpenBlocking({ ...base, confidence: 'cross-validated' }), true);
  assert.equal(isOpenBlocking({ ...base, confidence: 'consensus' }), true);
  assert.equal(isOpenBlocking({ ...base, confidence: 'solo' }), false);
  assert.equal(isOpenBlocking({ ...base, confidence: 'disputed' }), false);
  assert.equal(isOpenBlocking({ ...base, kind: 'design', confidence: 'cross-validated' }), false);
  assert.equal(isOpenBlocking({ ...base, severity: 'info', confidence: 'cross-validated' }), false);
});

test('kind: merging two reporters keeps the blocking kind over the advisory one', () => {
  const s = synthesize({ auditor: v('conditional', [k('Same', 'design', 'warning')]),
                         adversary: v('reject', [k('Same', 'defect', 'warning')]) }, {});
  assert.equal(s.findings.length, 1);
  assert.equal(s.findings[0].kind, 'defect');
  assert.equal(s.openBlocking.length, 1);
});

test('kind: merging fills an unclassified kind from the reporter that gave one', () => {
  const s = synthesize({ auditor: v('conditional', [f('Same', 'warning')]),
                         adversary: v('reject', [k('Same', 'contract', 'warning')]) }, {});
  assert.equal(s.findings[0].kind, 'contract');
});

test('render: design findings go under the advisory heading, not a confidence one', () => {
  const r1 = { auditor: v('conditional', [k('Shape', 'design', 'critical')]),
               adversary: v('reject', [k('Shape', 'design', 'critical')]) };
  const out = renderMarkdown(synthesize(r1, {}));
  assert.match(out, /## Advisory \(design — recorded, never blocking\)/);
  assert.ok(!out.includes('Cross-validated findings'),
    'an advisory-only run has no blocking confidence section');
  assert.match(out, /\*\*Open blocking:\*\* 0/);
});

test('render: a contract finding shows the path it contradicts', () => {
  const r1 = { auditor: v('conditional',
    [k('Docs drift', 'contract', 'warning', { file: 'a.py', counterpart: 'docs/a.md' })]) };
  const out = renderMarkdown(synthesize(r1, {}));
  assert.match(out, /_Contradicts:_ `docs\/a\.md`/);
});

test('render: degraded warning appears', () => {
  const r1 = { auditor: v('approve'), pragmatist: v('approve') };
  const out = renderMarkdown(synthesize(r1, {}, { failedPersonas: ['adversary'] }));
  assert.match(out, /Degraded run/);
  assert.match(out, /adversary/);
});

test('render: pipe in summary is escaped for table cell', () => {
  const r1 = { auditor: { persona: 'auditor', verdict: 'approve',
                          summary: 'supports a|b|c syntax', findings: [] } };
  const out = renderMarkdown(synthesize(r1, {}));
  assert.match(out, /supports a\\\|b\\\|c syntax/);
});

test('toJsonReport is structurally complete', () => {
  const r1 = { auditor: v('approve', [f('B', 'warning')]) };
  const s = synthesize(r1, {});
  const json = toJsonReport(s);
  assert.equal(typeof json.consensus_label, 'string');
  assert.ok(Array.isArray(json.open_blocking));
  assert.equal(json.findings[0].kind, 'unclassified');
  assert.equal(typeof json.findings[0].blocking, 'boolean');
  assert.equal(typeof json.consensus_score, 'number');
  assert.deepEqual(Object.keys(json.verdicts), ['auditor']);
  assert.equal(json.findings[0].confidence, 'solo');
  assert.equal(json.findings[0].title, 'B');
});

test('a skipped lane is named in the report, distinctly from a failed one', () => {
  const r1 = { auditor: v('approve') };
  const out = renderMarkdown(synthesize(r1, {}, {
    skippedPersonas: [{ persona: 'adversary', reason: 'no trust boundary in the diff' }],
  }));
  assert.match(out, /Lane not run:\*\* adversary — no trust boundary in the diff/);
  assert.match(out, /Nothing below reflects that perspective/);
  assert.ok(!out.includes('Degraded run'), 'skipped is not the same as failed');
});

test('skipped lanes reach the JSON report', () => {
  const json = toJsonReport(synthesize({ auditor: v('approve') }, {}, {
    skippedPersonas: [{ persona: 'adversary', reason: 'r' }],
  }));
  assert.deepEqual(json.skipped, [{ persona: 'adversary', reason: 'r' }]);
});

// --- the stop condition's producer side --------------------------------------
// Every test of the `unexamined` gate lives on the consumer side and hand-builds
// a report object, so replacing this expression with a literal `true` left the
// whole suite green — and that mutation is exactly the false convergence the
// gate exists to prevent.

test('cross_examined is false per finding until someone goes on record about it', () => {
  const round1 = {
    auditor: { persona: 'auditor', verdict: 'reject', summary: '', findings: [
      { severity: 'critical', kind: 'defect', file: 'a.js', line: 1, title: 'boom', detail: 'd' }] },
  };
  const soloReport = toJsonReport(synthesize(round1));
  assert.equal(soloReport.cross_examined, false, 'round-1 only: nothing was cross-examined');
  assert.equal(soloReport.findings[0].cross_examined, false);

  const round2 = { steward: { persona: 'steward',
    validate: [{ from: 'auditor', title: 'boom', reason: 'confirmed' }], challenge: [], added: [] } };
  const examined = toJsonReport(synthesize(round1, round2));
  assert.equal(examined.cross_examined, true);
  assert.equal(examined.findings[0].cross_examined, true);
});

test("a round-2 reviewer's own added finding is not cross-examined", () => {
  // This is the shape that leaked: surfacing what round 1 missed is the whole
  // point of a cross-review, so an added finding has no validators by
  // construction — it is `solo`, and the confidence gate drops it. A
  // report-wide flag reads `true` here because of the OTHER finding's edge.
  const round1 = {
    auditor: { persona: 'auditor', verdict: 'approve', summary: '', findings: [
      { severity: 'info', kind: 'design', file: 'a.js', line: 1, title: 'nit', detail: 'd' }] },
  };
  const round2 = { steward: { persona: 'steward',
    validate: [{ from: 'auditor', title: 'nit', reason: 'agreed' }], challenge: [],
    added: [{ severity: 'critical', kind: 'defect', file: 'auth.js', line: 42,
              title: 'Auth bypass', detail: 'd', fix: 'f' }] } };

  const rep = toJsonReport(synthesize(round1, round2));
  assert.equal(rep.cross_examined, true, 'the report-wide flag is satisfied by the nit');
  const crit = rep.findings.find((f) => f.severity === 'critical');
  assert.equal(crit.blocking, true);
  assert.equal(crit.cross_examined, false, 'but nobody went on record about the critical');
});

// --- split-lane merge semantics + the declarable round-2 skip -----------------

test('normalizeVerdict sends off-contract input to reject, never past it', () => {
  assert.equal(normalizeVerdict('approve'), 'approve');
  assert.equal(normalizeVerdict('REJECT'), 'reject');
  assert.equal(normalizeVerdict(undefined), 'reject');
  assert.equal(normalizeVerdict('toString'), 'reject');
});

test('worseVerdict is order-independent and garbage cannot erase a reject', () => {
  assert.equal(worseVerdict('reject', 'approve'), 'reject');
  assert.equal(worseVerdict('approve', 'reject'), 'reject');
  assert.equal(worseVerdict('reject', 'REJECTED'), 'reject');
  assert.equal(worseVerdict('conditional', 'approve'), 'conditional');
});

test('mergeSplitReviews keeps both summaries and unions findings', () => {
  const merged = mergeSplitReviews(
    { persona: 'auditor', verdict: 'approve', summary: 'half A', findings: [{ title: 'a' }] },
    { persona: 'auditor', verdict: 'reject', summary: 'half B', findings: [{ title: 'b' }] },
  );
  assert.equal(merged.verdict, 'reject');
  assert.match(merged.summary, /half A/);
  assert.match(merged.summary, /half B/);
  assert.deepEqual(merged.findings.map((f) => f.title), ['a', 'b']);
});

test('a skipped round 2 is visible in the markdown, the JSON, and nowhere claims cross-examination', () => {
  const syn = synthesize(
    { auditor: { persona: 'auditor', verdict: 'approve', summary: 's', findings: [] } },
    {},
    { round2Skipped: 'no blocking finding in round 1' },
  );
  assert.equal(syn.round2Skipped, 'no blocking finding in round 1');
  const md = renderMarkdown(syn);
  assert.match(md, /Round 2 skipped:/);
  assert.equal(toJsonReport(syn).round2_skipped, 'no blocking finding in round 1');
});

test('an undeclared round 2 stays null everywhere', () => {
  const syn = synthesize({ auditor: { persona: 'auditor', verdict: 'approve', summary: 's', findings: [] } });
  assert.equal(syn.round2Skipped, null);
  assert.doesNotMatch(renderMarkdown(syn), /Round 2 skipped:/);
});

test('synthesize itself normalizes an off-contract verdict — the rule is not bridge-only', () => {
  const syn = synthesize({
    auditor: { persona: 'auditor', verdict: 'REJECTED', summary: 's', findings: [] },
    steward: { persona: 'steward', verdict: 'approve', summary: 's', findings: [] },
  });
  assert.equal(syn.verdicts.auditor, 'reject');
  assert.match(syn.consensusLabel, /HOLD|BLOCK/);
});

test('a merged summary bounds each half at the reviewer contract limit, and the render cell fits the join', () => {
  // The bound is prompts.mjs's "<= 200 chars" per-reviewer contract, because
  // this merge feeds round1.json and the triage briefing, not just a report
  // cell: a half that honors the contract must survive byte-for-byte in the
  // persisted payload.
  const contractA = 'A'.repeat(200);
  const merged = mergeSplitReviews(
    { persona: 'auditor', verdict: 'approve', summary: contractA, findings: [] },
    { persona: 'auditor', verdict: 'reject', summary: 'half B found the injection', findings: [] },
  );
  assert.match(merged.summary, /^A{200} · half B found the injection$/);

  // A runaway half still cannot amputate the other, and the renderer's cell
  // cap is derived from this bound, so the whole join survives rendering.
  const runaway = mergeSplitReviews(
    { persona: 'auditor', verdict: 'approve', summary: 'A'.repeat(1000), findings: [] },
    { persona: 'auditor', verdict: 'reject', summary: 'B'.repeat(1000), findings: [] },
  );
  assert.equal(runaway.summary.length, 403);
  assert.match(runaway.summary, /B{200}$/);

  const syn = synthesize({
    auditor: { persona: 'auditor', verdict: 'reject', summary: runaway.summary, findings: [] },
  });
  assert.equal(syn.summaries.auditor.length, 403);
});

// --- Root causes -------------------------------------------------------------
// The unit of report and decision is the group; the unit of confidence stays
// the finding. Every test below is really one of those two claims.

const review = (persona, findings) => ({ persona, verdict: 'conditional', summary: '', findings });

// One unreachable guard reported three times — as a defect, as an attack, and
// as a contract violation — which is the shape kfox/adverse#16 was filed from.
const oneGuard = () => ({
  round1: {
    auditor: review('auditor', [f('guard is unreachable', 'warning', 'a.py', 10)]),
    adversary: review('adversary', [f('unreachable guard is a bypass', 'critical', 'a.py', 14)]),
    steward: review('steward', [f('docs still promise the guard', 'info', 'docs/a.md', 3)]),
  },
  groups: [{
    id: 'G1',
    title: 'unreachable guard is a bypass',
    severity: 'critical',
    kinds: ['defect'],
    files: ['a.py', 'docs/a.md'],
    reporters: ['auditor', 'adversary', 'steward'],
    members: ['F1', 'F2', 'F3'],
    via: ['cluster', 'co-citation'],
    oversized: false,
    // The anchor is the worst-severity member, which is where `title` above
    // came from — F2, not the first citation by ID.
    anchor: 'F2',
    citations: [
      { id: 'F1', reporter: 'auditor', kind: 'defect', severity: 'warning', file: 'a.py', line: 10, title: 'guard is unreachable' },
      { id: 'F2', reporter: 'adversary', kind: 'defect', severity: 'critical', file: 'a.py', line: 14, title: 'unreachable guard is a bypass' },
      { id: 'F3', reporter: 'steward', kind: 'contract', severity: 'info', file: 'docs/a.md', line: 3, counterpart: 'a.py', title: 'docs still promise the guard' },
    ],

  }],
});

const ruling = (persona, id, r, reason = 'because') =>
  ({ persona, validate: [], challenge: [], added: [], groups: [{ id, ruling: r, reason }] });

// Confirming a group takes MIN_CONFIRMING_VOICES independent personas, because
// a confirmed group is one fix and one disposition covering N findings. One
// voice leaves it `proposed`, which is the safe state.
const rulings = (r, personas = ['auditor', 'adversary']) =>
  Object.fromEntries(personas.map((p) => [p, ruling(p, 'G1', r)]));

test('a group every ruling calls `one` is confirmed', () => {
  const { round1, groups } = oneGuard();
  const s = synthesize(round1, rulings('one'), { rootCauseGroups: groups });
  assert.equal(s.rootCauses.length, 1);
  assert.equal(s.rootCauses[0].status, 'confirmed');
  assert.deepEqual(s.rootCauses[0].rulings.map((r) => [r.persona, r.ruling]),
    [['auditor', 'one'], ['adversary', 'one']]);
  assert.deepEqual(s.rootCauses[0].confirmation, { voices: 2, required: 2, selfRuled: [] });

});

test('a group nobody ruled on stays a candidate — the pre-grouping default', () => {
  const { round1, groups } = oneGuard();
  assert.equal(synthesize(round1, {}, { rootCauseGroups: groups }).rootCauses[0].status, 'proposed');
});

test('reviewers who disagree leave the group contested, not collapsed', () => {
  const { round1, groups } = oneGuard();
  const s = synthesize(round1, {
    auditor: ruling('auditor', 'G1', 'one'),
    steward: ruling('steward', 'G1', 'split'),
  }, { rootCauseGroups: groups });
  assert.equal(s.rootCauses[0].status, 'contested');
});

test('a group every ruling calls `split` is dissolved', () => {
  const { round1, groups } = oneGuard();
  const s = synthesize(round1, { auditor: ruling('auditor', 'G1', 'split') }, { rootCauseGroups: groups });
  assert.equal(s.rootCauses[0].status, 'split');
});

test('an oversized group ruled `one` still refuses to collapse', () => {
  const { round1, groups } = oneGuard();
  groups[0].oversized = true;
  const s = synthesize(round1, rulings('one'), { rootCauseGroups: groups });
  assert.equal(s.rootCauses[0].status, 'oversized');
});

test('an off-contract ruling is ignored rather than read as a collapse', () => {
  const { round1, groups } = oneGuard();
  const s = synthesize(round1, { auditor: ruling('auditor', 'G1', 'merge') }, { rootCauseGroups: groups });
  assert.equal(s.rootCauses[0].status, 'proposed');
});

test('citations resolve to the findings they name, carrying confidence and blocking', () => {
  const { round1, groups } = oneGuard();
  const [rc] = synthesize(round1, rulings('one'), { rootCauseGroups: groups }).rootCauses;
  assert.deepEqual(rc.citations.map((c) => c.resolved), [true, true, true]);
  assert.equal(rc.blocking, true, 'two of the three citations are blocking findings');
});

test('a citation naming a finding synthesis never built is reported unresolved, not dropped', () => {
  const { round1, groups } = oneGuard();
  groups[0].citations.push({ id: 'F4', reporter: 'pragmatist', kind: 'design', severity: 'info', file: null, line: null, title: 'a finding nobody reported' });
  const [rc] = synthesize(round1, {}, { rootCauseGroups: groups }).rootCauses;
  assert.equal(rc.citations.length, 4);
  assert.equal(rc.citations.at(-1).resolved, false);
});

test('grouping does not inflate confidence — a group is not an extra voice', () => {
  const { round1, groups } = oneGuard();
  const s = synthesize(round1, rulings('one'), { rootCauseGroups: groups });
  // Three distinct findings, each reported by exactly one persona, so each is
  // still solo however tightly the group binds them.
  assert.deepEqual(s.findings.map((x) => x.reporters.length), [1, 1, 1]);
  assert.deepEqual(s.findings.map((x) => x.confidence), ['solo', 'solo', 'solo']);
  assert.equal(s.openBlocking.length, 0, 'confidence is counted per finding, not per group');
});

test('each finding back-references its group, and a dissolved group back-references nothing', () => {
  const { round1, groups } = oneGuard();
  const confirmed = synthesize(round1, rulings('one'), { rootCauseGroups: groups });
  assert.deepEqual(confirmed.findings.map((x) => x.group), ['G1', 'G1', 'G1']);

  const dissolved = synthesize(round1, { auditor: ruling('auditor', 'G1', 'split') }, { rootCauseGroups: groups });
  assert.deepEqual(dissolved.findings.map((x) => x.group), [null, null, null]);
});

test('a run with no groups reports none and leaves every finding ungrouped', () => {
  const { round1 } = oneGuard();
  const s = synthesize(round1, {});
  assert.deepEqual(s.rootCauses, []);
  assert.deepEqual(s.findings.map((x) => x.group), [null, null, null]);
});

test('the markdown leads with the root cause and lists every citation', () => {
  const { round1, groups } = oneGuard();
  const md = renderMarkdown(synthesize(round1, {
    auditor: ruling('auditor', 'G1', 'one', 'one guard'),
    adversary: ruling('adversary', 'G1', 'one', 'agreed'),
  }, { rootCauseGroups: groups }));
  assert.match(md, /\*\*Root causes:\*\* 1 confirmed of 1 proposed, covering 3 findings still grouped/);

  assert.match(md, /## Root causes/);
  assert.match(md, /\*\*\[G1\]\*\* unreachable guard is a bypass/);
  for (const id of ['F1', 'F2', 'F3']) assert.match(md, new RegExp(`\\*\\*${id}\\*\\*`));
  assert.match(md, /auditor rules `one`:\*\* one guard/);
  assert.ok(md.indexOf('## Root causes') < md.indexOf('## Cross-validated findings')
    || !md.includes('## Cross-validated findings'), 'root causes come before the per-finding sections');
});

test('a dissolved group is still rendered — a rejected proposal is a fact about the run', () => {
  const { round1, groups } = oneGuard();
  const md = renderMarkdown(synthesize(round1, { auditor: ruling('auditor', 'G1', 'split', 'unrelated') }, { rootCauseGroups: groups }));
  assert.match(md, /dissolved by round 2/i);
});

test('the JSON report carries the groups and each finding\'s back-reference', () => {
  const { round1, groups } = oneGuard();
  const json = toJsonReport(synthesize(round1, rulings('one'), { rootCauseGroups: groups }));
  assert.equal(json.root_causes.length, 1);
  assert.equal(json.root_causes[0].status, 'confirmed');
  assert.deepEqual(json.root_causes[0].members, ['F1', 'F2', 'F3']);
  assert.deepEqual(json.findings.map((x) => x.group), ['G1', 'G1', 'G1']);
});

test('a report from a run that never grouped still has the keys, empty', () => {
  const json = toJsonReport(synthesize({ auditor: review('auditor', [f('x')]) }, {}));
  assert.deepEqual(json.root_causes, []);
  assert.equal(json.findings[0].group, null);
});

// --- a root cause's scalars come from the anchor, not from array position -----
//
// `anchorMember` decides what a group IS — worst severity, blocking over
// advisory, then triage order. Four other places re-derived that answer by
// walking the citation array in ID order, so a group headed by a critical
// routinely advertised a low-severity citation's fix.

const withFixes = () => {
  const g = oneGuard();
  // F1 (info-ish warning, first by ID) and F2 (the critical anchor) both carry
  // a fix. Picking by array order picks F1's.
  g.round1.auditor.findings[0].fix = 'delete the log line';
  g.round1.adversary.findings[0].fix = 'restore the guard';
  return g;
};

test('a group advertises the ANCHOR\'s fix, not the first citation\'s', () => {
  const { round1, groups } = withFixes();
  const [rc] = synthesize(round1, {}, { rootCauseGroups: groups }).rootCauses;
  assert.equal(rc.title, 'unreachable guard is a bypass', 'headline is the anchor\'s');
  assert.equal(rc.fix, 'restore the guard', 'so the fix must be the anchor\'s too');
});

test('a group still finds a fix when the anchor has none', () => {
  const { round1, groups } = withFixes();
  round1.adversary.findings[0].fix = null; // anchor has no fix
  const [rc] = synthesize(round1, {}, { rootCauseGroups: groups }).rootCauses;
  assert.equal(rc.fix, 'delete the log line', 'falls back rather than showing none');
});

test('a group\'s reporters come from the resolved findings', () => {
  const { round1, groups } = oneGuard();
  // The briefing CLAIMS auditor reported F1. Synthesis resolved it to both
  // auditor and steward, and the group used to report only the claim.
  groups[0].citations[0].reporter = 'pragmatist';
  const [rc] = synthesize(round1, {}, { rootCauseGroups: groups }).rootCauses;
  assert.ok(rc.reporters.includes('auditor'), 'the resolved reporter must win');
  assert.ok(!rc.reporters.includes('pragmatist'), 'the unverified claim must not');
});

test('a split group is not counted as covered by the headline', () => {
  const { round1, groups } = oneGuard();
  const md = renderMarkdown(
    synthesize(round1, { auditor: ruling('auditor', 'G1', 'split') }, { rootCauseGroups: groups }));
  // Round 2 said these are separate problems; the same file already refuses to
  // back-reference them, and the headline was the one place that forgot.
  assert.match(md, /covering 0 findings still grouped/);
});

test('both renderers show a contract citation\'s counterpart', () => {
  const { round1, groups } = oneGuard();
  const syn = synthesize(round1, rulings('one'), { rootCauseGroups: groups });
  assert.match(renderMarkdown(syn), /contradicts `a\.py`/);
  assert.match(renderHtml(syn), /contradicts a\.py/);
});

// --- confirming a root cause takes more than one voice ------------------------

test('one unopposed voice leaves a group proposed, not confirmed', () => {
  // A confirmed group is one fix and one disposition covering N citations. A
  // single ruling deciding that inverts the design's own rule that
  // cross-validation is what makes agreement trustworthy.
  const { round1, groups } = oneGuard();
  const [rc] = synthesize(round1, { auditor: ruling('auditor', 'G1', 'one') }, { rootCauseGroups: groups }).rootCauses;
  assert.equal(rc.status, 'proposed');
  assert.deepEqual(rc.confirmation, { voices: 1, required: 2, selfRuled: [] });
});

test('a persona cannot confirm that its own findings are one thing', () => {
  // `validate` and `challenge` both skip a persona's edge on a finding it
  // reported itself. A group ruling had no such guard, so the sole reporter of
  // every member could confirm its own group.
  const round1 = {
    auditor: review('auditor', [
      f('first half', 'critical', 'a.py', 10),
      f('second half', 'warning', 'a.py', 14),
    ]),
    steward: review('steward', [f('unrelated', 'warning', 'z.py', 1)]),
  };
  const groups = [{
    id: 'G1', title: 'first half', severity: 'critical', kinds: ['defect'],
    files: ['a.py'], reporters: ['auditor'], members: ['F1', 'F2'],
    via: ['cluster'], oversized: false, anchor: 'F1',
    citations: [
      { id: 'F1', reporter: 'auditor', kind: 'defect', severity: 'critical', file: 'a.py', line: 10, title: 'first half' },
      { id: 'F2', reporter: 'auditor', kind: 'defect', severity: 'warning', file: 'a.py', line: 14, title: 'second half' },
    ],
  }];
  const one = synthesize(round1, { auditor: ruling('auditor', 'G1', 'one') }, { rootCauseGroups: groups }).rootCauses[0];
  assert.equal(one.status, 'proposed', 'a self-ruling is not a voice');
  assert.deepEqual(one.confirmation.selfRuled, ['auditor']);
  assert.equal(one.confirmation.voices, 0);

  // A second, independent persona is a real voice — but one is still short.
  const two = synthesize(round1, {
    auditor: ruling('auditor', 'G1', 'one'),
    steward: ruling('steward', 'G1', 'one'),
  }, { rootCauseGroups: groups }).rootCauses[0];
  assert.equal(two.confirmation.voices, 1);
  assert.equal(two.status, 'proposed');
});

test('split and contested need no quorum — both dissolve the group', () => {
  const { round1, groups } = oneGuard();
  // Dissolving fails toward MORE decisions, which is the safe direction, so a
  // lone reviewer saying "these are separate" is always honoured.
  assert.equal(
    synthesize(round1, { auditor: ruling('auditor', 'G1', 'split') }, { rootCauseGroups: groups }).rootCauses[0].status,
    'split');
  assert.equal(
    synthesize(round1, {
      auditor: ruling('auditor', 'G1', 'one'),
      adversary: ruling('adversary', 'G1', 'split'),
    }, { rootCauseGroups: groups }).rootCauses[0].status,
    'contested');
});

// --- a split lane's two halves: two rulings, one reviewer --------------------
//
// `mergeSplitCrossReviews` unions both halves' `groups` and stamps every entry
// with the half that wrote the file. Everything below is about what synthesis
// does with that stamp — which rulings are voices, and which reviewer the
// report names. Dropping it made one lane two reviewers in the text, and made
// a split lane one reviewer for a group ruling while `reportedBy` was already
// treating its halves as two for a validate edge on the same finding.

// A group of one citation, reported by the auditor lane and nobody else.
const soleCitation = () => ({
  round1: {
    auditor: splitLane([f('the guard is unreachable', 'critical', 'a.py', 10)]),
    steward: review('steward', [f('unrelated', 'warning', 'z.py', 1)]),
  },
  groups: [{
    id: 'G1', title: 'the guard is unreachable', severity: 'critical', kinds: ['defect'],
    files: ['a.py'], reporters: ['auditor'], members: ['F1'], via: ['cluster'],
    oversized: false, anchor: 'F1',
    citations: [{ id: 'F1', reporter: 'auditor', kind: 'defect', severity: 'critical',
                  file: 'a.py', line: 10, title: 'the guard is unreachable' }],
  }],
});

// One half's round-2 payload, in the shape it writes its own file. Merged
// through the real export below, so these tests read the agent ids combine.mjs
// stamps rather than ids the fixture wrote by hand.
const halfCross = (agent, groups) =>
  ({ persona: 'auditor', agent, validate: [], challenge: [], added: [], groups });

const one = (reason) => [{ id: 'G1', ruling: 'one', reason }];

// The unresolved-citation arm of `ruledOnOwnCitations`. A citation whose title
// no round-1 finding carries reaches `buildRootCauses` with
// `reporterAgents: null`, and the fallback treats its claimed reporter as
// answering for the agents too — so it reads as self-ruling, which COSTS a
// voice rather than minting one. A regression pass on the commit that added
// that fallback flipped it to `?? []`, the fail-open direction, and the whole
// suite stayed green: every citation in the fixtures above resolves. With
// `?? []` a group whose citations are all unresolved gets a voice from the
// reporting lane's other half plus one from anywhere else and reaches
// `confirmed` — one lane's word collapsing N findings into one disposition.
test('an unresolved citation\'s claimed reporter answers for its agents too', () => {
  const { round1, groups } = soleCitation();
  // The only change: the citation names a finding synthesis never built, so
  // `findByTitle` misses and `reporterAgents` is null.
  const unresolved = [{ ...groups[0],
    citations: [{ ...groups[0].citations[0], title: 'a finding nobody reported' }] }];
  const cross = {
    auditor: mergeSplitCrossReviews(halfCross('auditor-a', []),
                                    halfCross('auditor-b', one('b agrees'))),
    steward: ruling('steward', 'G1', 'one', 'steward agrees'),
  };
  const rc = synthesize(round1, cross, { rootCauseGroups: unresolved }).rootCauses[0];
  assert.deepEqual(rc.confirmation, { voices: 1, required: 2, selfRuled: ['auditor-b'] });
  assert.equal(rc.status, 'proposed');

  // The control, one variable apart: the SAME rulings over a citation that does
  // resolve. `auditor-b` is then a genuine voice and the group is confirmed —
  // so the assertion above is about resolution, not about the ruling shape.
  const resolved = synthesize(round1, cross, { rootCauseGroups: groups }).rootCauses[0];
  assert.deepEqual(resolved.confirmation, { voices: 2, required: 2, selfRuled: [] });
  assert.equal(resolved.status, 'confirmed');
});

test('the other half of a split lane is a voice on a group it did not report', () => {
  const { round1, groups } = soleCitation();
  const stewardVoice = ruling('steward', 'G1', 'one', 'steward says one');

  // `auditor-b` read different files, and its ruling on `auditor-a`'s citation
  // is as independent as any third lane's — which is what `reportedBy` already
  // says about its validate edge on that same finding.
  const sibling = synthesize(round1, {
    auditor: mergeSplitCrossReviews(halfCross('auditor-a', []),
                                    halfCross('auditor-b', one('b read it, agree'))),
    steward: stewardVoice,
  }, { rootCauseGroups: groups }).rootCauses[0];
  assert.equal(sibling.status, 'confirmed');
  assert.deepEqual(sibling.confirmation, { voices: 2, required: 2, selfRuled: [] });

  // The discriminating case: the only difference is which half ruled, and the
  // half that reported the citation still buys nothing.
  const own = synthesize(round1, {
    auditor: mergeSplitCrossReviews(halfCross('auditor-a', one('a says one')),
                                    halfCross('auditor-b', [])),
    steward: stewardVoice,
  }, { rootCauseGroups: groups }).rootCauses[0];
  assert.equal(own.status, 'proposed');
  assert.deepEqual(own.confirmation, { voices: 1, required: 2, selfRuled: ['auditor-a'] });
});

test('a lane that rules from both halves is named once and still is not a voice', () => {
  const { round1, groups } = soleCitation();

  // Neither half declares an id — an orchestrator that predates them, which is
  // the shape that rendered "auditor, auditor ruled on a group".
  const unnamed = mergeSplitCrossReviews(
    { persona: 'auditor', validate: [], challenge: [], added: [], groups: one('a says one') },
    { persona: 'auditor', validate: [], challenge: [], added: [], groups: one('b says one') });
  const syn = synthesize(round1, { auditor: unnamed }, { rootCauseGroups: groups });
  assert.deepEqual(syn.rootCauses[0].confirmation,
    { voices: 0, required: 2, selfRuled: ['auditor'] });
  assert.equal(syn.rootCauses[0].status, 'proposed');
  const md = renderMarkdown(syn);
  assert.match(md, /auditor ruled on a group nobody else reported/);
  assert.doesNotMatch(md, /auditor, auditor/, 'one lane cannot be named twice');

  // Two halves that BOTH reported it are two names and still no voice: the
  // dedupe must not collapse `auditor-a` and `auditor-b` into one reviewer
  // either, which is the mistake in the other direction.
  const bothReported = {
    auditor: splitLane([f('the guard is unreachable', 'critical', 'a.py', 10)],
                       [f('the guard is unreachable', 'critical', 'a.py', 10)]),
    steward: review('steward', [f('unrelated', 'warning', 'z.py', 1)]),
  };
  const rc = synthesize(bothReported, {
    auditor: mergeSplitCrossReviews(halfCross('auditor-a', one('a says one')),
                                    halfCross('auditor-b', one('b says one'))),
  }, { rootCauseGroups: groups }).rootCauses[0];
  assert.deepEqual(rc.confirmation,
    { voices: 0, required: 2, selfRuled: ['auditor-a', 'auditor-b'] });
});

test('both renderers name the half of a split lane that ruled', () => {
  const { round1, groups } = soleCitation();
  const syn = synthesize(round1, {
    auditor: mergeSplitCrossReviews(halfCross('auditor-a', one('a says one')),
                                    halfCross('auditor-b', one('b says one'))),
  }, { rootCauseGroups: groups });
  const md = renderMarkdown(syn);
  assert.match(md, /\*\*auditor-a rules `one`:\*\* a says one/);
  assert.match(md, /\*\*auditor-b rules `one`:\*\* b says one/);
  const html = renderHtml(syn);
  assert.match(html, /<strong>auditor-a rules one:<\/strong> a says one/);
  assert.match(html, /<strong>auditor-b rules one:<\/strong> b says one/);

  // A ruling that named no half is the LANE's, and still renders as the lane.
  const lane = synthesize(round1, { steward: ruling('steward', 'G1', 'one', 'steward says one') },
    { rootCauseGroups: groups });
  assert.match(renderMarkdown(lane), /\*\*steward rules `one`:\*\* steward says one/);
});

// --- provenance: which pass found it ------------------------------------------
//
// "The fix introduced this" and "round 2 noticed this" are different facts, and
// an operator working a ranked list cannot act on the first without knowing
// which it is. Both arrive as `added` findings on purpose (a regression against
// a landed commit IS the `added` shape), so the report has to carry the
// difference on the finding itself.

const regressionPass = (persona, findings) =>
  ({ persona, provenance: 'regression', verdict: 'conditional', summary: '', findings });

test('a regression pass marks its findings, and an ordinary round does not', () => {
  const syn = synthesize({
    auditor: v('conditional', [f('Latent race', 'critical')]),
    adversary: regressionPass('adversary', [f('The drain lost its bound', 'critical')]),
  }, {});
  const byTitle = Object.fromEntries(syn.findings.map((x) => [x.title, x.provenance]));
  assert.equal(byTitle['The drain lost its bound'], 'regression');
  assert.equal(byTitle['Latent race'], 'review',
    'a finding nobody said anything about must default to the quiet value');

  const md = renderMarkdown(syn);
  assert.match(md, /The drain lost its bound\n\n_Reported by: adversary · confidence: solo · found by the regression pass on a fix commit that landed_\n/);
  assert.match(md, /Latent race\n\n_Reported by: auditor · confidence: solo_\n/,
    'the ordinary finding\'s line carries no note at all');
  // Both renderers word it for their medium and both must make the same CLAIM.
  // The dashboard said "introduced by a fix commit", which asserts causation the
  // payload does not carry: a regression entry is classified `intended-inert`,
  // `intended-undocumented` or `unintended`, and only the last was introduced in
  // the sense a reader takes from that sentence.
  const html = renderHtml(syn);
  assert.match(html, /found by a fix commit's regression pass/);
  assert.doesNotMatch(html, /introduced by/,
    'the dashboard must not assert the fix introduced a finding the pass merely found');
});

test('the stamp a bridge applies is refused from a payload, wherever it is written', () => {
  // `provenanceOf` above trusts the file. The file is written by a bridge —
  // and until this guard, by any reviewer who typed the key: a plain
  // `round1-auditor.json` whose finding carried `"provenance": "regression"`
  // validated `ok (auditor)` and rendered as "found by the regression pass on
  // a fix commit that landed", over a pass that never ran.
  //
  // The sweep is every list of objects on the payload rather than a named few,
  // because the phase that grows the next list is the phase that arrives
  // unguarded. `notes` below is not a key any schema here has.
  assert.match(stampedFieldClaim({ persona: 'auditor', provenance: 'regression' }),
    /`provenance` is stamped by the bridge/);
  assert.match(
    stampedFieldClaim({ persona: 'auditor', findings: [f('a'), { ...f('b'),
      provenance: 'regression' }] }),
    /`findings\[1\]\.provenance` is stamped by the bridge/);
  assert.match(
    stampedFieldClaim({ persona: 'auditor', notes: [{ provenance: 'review' }] }),
    /`notes\[0\]\.provenance` is stamped by the bridge/,
    'the value does not matter: a payload does not get to say which program wrote it');

  // And the discriminating half — a check that answered every payload would
  // refuse the whole flow.
  assert.equal(stampedFieldClaim({ persona: 'auditor', verdict: 'approve', summary: 's',
    findings: [f('a')], validate: [], challenge: [], added: [] }), null);
  assert.equal(stampedFieldClaim(null), null, 'an unreadable payload is the schema\'s to refuse');
});

test('provenance rides on the entry too — a merged payload has one header for two lists', () => {
  // mergeSplitReviews unions two payloads' findings under one header, so a
  // marker that lived only on the header would be dropped by exactly the merge
  // a split lane needs. Same read order as `claimedAgent`: entry, then payload.
  //
  // The regression half goes FIRST, which is the order combine.mjs gets from a
  // plain glob (`round1-auditor.regression.json` sorts before `.verified.json`)
  // and the only order in which the header assertion below can fail.
  const merged = mergeSplitReviews(
    regressionPass('auditor', [{ ...f('Second writer to the cache', 'warning'),
                                 provenance: 'regression' }]),
    { persona: 'auditor', verdict: 'approve', summary: 'a', findings: [] });
  assert.ok(!('provenance' in merged), 'the merged header speaks for neither half');
  const [finding] = synthesize({ auditor: merged }, {}).findings;
  assert.equal(finding.provenance, 'regression');
});

test('a merged lane header speaks for neither half, in either argument order', () => {
  // The assertion above was the whole test once, with the ordinary payload
  // passed first — true of that fixture and not of the code: `mergedLane`
  // spread half A's header, so the same call with the arguments swapped kept
  // `provenance` and `provenanceOf`'s payload fallback stamped half B's
  // ordinary findings "found by the regression pass on a fix commit that
  // landed". `verified` (verify.mjs) and `passes` (regression.mjs) are the same
  // shape of per-half fact and were riding along beside it.
  const ordinary = { persona: 'auditor', agent: 'auditor-a', verdict: 'approve', summary: 'a',
                     verified: [{ id: 'F1', status: 'closed', why: 'the guard is back' }],
                     findings: [f('An ordinary finding')] };
  const pass = { ...regressionPass('auditor', [{ ...f('Second writer to the cache'),
                                                 provenance: 'regression' }]),
                 agent: 'auditor-b', passes: [{ commit: 'deadbee', checked: [] }] };

  for (const [first, second] of [[pass, ordinary], [ordinary, pass]]) {
    const order = `${first.agent} first`;
    const merged = mergeSplitReviews(first, second);
    for (const field of ['agent', 'provenance', 'verified', 'passes']) {
      assert.ok(!(field in merged), `${order}: the merged header must not carry \`${field}\``);
    }
    // What a lane header may still say: its own name. combine.mjs keys
    // round1.json by it and a row that cannot name itself is unreadable, so
    // the rule is "only what is true of both halves", not "nothing".
    assert.equal(merged.persona, 'auditor', `${order}: the lane still names itself`);
    const stamped = Object.fromEntries(
      synthesize({ auditor: merged }, {}).findings.map((x) => [x.title, x.provenance]));
    assert.equal(stamped['Second writer to the cache'], 'regression',
      `${order}: the pass's own finding keeps its stamp`);
    assert.equal(stamped['An ordinary finding'], 'review',
      `${order}: the other half's findings are not the regression pass's`);
  }
});

test('regression provenance survives a second reporter, whichever order they merge in', () => {
  // A second lane noticing the same thing in the ordinary way does not make it
  // less true that a fix commit introduced it — and "last writer wins" would
  // lose it in one of these two orders and look correct in the other.
  const title = 'The bound stopped bounding';
  const first = synthesize({
    adversary: regressionPass('adversary', [f(title, 'critical')]),
    auditor: v('reject', [f(title, 'critical')]),
  }, {});
  const second = synthesize({
    auditor: v('reject', [f(title, 'critical')]),
    adversary: regressionPass('adversary', [f(title, 'critical')]),
  }, {});
  assert.equal(first.findings[0].provenance, 'regression');
  assert.equal(second.findings[0].provenance, 'regression');
  assert.equal(first.findings[0].confidence, 'cross-validated',
    'the provenance axis must not disturb the confidence arithmetic');
});

test('a round-2 added finding can carry provenance, and the JSON report keeps it', () => {
  const round1 = { auditor: v('approve') };
  const round2 = { steward: { persona: 'steward', provenance: 'regression', validate: [],
                              challenge: [], added: [f('Changelog now lies', 'warning')] } };
  const json = toJsonReport(synthesize(round1, round2));
  assert.equal(json.findings[0].provenance, 'regression');
  assert.equal(toJsonReport(synthesize({ auditor: v('approve', [f('Ordinary')]) }, {}))
    .findings[0].provenance, 'review');
});

test('a payload-chosen key cannot forge a log line in the stamp claim', () => {
  // Both callers print this claim straight to stderr, so the key is an
  // injection channel. A key spelled with embedded newlines made
  // `validate.mjs --phase round1` emit forged `ok (<persona>)` lines for lanes
  // whose files do not exist — the tool appearing to validate reviews that were
  // never written.
  const key = 'findings\n/x/round1-adversary.json: ok (adversary)\nfindings';
  const claim = stampedFieldClaim({ persona: 'auditor', [key]: [{ provenance: 'regression' }] });

  assert.ok(claim, 'the stamp is still refused');
  assert.doesNotMatch(claim, /\n/, 'the claim has to stay one line');
  assert.doesNotMatch(claim, /^\/x\/round1-adversary\.json: ok/m);
  // And an ordinary key is still named plainly — the message's job is to say
  // which field, and quoting everything made that unreadable.
  assert.match(stampedFieldClaim({ persona: 'auditor', findings: [{ provenance: 'x' }] }),
    /`findings\[0\]\.provenance`/);
});
