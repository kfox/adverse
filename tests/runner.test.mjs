// Tests for src/runner.mjs — subprocess invocation, retry on parse/validation
// failure, timeout, parallel order. Uses tiny inline node scripts as fake
// agents so no real model is spawned.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

import { AgentRunner, runParallel, splitCommand } from '../src/runner.mjs';

function freshTmp() {
  return mkdtempSync(path.join(tmpdir(), 'adverse-runner-'));
}

function writeScript(dir, body) {
  const src = `#!/usr/bin/env node
let prompt = '';
process.stdin.on('data', (b) => prompt += b);
process.stdin.on('end', () => {
  ${body}
  process.stdout.write(out);
  process.exit(typeof code === 'number' ? code : 0);
});
`;
  const p = path.join(dir, 'agent.mjs');
  writeFileSync(p, src);
  chmodSync(p, 0o755);
  return p;
}

const noopValidate = () => null;

async function runOne(script, prompt, validate = noopValidate, timeoutMs = 10000) {
  const r = new AgentRunner({ command: ['node', script], timeoutMs });
  return r.call(prompt, { persona: 'auditor', phase: 'round1', validate });
}

test('successful call returns parsed', async () => {
  const dir = freshTmp();
  try {
    const s = writeScript(dir, "let out = JSON.stringify({ok:true});");
    const r = await runOne(s, 'p');
    assert.equal(r.error, null);
    assert.deepEqual(r.parsed, { ok: true });
    assert.equal(r.retried, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('retries on parse failure then succeeds', async () => {
  const dir = freshTmp();
  try {
    const s = writeScript(dir, `
      let out;
      if (prompt.includes('RETRY')) out = JSON.stringify({ok:true});
      else out = 'no JSON here';
    `);
    const r = await runOne(s, 'p');
    assert.equal(r.error, null);
    assert.deepEqual(r.parsed, { ok: true });
    assert.equal(r.retried, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('validation failure triggers retry', async () => {
  const dir = freshTmp();
  try {
    const s = writeScript(dir, `
      let out;
      if (prompt.includes('RETRY')) out = JSON.stringify({persona:'auditor'});
      else out = JSON.stringify({persona:'wrong'});
    `);
    const validate = (obj) => (obj && obj.persona === 'auditor' ? null : 'wrong persona');
    const r = await runOne(s, 'p', validate);
    assert.equal(r.error, null);
    assert.equal(r.retried, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('double failure returns error', async () => {
  const dir = freshTmp();
  try {
    const s = writeScript(dir, "let out = 'still no JSON';");
    const r = await runOne(s, 'p');
    assert.notEqual(r.error, null);
    assert.match(r.error, /could not parse/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('non-zero exit does not retry', async () => {
  const dir = freshTmp();
  try {
    const s = writeScript(dir, "let out = 'ignored'; let code = 7;");
    const r = await runOne(s, 'p');
    assert.notEqual(r.error, null);
    assert.match(r.error, /exited with code 7/);
    assert.equal(r.retried, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('missing command returns error', async () => {
  const r = new AgentRunner({ command: ['/bin/no/such/binary'], timeoutMs: 5000 });
  const res = await r.call('p', { persona: 'auditor', phase: 'round1', validate: noopValidate });
  assert.notEqual(res.error, null);
});

test('timeout returns error', async () => {
  // Skip the script wrapper; write a script that hangs forever after reading stdin.
  const dir = freshTmp();
  try {
    const p = path.join(dir, 'hang.mjs');
    writeFileSync(p,
      `let _ = '';
       process.stdin.on('data', (b) => _ += b);
       process.stdin.on('end', () => {
         // Hang forever; the runner must SIGKILL us.
         setInterval(() => {}, 1_000_000);
       });
      `);
    chmodSync(p, 0o755);
    const r = await runOne(p, 'p', noopValidate, 500);
    assert.notEqual(r.error, null);
    assert.match(r.error, /timed out/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runParallel preserves order', async () => {
  const dir = freshTmp();
  try {
    const s = writeScript(dir, "let out = JSON.stringify({input_len: prompt.length});");
    const runner = new AgentRunner({ command: ['node', s], timeoutMs: 10000 });
    const jobs = [
      { persona: 'auditor',    phase: 'round1', prompt: 'x'.repeat(10),   validate: noopValidate },
      { persona: 'adversary',  phase: 'round1', prompt: 'y'.repeat(100),  validate: noopValidate },
      { persona: 'pragmatist', phase: 'round1', prompt: 'z'.repeat(1000), validate: noopValidate },
    ];
    const results = await runParallel(runner, jobs);
    assert.deepEqual(results.map((r) => r.persona), ['auditor', 'adversary', 'pragmatist']);
    assert.equal(results[0].parsed.input_len, 10);
    assert.equal(results[1].parsed.input_len, 100);
    assert.equal(results[2].parsed.input_len, 1000);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// --- Command splitting ------------------------------------------------------

test('splitCommand handles quoted args', () => {
  assert.deepEqual(splitCommand('node -e "console.log(1)"'), ['node', '-e', 'console.log(1)']);
});

test('splitCommand handles single quotes', () => {
  assert.deepEqual(splitCommand("ollama run 'llama 3.1'"), ['ollama', 'run', 'llama 3.1']);
});

test('splitCommand handles backslash inside double quotes', () => {
  assert.deepEqual(splitCommand('echo "hello \\"there\\""'), ['echo', 'hello "there"']);
});

test('splitCommand collapses runs of whitespace', () => {
  assert.deepEqual(splitCommand('  claude   -p   --model  haiku  '), ['claude', '-p', '--model', 'haiku']);
});
