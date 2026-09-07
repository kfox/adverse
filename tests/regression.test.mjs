// Tests for src/regression.mjs — which lane reads a fix commit for what else
// it changed.
//
// The property under test is a pair of exclusions and a preference, and the
// live risk is a fixture set where two different rules agree on every input:
// "the Adversary when the diff crosses a trust boundary" and "the Adversary,
// always" are indistinguishable unless some case picks somebody else. So the
// boundary cases come in pairs that differ in ONE thing — the same file list
// with one line of diff changed, the same diff with one name in `closedBy` —
// and the fallback cases pin who is chosen as well as that somebody is.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { chooseRegressionLane } from '../src/regression.mjs';

const diffOf = (...added) =>
  ['diff --git a/x b/x', '--- a/x', '+++ b/x', '@@ -1 +1 @@', ...added.map((l) => `+${l}`)].join('\n');

// One file list, two diffs. Nothing but the changed line separates them, so a
// difference in the chosen lane can only have come from the diff.
const FILES = ['src/render/palette.mjs'];
const ROUTINE = { files: FILES, diff: diffOf('const gamma = 2.2;') };
const BOUNDARY = { files: FILES, diff: diffOf('el.innerHTML = req.query.name;') };

test('the trust boundary decides the lens, and its absence is not the same answer', () => {
  const crossing = chooseRegressionLane({ ...BOUNDARY, closedBy: [] });
  const ordinary = chooseRegressionLane({ ...ROUTINE, closedBy: [] });
  assert.equal(crossing.persona, 'adversary');
  assert.equal(ordinary.persona, 'auditor');
  assert.equal(crossing.conflicted, false);
  assert.equal(ordinary.conflicted, false);
  assert.match(crossing.reason, /crosses a trust boundary/);
  assert.match(ordinary.reason, /crosses no trust boundary/);
});

test('the lane that reported a finding this commit closed does not review the fix', () => {
  // The whole point of the pass: the reporter is the agent most invested in the
  // finding being closed, so it is the worst available lens for what else the
  // fix changed. Both preference orders have to yield.
  assert.equal(chooseRegressionLane({ ...BOUNDARY, closedBy: ['adversary'] }).persona, 'auditor');
  assert.equal(chooseRegressionLane({ ...ROUTINE, closedBy: ['auditor'] }).persona, 'steward');
  assert.equal(
    chooseRegressionLane({ ...ROUTINE, closedBy: ['auditor', 'steward'] }).persona, 'adversary');
});

test('a split lane\'s half is still that lane', () => {
  // `auditor-b` reviewing the fix for `auditor-a`'s finding is the lane checking
  // its own work under a different name, and it is the silent direction: the
  // report would read exactly like a disinterested pass.
  const chosen = chooseRegressionLane({ ...ROUTINE, closedBy: ['auditor-b'] });
  assert.equal(chosen.persona, 'steward');
  assert.equal(chosen.conflicted, false);
});

test('a name that belongs to no lane excludes nothing', () => {
  // `closedBy` comes off ledger decisions, where a persona string is
  // model-written. An unrecognized one must not silently exclude the lane the
  // pass wanted, and must not throw either.
  const chosen = chooseRegressionLane({
    ...ROUTINE, closedBy: ['referee', 'AUDITOR', 'auditor_a', '__proto__', null, 42],
  });
  assert.equal(chosen.persona, 'auditor');
  assert.equal(chosen.conflicted, false);
});

test('the Pragmatist never runs the pass, not even when nothing else is left', () => {
  // It owns only `design`, every design finding is advisory, and a pass that
  // can produce nothing that blocks cannot report the thing it was run for. The
  // interesting case is the empty candidate set, where a fallback reaching for
  // "whoever has not reported" would land on exactly this lane.
  for (const fixture of [ROUTINE, BOUNDARY]) {
    const chosen = chooseRegressionLane({
      ...fixture, closedBy: ['auditor', 'adversary', 'steward'],
    });
    assert.notEqual(chosen.persona, 'pragmatist');
  }
  assert.notEqual(chooseRegressionLane({ ...ROUTINE, closedBy: [] }).persona, 'pragmatist');
});

test('an emptied candidate set still returns a lane, and flags itself', () => {
  // Skipping is the silent direction — a skipped pass reads exactly like a
  // clean one — so the pass runs anyway, in the same preference order, and says
  // that its reviewer was already invested in the commit.
  const everyone = ['auditor', 'adversary', 'steward'];
  const crossing = chooseRegressionLane({ ...BOUNDARY, closedBy: everyone });
  const ordinary = chooseRegressionLane({ ...ROUTINE, closedBy: everyone });

  assert.equal(crossing.persona, 'adversary');
  assert.equal(ordinary.persona, 'auditor');
  assert.equal(crossing.conflicted, true);
  assert.equal(ordinary.conflicted, true);
  assert.match(ordinary.reason, /reported a finding this commit closed/);
  assert.match(ordinary.reason, /already invested in this fix/);
});

test('no file list at all fails toward the Adversary, the way assessScope does', () => {
  // An unread diff is not a diff with nothing in it. Both callers of this
  // module hand over whatever git gave them, and a commit nobody could read
  // must not read as a commit with no boundary in it.
  const chosen = chooseRegressionLane({ closedBy: [], files: [], diff: '' });
  assert.equal(chosen.persona, 'adversary');
  assert.match(chosen.reason, /crosses a trust boundary/);
});

test('called with nothing at all, it still answers', () => {
  const chosen = chooseRegressionLane();
  assert.equal(typeof chosen.persona, 'string');
  assert.equal(typeof chosen.reason, 'string');
  assert.equal(chosen.conflicted, false);
});
