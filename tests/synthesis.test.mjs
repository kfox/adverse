// Tests for src/synthesis.mjs — deterministic merge, consensus labels,
// confidence categorization, severity promotion, dedup, render output.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isBlocking, renderMarkdown, synthesize, toJsonReport } from '../src/synthesis.mjs';

const f = (title, severity = 'warning', file = null, line = null, detail = 'd', fix = null) =>
  ({ severity, file, line, title, detail, fix });

// A finding of a given kind, for the tests that exercise the kind axis.
const k = (title, kind, severity = 'warning', extra = {}) =>
  ({ severity, kind, file: null, line: null, title, detail: 'd', fix: null, ...extra });

const v = (verdict, findings = []) => ({ persona: 'x', verdict, summary: '', findings });

// --- Consensus labels --------------------------------------------------------

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
