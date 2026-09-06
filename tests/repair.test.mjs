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
