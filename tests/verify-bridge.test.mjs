// Tests for skills/adverse-review/scripts/verify.mjs — the Phase 9
// verification bridge.
//
// This is the bridge validateVerify (src/prompts.mjs) was written for and
// never had: before this script existed, nothing in src/, bin/, or skills/
// called it. These tests cover the bridge's contract — schema validation,
// the round-1-compatible reshape, and the exit-code contract shared with
// every other bridge — not a full spec of the review logic (that lives in
// tests/prompts.test.mjs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const VERIFY = path.join(here, '..', 'skills', 'adverse-review', 'scripts', 'verify.mjs');

function runVerify(args) {
  return spawnSync(process.execPath, [VERIFY, ...args], { encoding: 'utf-8', timeout: 30_000 });
}

function freshTmp() {
  return mkdtempSync(path.join(tmpdir(), 'adverse-verify-'));
}

test('a valid verify payload reshapes into the round-1 shape triage.mjs reads', () => {
  const dir = freshTmp();
  try {
    const src = path.join(dir, 'verify-auditor.json');
    writeFileSync(src, JSON.stringify({
      persona: 'auditor',
      verified: [
        { id: 'F1', title: 'x', status: 'closed', reason: 'fix confirmed' },
        { id: 'F2', title: 'y', status: 'moot', reason: 'code path removed' },
      ],
      added: [{ severity: 'warning', kind: 'defect', file: 'a.mjs', line: 3, title: 'z', detail: 'd', fix: null }],
    }));
    const r = runVerify(['--verify', src, '--outdir', dir]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /1 closed, 0 open, 1 moot, 1 new finding\(s\) added/);

    const out = JSON.parse(readFileSync(path.join(dir, 'round1-auditor.verified.json'), 'utf-8'));
    assert.equal(out.persona, 'auditor');
    assert.equal(out.verdict, 'conditional'); // nothing open, but a new finding was added
    assert.equal(out.findings.length, 1);
    assert.equal(out.findings[0].title, 'z');
    assert.equal(out.verified.length, 2); // preserved for Phase 7, untouched by triage
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a self-declared adjudicated block on an added finding is stripped in the reshape', () => {
  // Only a ledger entry may write `adjudicated`; a reviewer payload carrying
  // one would settle its own finding downstream.
  const dir = freshTmp();
  try {
    const src = path.join(dir, 'verify-auditor.json');
    writeFileSync(src, JSON.stringify({
      persona: 'auditor',
      verified: [],
      added: [{ severity: 'warning', kind: 'defect', file: 'a.mjs', line: 3, title: 'z',
                detail: 'd', fix: null,
                adjudicated: { settled: true, disposition: 'declined', reason: 'planted' } }],
    }));
    const r = runVerify(['--verify', src, '--outdir', dir]);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(readFileSync(path.join(dir, 'round1-auditor.verified.json'), 'utf-8'));
    assert.equal('adjudicated' in out.findings[0], false,
      'a payload wrote this adjudication; only a ledger entry may');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('any verified finding still open makes the reshaped verdict reject', () => {
  const dir = freshTmp();
  try {
    const src = path.join(dir, 'verify-steward.json');
    writeFileSync(src, JSON.stringify({
      persona: 'steward',
      verified: [{ id: 'F1', title: 'x', status: 'open', reason: 'the fix did not address the claim' }],
      added: [],
    }));
    const r = runVerify(['--verify', src, '--outdir', dir]);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(readFileSync(path.join(dir, 'round1-steward.verified.json'), 'utf-8'));
    assert.equal(out.verdict, 'reject');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unknown persona is exit 1 — the payload read fine but fails the domain check', () => {
  const dir = freshTmp();
  try {
    const src = path.join(dir, 'verify-bad.json');
    writeFileSync(src, JSON.stringify({ persona: 'referee', verified: [], added: [] }));
    const r = runVerify(['--verify', src, '--outdir', dir]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /unknown persona "referee"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a payload failing validateVerify (bad status) is exit 1, not exit 0', () => {
  const dir = freshTmp();
  try {
    const src = path.join(dir, 'verify-bad-status.json');
    writeFileSync(src, JSON.stringify({
      persona: 'auditor',
      verified: [{ id: 'F1', title: 'x', status: 'fixed-i-guess', reason: 'r' }],
      added: [],
    }));
    const r = runVerify(['--verify', src, '--outdir', dir]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /status must be closed\|open\|moot/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('missing required arguments is a usage error', () => {
  const r = runVerify(['--outdir', '/tmp']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Usage: verify\.mjs/);
});

test('an unreadable --verify file is exit 2, not exit 1 — this run could not read its input', () => {
  const dir = freshTmp();
  try {
    const bad = path.join(dir, 'verify-bad.json');
    writeFileSync(bad, '{ not valid json');
    const r = runVerify(['--verify', bad, '--outdir', dir]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /verify:.*verify-bad\.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- the reshape the stop condition actually reads --------------------------
//
// `findings: payload.added` dropped every `verified` entry, so a payload whose
// own verdict was `reject` reshaped into an empty findings array — and
// `convergenceStatus` computes `done` over exactly that array, consulting no
// verdict. converge.mjs then exited 0 on a fix a reviewer had just said failed.

test('a still-open verification is re-emitted as a finding, not dropped', () => {
  const dir = freshTmp();
  try {
    const src = path.join(dir, 'verify-auditor.json');
    writeFileSync(src, JSON.stringify({
      persona: 'auditor',
      verified: [
        { id: 'F1', title: 'the fix did not take', status: 'open', reason: 'still reproduces' },
        { id: 'F2', title: 'closed one', status: 'closed', reason: 'confirmed' },
      ],
      added: [],
    }));
    const r = runVerify(['--verify', src, '--outdir', dir]);
    assert.equal(r.status, 0, r.stderr);

    const out = JSON.parse(readFileSync(path.join(dir, 'round1-auditor.verified.json'), 'utf-8'));
    assert.equal(out.verdict, 'reject');
    assert.equal(out.findings.length, 1, 'the open verification must reach `findings`');

    const [f] = out.findings;
    assert.equal(f.title, 'the fix did not take');
    assert.match(f.detail, /STILL OPEN/);
    assert.match(f.detail, /still reproduces/, "the reviewer's reason is the evidence");
    // isBlocking is `kind is not advisory && severity is not info`. Both halves
    // have to hold or this finding cannot hold the loop open.
    assert.notEqual(f.severity, 'info');
    assert.notEqual(f.kind, 'design');

    // A closed verification is not a finding — only the failures come back.
    assert.equal(out.verified.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--briefing restores a reopened finding\'s original severity and anchor', () => {
  const dir = freshTmp();
  try {
    const briefing = path.join(dir, 'briefing.json');
    writeFileSync(briefing, JSON.stringify({
      findings: [{
        id: 'F1', severity: 'critical', kind: 'defect',
        file: 'src/a.mjs', line: 42, counterpart: null, title: 'orig', fix: 'do the thing',
      }],
    }));
    const src = path.join(dir, 'verify-auditor.json');
    writeFileSync(src, JSON.stringify({
      persona: 'auditor',
      verified: [{ id: 'F1', title: 'orig', status: 'open', reason: 'nope' }],
      added: [],
    }));
    const r = runVerify(['--verify', src, '--outdir', dir, '--briefing', briefing]);
    assert.equal(r.status, 0, r.stderr);

    const [f] = JSON.parse(readFileSync(path.join(dir, 'round1-auditor.verified.json'), 'utf-8')).findings;
    assert.equal(f.severity, 'critical', 'a critical must not be downgraded by the round trip');
    assert.equal(f.kind, 'defect');
    assert.equal(f.file, 'src/a.mjs');
    assert.equal(f.line, 42);
    assert.equal(f.fix, 'do the thing');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('without --briefing a reopened finding still blocks', () => {
  const dir = freshTmp();
  try {
    const src = path.join(dir, 'verify-steward.json');
    writeFileSync(src, JSON.stringify({
      persona: 'steward',
      verified: [{ id: 'F9', title: 'unknown anchor', status: 'open', reason: 'r' }],
      added: [],
    }));
    const r = runVerify(['--verify', src, '--outdir', dir]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /re-emitted as findings/);

    const [f] = JSON.parse(readFileSync(path.join(dir, 'round1-steward.verified.json'), 'utf-8')).findings;
    assert.notEqual(f.severity, 'info');
    assert.notEqual(f.kind, 'design');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('two verify payloads for one persona refuse to collide', () => {
  const dir = freshTmp();
  try {
    // verify.mjs had the roster check from the start and not this one, so two
    // payloads for one persona still collapsed onto a single output file
    // before combine.mjs globbed the directory.
    const mk = (name) => {
      const f = path.join(dir, name);
      writeFileSync(f, JSON.stringify({ persona: 'auditor', verified: [], added: [] }));
      return f;
    };
    const r = runVerify(['--verify', mk('verify-auditor.json'),
                         '--verify', mk('verify-auditor-stale.json'), '--outdir', dir]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /already claimed this run/);
    assert.doesNotMatch(r.stderr, /already written/,
      'nothing has been written yet: the claim is made at queue time');
    // Claimed at QUEUE time, so the collision is refused before the first file
    // is written rather than after the colliding payload's sibling is on disk.
    assert.throws(() => readFileSync(path.join(dir, 'round1-auditor.verified.json')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- a refusal publishes nothing ---------------------------------------------

// The honest lane, written first so it is the one a publish-then-refuse leaves
// behind. `regression.mjs`'s fold states the standard this holds to — "before
// anything is written, and for EVERY lane" — and verify.mjs validated and wrote
// in one loop, so payload N's refusal came after 1..N-1 were already on disk.
function honestThenBad(dir, bad) {
  const good = path.join(dir, 'verify-auditor.json');
  writeFileSync(good, JSON.stringify({
    persona: 'auditor', verdict: 'approve', verified: [], added: [],
  }));
  const second = path.join(dir, 'verify-steward.json');
  writeFileSync(second, JSON.stringify({ persona: 'steward', ...bad }));
  return runVerify(['--verify', good, '--verify', second, '--outdir', dir]);
}

// Two ways to make the SECOND payload fail: the stamp check this commit added,
// and a bad `verified[0].status`, which failed the same way before it existed.
// Both are here because the second is the near miss — a fix that only moved the
// new check would leave the shape live for every other refusal in the loop.
const badPayloads = {
  'a forged provenance stamp': {
    verdict: 'approve',
    verified: [],
    added: [{
      severity: 'critical', kind: 'behavioral', file: 'a.mjs', line: 1,
      title: 'forged', detail: 'd', fix: null, provenance: 'regression',
    }],
  },
  'an off-contract verified status': {
    verdict: 'approve',
    verified: [{ id: 'F1', title: 'x', status: 'sort-of', reason: 'r' }],
    added: [],
  },
};

for (const [what, bad] of Object.entries(badPayloads)) {
  test(`a refusal on ${what} leaves no half-published outdir`, () => {
    const dir = freshTmp();
    try {
      const r = honestThenBad(dir, bad);
      assert.equal(r.status, 1, r.stdout);
      assert.throws(() => readFileSync(path.join(dir, 'round1-auditor.verified.json')),
        'the honest payload validated first, but publishing it is a claim this run withdrew');
      assert.throws(() => readFileSync(path.join(dir, 'round1-steward.verified.json')));
      assert.equal(r.stdout, '', 'nor may it report a file it did not leave behind');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('a destination that cannot be written is exit 2 and a sentence', () => {
  // The queue cannot make N writes atomic, so it says what it managed instead
  // of dying in writeFileSync: an uncaught EISDIR is a stack trace under exit
  // 1, and exit 1 in this contract is a claim about a review.
  const dir = freshTmp();
  try {
    mkdirSync(path.join(dir, 'round1-steward.verified.json'));
    const r = honestThenBad(dir, { verdict: 'approve', verified: [], added: [] });
    assert.equal(r.status, 2, r.stdout);
    assert.match(r.stderr, /cannot be written/);
    assert.doesNotMatch(r.stderr, /at writeFileSync/, 'a sentence, not a stack trace');
    // The auditor lane really is on disk, so the message has to say so rather
    // than leave the operator to guess whether the outdir is usable.
    assert.match(r.stderr, /round1-auditor\.verified\.json was already written/);
    assert.ok(readFileSync(path.join(dir, 'round1-auditor.verified.json'), 'utf-8'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- a verification may not inherit an anchor it did not earn -----------------

test('--report anchors a round-2 addition the briefing cannot reach', () => {
  // The issue's measured repro: a round-2 ADDED finding is in briefing.json
  // under no key at all (triage's only finding input is --round1), so its
  // verification always came back blocking warning/behavioral — for an
  // advisory addition, that contradicts the rule that design never blocks.
  // report.json is the only file that holds it.
  const dir = freshTmp();
  try {
    const report = path.join(dir, 'report.json');
    writeFileSync(report, JSON.stringify({
      findings: [{
        severity: 'info', kind: 'design', file: 'src/fx.mjs', line: 7,
        counterpart: null, title: 'the effect chain re-enters itself on a nested clip launch',
      }],
    }));
    const src = path.join(dir, 'verify-steward.json');
    writeFileSync(src, JSON.stringify({
      persona: 'steward',
      verified: [{ id: 'R2-add-1',
        title: 'the effect chain re-enters itself on a nested clip launch',
        status: 'open', reason: 'still re-enters' }],
      added: [],
    }));
    const r = runVerify(['--verify', src, '--outdir', dir, '--report', report]);
    assert.equal(r.status, 0, r.stderr);
    const [f] = JSON.parse(
      readFileSync(path.join(dir, 'round1-steward.verified.json'), 'utf-8')).findings;
    assert.equal(f.severity, 'info');
    assert.equal(f.kind, 'design', 'an advisory addition must not come back blocking');
    assert.equal(f.file, 'src/fx.mjs');
    assert.equal(f.line, 7);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a title matching two reported findings binds to neither', () => {
  // Same rule as the briefing index: guessing which is meant is how a severity
  // gets copied off the wrong finding, so the ambiguous case falls back to the
  // blocking default and says so.
  const dir = freshTmp();
  try {
    const report = path.join(dir, 'report.json');
    writeFileSync(report, JSON.stringify({
      findings: [
        { severity: 'info', kind: 'design', file: 'a.mjs', line: 1, title: 'twice-told' },
        { severity: 'critical', kind: 'defect', file: 'b.mjs', line: 2, title: 'twice-told' },
      ],
    }));
    const src = path.join(dir, 'verify-steward.json');
    writeFileSync(src, JSON.stringify({
      persona: 'steward',
      verified: [{ id: 'R2-x', title: 'twice-told', status: 'open', reason: 'r' }],
      added: [],
    }));
    const r = runVerify(['--verify', src, '--outdir', dir, '--report', report]);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /anchor not inherited/);
    const [f] = JSON.parse(
      readFileSync(path.join(dir, 'round1-steward.verified.json'), 'utf-8')).findings;
    assert.equal(f.severity, 'warning');
    assert.equal(f.kind, 'behavioral');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function briefingWith(dir, entry) {
  const p = path.join(dir, 'briefing.json');
  writeFileSync(p, JSON.stringify({ findings: [entry] }));
  return p;
}

test('a verification naming another finding\'s id does not inherit its severity', () => {
  // `v.id` is reviewer-supplied and validateVerify leaves it unbound, so
  // saying "the critical fix is STILL OPEN" while naming an info/design id
  // produced a non-blocking finding and the loop reported done.
  const dir = freshTmp();
  try {
    const briefing = briefingWith(dir, {
      id: 'F2', severity: 'info', kind: 'design', file: 'src/x.mjs', line: 1,
      counterpart: null, title: 'a cosmetic nit', fix: null,
    });
    const src = path.join(dir, 'verify-auditor.json');
    writeFileSync(src, JSON.stringify({
      persona: 'auditor',
      verified: [{ id: 'F2', title: 'Auth bypass in token check', status: 'open', reason: 'still bypassable' }],
      added: [],
    }));
    const r = runVerify(['--verify', src, '--outdir', dir, '--briefing', briefing]);
    assert.equal(r.status, 1, 'a mismatched binding is reported, not silent');
    assert.match(r.stderr, /is "a cosmetic nit" in the briefing/);

    const [f] = JSON.parse(readFileSync(path.join(dir, 'round1-auditor.verified.json'), 'utf8')).findings;
    assert.notEqual(f.severity, 'info', 'must not inherit the unrelated severity');
    assert.notEqual(f.kind, 'design', 'must not inherit the unrelated kind');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a verification naming an id that is not in the briefing is reported', () => {
  const dir = freshTmp();
  try {
    const briefing = briefingWith(dir, {
      id: 'F1', severity: 'critical', kind: 'defect', file: 'a.mjs', line: 1,
      counterpart: null, title: 'real one', fix: null,
    });
    const src = path.join(dir, 'verify-auditor.json');
    writeFileSync(src, JSON.stringify({
      persona: 'auditor',
      verified: [{ id: 'F99', title: 'invented', status: 'open', reason: 'r' }],
      added: [],
    }));
    const r = runVerify(['--verify', src, '--outdir', dir, '--briefing', briefing]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /unresolvable id "F99"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a still-open verification with an empty title still reaches findings', () => {
  // A title is the join key every downstream edge rides on, and buildFinding
  // drops a finding without one — which converges the loop on a failed fix.
  const dir = freshTmp();
  try {
    const src = path.join(dir, 'verify-auditor.json');
    writeFileSync(src, JSON.stringify({
      persona: 'auditor',
      verified: [{ id: 'F1', title: '   ', status: 'open', reason: 'still broken' }],
      added: [],
    }));
    const r = runVerify(['--verify', src, '--outdir', dir]);
    assert.equal(r.status, 0, r.stderr);
    const [f] = JSON.parse(readFileSync(path.join(dir, 'round1-auditor.verified.json'), 'utf8')).findings;
    assert.ok(f.title.trim().length > 0, 'a usable title is synthesized');
    assert.match(f.title, /F1/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- a stale or invented id still binds by title ---------------------------
// `briefing.mjs` re-mints ids positionally on every triage run, so an id a
// reviewer copied from an earlier iteration names nothing in this briefing.
// Binding by id alone left every such verification at the blocking
// `warning`/`behavioral` fallback, which for a `design` finding contradicts the
// rule that design never blocks. The fixture below is the honest shape of that
// class: the finding IS briefed, under an id the payload does not use.
//
// A round-2 ADDITION is NOT this class and this route does not reach it: it is
// in `briefing.json` under no key, so it keeps the blocking fallback. That gap
// is deliberate for now — noisy beats silent — and tracked separately.

test('a briefed finding cited by an id the briefing does not carry binds by title', () => {
  const dir = freshTmp();
  try {
    const briefing = briefingWith(dir, {
      id: 'F1', severity: 'info', kind: 'design', file: 'src/a.mjs', line: 5,
      counterpart: null, title: 'the module is two modules in one file', fix: null,
    });
    const src = path.join(dir, 'verify-pragmatist.json');
    writeFileSync(src, JSON.stringify({
      persona: 'pragmatist',
      // The id names nothing in THIS briefing — a stale id from an earlier
      // iteration, whose positional ids do not survive a re-triage.
      verified: [{ id: 'R2-3', title: 'the module is two modules in one file',
        status: 'open', reason: 'the seam is unchanged' }],
      added: [],
    }));
    const r = runVerify(['--verify', src, '--outdir', dir, '--briefing', briefing]);

    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /anchor not inherited/);
    const [f] = JSON.parse(readFileSync(path.join(dir, 'round1-pragmatist.verified.json'), 'utf8')).findings;
    assert.equal(f.kind, 'design', 'an advisory finding must not come back blocking');
    assert.equal(f.severity, 'info');
    assert.equal(f.file, 'src/a.mjs');
    assert.equal(f.line, 5);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a title-less briefing entry does not answer an id lookup here either', () => {
  // The sibling of the hole `briefingEntries` closes for decisions.mjs, in the
  // guard that file's comments name. Indexed on `id` alone, a title-less entry
  // answered `v.id`'s lookup, its empty title disagreed with the verification's
  // real one, and the binding was dropped with `id "F1" is undefined in the
  // briefing` — a payload accused for a field triage failed to write. What the
  // drop costs is the anchor: a still-open critical came back at the reopened
  // fallback, `warning` with no file and no line, so the loop stopped reporting
  // a blocking finding as blocking.
  //
  // Skipping the entry lets the title route run, and the title is the join key
  // every downstream edge already rides on.
  const dir = freshTmp();
  try {
    const briefing = path.join(dir, 'briefing.json');
    writeFileSync(briefing, JSON.stringify({ findings: [
      // Triage wrote this one without a title. It carries the id the reviewer
      // cited, so it is what the id index answered with.
      { id: 'F1', severity: 'info', kind: 'design', file: 'src/nit.mjs', line: 2,
        counterpart: null, fix: null },
      { id: 'F2', severity: 'critical', kind: 'defect', file: 'src/auth.mjs', line: 88,
        counterpart: null, title: 'Auth bypass in token check', fix: null },
    ] }));
    const src = path.join(dir, 'verify-auditor.json');
    writeFileSync(src, JSON.stringify({
      persona: 'auditor',
      verified: [{ id: 'F1', title: 'Auth bypass in token check',
        status: 'open', reason: 'still bypassable' }],
      added: [],
    }));

    const r = runVerify(['--verify', src, '--outdir', dir, '--briefing', briefing]);

    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /is undefined in the briefing/, r.stderr);
    assert.doesNotMatch(r.stderr, /anchor not inherited/, r.stderr);
    const [f] = JSON.parse(
      readFileSync(path.join(dir, 'round1-auditor.verified.json'), 'utf8')).findings;
    assert.equal(f.severity, 'critical', 'a still-open critical comes back blocking');
    assert.equal(f.file, 'src/auth.mjs');
    assert.equal(f.line, 88);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an anchor document whose findings carry no id is still reachable by title', () => {
  // The early return that guards `bindToBriefing` used to test `briefed.size`
  // alone. A document whose findings carry no `id` fills `briefedByTitle` and
  // leaves `briefed` empty, so that line returned first and the title index it
  // was added alongside was unreachable for exactly the input that motivated
  // it. Both indexes are tested now; before this test, narrowing the condition
  // back to `!briefed.size` changed nothing the suite could see.
  const dir = freshTmp();
  try {
    const briefing = path.join(dir, 'briefing.json');
    writeFileSync(briefing, JSON.stringify({ findings: [
      { severity: 'info', kind: 'design', file: 'src/a.mjs', line: 5,
        counterpart: null, title: 'the module is two modules in one file', fix: null },
    ] }));
    const src = path.join(dir, 'verify-pragmatist.json');
    writeFileSync(src, JSON.stringify({
      persona: 'pragmatist',
      verified: [{ id: 'F1', title: 'the module is two modules in one file',
        status: 'open', reason: 'the seam is unchanged' }],
      added: [],
    }));
    const r = runVerify(['--verify', src, '--outdir', dir, '--briefing', briefing]);

    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /anchor not inherited/);
    const [f] = JSON.parse(readFileSync(path.join(dir, 'round1-pragmatist.verified.json'), 'utf8')).findings;
    assert.equal(f.kind, 'design', 'an advisory finding must not come back blocking');
    assert.equal(f.severity, 'info');
    assert.equal(f.line, 5);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an ambiguous title binds to neither finding and falls back to blocking', () => {
  // Two briefed findings share a title, so it cannot say which is meant.
  // Guessing is how a severity gets copied off the wrong finding, so this
  // fails toward blocking and says so.
  const dir = freshTmp();
  try {
    const briefing = path.join(dir, 'briefing.json');
    writeFileSync(briefing, JSON.stringify({ findings: [
      { id: 'F1', severity: 'info', kind: 'design', file: 'a.mjs', line: 5,
        counterpart: null, title: 'same title', fix: null },
      { id: 'F2', severity: 'critical', kind: 'behavioral', file: 'b.mjs', line: 9,
        counterpart: null, title: 'same title', fix: null },
    ] }));
    const src = path.join(dir, 'verify-auditor.json');
    writeFileSync(src, JSON.stringify({
      persona: 'auditor',
      verified: [{ id: 'nope', title: 'same title', status: 'open', reason: 'r' }],
      added: [],
    }));
    const r = runVerify(['--verify', src, '--outdir', dir, '--briefing', briefing]);

    assert.equal(r.status, 1, 'an unbindable verification is reported, not silent');
    assert.match(r.stderr, /"same title" matches more than one finding/);
    const [f] = JSON.parse(readFileSync(path.join(dir, 'round1-auditor.verified.json'), 'utf8')).findings;
    assert.equal(f.kind, 'behavioral', 'the blocking fallback, not a guess');
    assert.equal(f.severity, 'warning');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an ambiguous briefing title does not fall through to a --report entry', () => {
  // The ambiguous-title refusal is stored as a null sentinel in the briefing
  // index. A fallback that reads that null as a miss inherits the anchor from
  // an unrelated report.json entry instead — measured: two critical/defect
  // findings sharing a briefed title plus a same-titled info/design report
  // entry came back info/design at exit 0, silently defeating the guard.
  const dir = freshTmp();
  try {
    const briefing = path.join(dir, 'briefing.json');
    writeFileSync(briefing, JSON.stringify({ findings: [
      { id: 'F1', severity: 'critical', kind: 'defect', file: 'a.mjs', line: 5,
        counterpart: null, title: 'same title', fix: null },
      { id: 'F2', severity: 'critical', kind: 'defect', file: 'b.mjs', line: 9,
        counterpart: null, title: 'same title', fix: null },
    ] }));
    const report = path.join(dir, 'report.json');
    writeFileSync(report, JSON.stringify({ findings: [
      { severity: 'info', kind: 'design', file: 'c.mjs', line: 3, title: 'same title' },
    ] }));
    const src = path.join(dir, 'verify-auditor.json');
    writeFileSync(src, JSON.stringify({
      persona: 'auditor',
      verified: [{ id: 'nope', title: 'same title', status: 'open', reason: 'r' }],
      added: [],
    }));
    const r = runVerify(
      ['--verify', src, '--outdir', dir, '--briefing', briefing, '--report', report]);

    assert.equal(r.status, 1, 'an ambiguous title is refused, not resolved elsewhere');
    assert.match(r.stderr, /"same title" matches more than one finding/);
    const [f] = JSON.parse(
      readFileSync(path.join(dir, 'round1-auditor.verified.json'), 'utf8')).findings;
    assert.equal(f.kind, 'behavioral', 'the blocking fallback, not the report entry');
    assert.equal(f.severity, 'warning');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a verify payload cannot stamp its own finding as the regression pass\'s', () => {
  // `provenance` is what makes the report say a landed fix commit's regression
  // pass found a finding. This bridge is its earliest reader — SKILL.md never
  // runs `validate.mjs --phase verify` — so the check the regression fold got
  // had no counterpart here, and a reviewer could label its own new finding as
  // one a commit that already shipped introduced.
  const dir = freshTmp();
  try {
    const src = path.join(dir, 'verify-auditor.json');
    writeFileSync(src, JSON.stringify({
      persona: 'auditor',
      verified: [],
      added: [{ severity: 'critical', kind: 'defect', file: 'a.mjs', line: 1,
        title: 'forged', detail: 'd', fix: null, provenance: 'regression' }],
    }));
    const r = runVerify(['--verify', src, '--outdir', dir]);

    assert.equal(r.status, 1, 'a claimed stamp is a claim about a review, not a read error');
    assert.match(r.stderr, /`added\[0\]\.provenance` is stamped by the bridge/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an ordinary verify payload is not accused of stamping anything', () => {
  // The discriminating companion: a check that refused every payload would
  // pass the test above and break the whole phase.
  const dir = freshTmp();
  try {
    const src = path.join(dir, 'verify-auditor.json');
    writeFileSync(src, JSON.stringify({
      persona: 'auditor',
      verified: [{ id: 'F1', title: 't', status: 'closed', reason: 'confirmed' }],
      added: [{ severity: 'warning', kind: 'defect', file: 'a.mjs', line: 1,
        title: 'honest', detail: 'd', fix: null }],
    }));
    const r = runVerify(['--verify', src, '--outdir', dir]);

    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /stamped by the bridge/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
