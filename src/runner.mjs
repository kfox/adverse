// Subprocess orchestration: invoke the user's coding-agent CLI in parallel.
//
// The agent receives the prompt over stdin (so prompts of any size are safe
// and we don't hit OS argv length limits). All personas in one phase run in
// parallel via Promise.all. We retry once on parse/validation failure, with
// the error message fed back so the model can self-correct.

import { spawn } from 'node:child_process';

import { refuseDirectRun } from './entryGuard.mjs';
import { extractJson, ParseError } from './parse.mjs';

refuseDirectRun(import.meta.url);

const RETRY_PREAMBLE = `\n\n---\n\n# RETRY — your previous response was rejected\n\nReason: `;
const RETRY_TAIL = `\n\nRe-emit your response as a single JSON object that satisfies the schema above. No markdown fences. No prose outside the JSON. Match every required key exactly.`;

function buildRetryPrompt(original, err) {
  return `${original}${RETRY_PREAMBLE}${err}${RETRY_TAIL}`;
}

// Cross-platform shlex: split a command string into argv. Handles single and
// double quotes (with backslash escapes inside double quotes), treats unquoted
// whitespace as separators. Adequate for typical agent invocations like
// `claude -p --model haiku` or `codex exec --quiet`.
export function splitCommand(cmd) {
  const out = [];
  let cur = '';
  let i = 0;
  let quote = null; // null | "'" | '"'
  while (i < cmd.length) {
    const ch = cmd[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      else cur += ch;
    } else if (quote === '"') {
      if (ch === '\\' && i + 1 < cmd.length) {
        cur += cmd[i + 1];
        i++;
      } else if (ch === '"') quote = null;
      else cur += ch;
    } else {
      if (ch === "'" || ch === '"') quote = ch;
      else if (/\s/.test(ch)) {
        if (cur) {
          out.push(cur);
          cur = '';
        }
      } else cur += ch;
    }
    i++;
  }
  if (cur) out.push(cur);
  return out;
}

export class AgentRunner {
  constructor({ command, timeoutMs, verbose = false }) {
    this.command = Array.isArray(command) ? command : splitCommand(command);
    this.timeoutMs = timeoutMs;
    this.verbose = verbose;
  }

  static fromString(cmd, { timeoutMs, verbose = false } = {}) {
    return new AgentRunner({ command: splitCommand(cmd), timeoutMs, verbose });
  }

  // Returns: { stdout, stderr, code, timedOut }.
  invoke(prompt) {
    return new Promise((resolve) => {
      const [bin, ...args] = this.command;
      const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
      const chunks = { out: [], err: [] };
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill('SIGKILL');
        } catch {
          /* already dead */
        }
      }, this.timeoutMs);

      child.stdout.on('data', (b) => chunks.out.push(b));
      child.stderr.on('data', (b) => chunks.err.push(b));

      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({
          stdout: '',
          stderr: `spawn error: ${err.message}`,
          code: err.code === 'ENOENT' ? 127 : 1,
          timedOut: false,
        });
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({
          stdout: Buffer.concat(chunks.out).toString('utf-8'),
          stderr: Buffer.concat(chunks.err).toString('utf-8'),
          code: timedOut ? 124 : code ?? 0,
          timedOut,
        });
      });

      try {
        child.stdin.end(prompt);
      } catch {
        // child died before we could write — onClose handler will fire.
      }
    });
  }

  // Returns: { persona, phase, parsed, rawStdout, error, durationMs, retried }
  async call(prompt, { persona, phase, validate }) {
    let attemptPrompt = prompt;
    let retried = false;
    let lastErr = null;
    let rawStdout = '';

    for (let attempt = 0; attempt < 2; attempt++) {
      const t0 = Date.now();
      const { stdout, stderr, code, timedOut } = await this.invoke(attemptPrompt);
      const durationMs = Date.now() - t0;
      rawStdout = stdout;

      if (this.verbose) {
        process.stderr.write(
          `[${persona}/${phase}] attempt=${attempt + 1} exit=${code} ` +
            `duration=${(durationMs / 1000).toFixed(1)}s ` +
            `stdout=${stdout.length}B stderr=${stderr.length}B\n`,
        );
      }

      if (timedOut) {
        return {
          persona, phase, parsed: null, rawStdout: stdout,
          error: `timed out after ${(this.timeoutMs / 1000).toFixed(0)}s`,
          durationMs, retried,
        };
      }
      if (code !== 0) {
        return {
          persona, phase, parsed: null, rawStdout: stdout,
          error: `agent exited with code ${code}: ${stderr.trim().slice(0, 400)}`,
          durationMs, retried,
        };
      }

      let parsed;
      try {
        parsed = extractJson(stdout);
      } catch (e) {
        if (!(e instanceof ParseError)) throw e;
        lastErr = `could not parse JSON from agent output: ${e.message}`;
        if (attempt === 0) {
          attemptPrompt = buildRetryPrompt(prompt, lastErr);
          retried = true;
          continue;
        }
        return { persona, phase, parsed: null, rawStdout: stdout, error: lastErr, durationMs, retried };
      }

      const verr = validate(parsed);
      if (verr !== null) {
        lastErr = `agent output failed validation: ${verr}`;
        if (attempt === 0) {
          attemptPrompt = buildRetryPrompt(prompt, lastErr);
          retried = true;
          continue;
        }
        return { persona, phase, parsed, rawStdout: stdout, error: lastErr, durationMs, retried };
      }

      return { persona, phase, parsed, rawStdout: stdout, error: null, durationMs, retried };
    }

    return {
      persona, phase, parsed: null, rawStdout,
      error: lastErr ?? 'unknown error', durationMs: 0, retried,
    };
  }
}

// Run a list of {persona, phase, prompt, validate} jobs. Order is preserved.
export async function runParallel(runner, jobs) {
  return Promise.all(jobs.map((j) => runner.call(j.prompt, { persona: j.persona, phase: j.phase, validate: j.validate })));
}
