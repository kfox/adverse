// Extract a JSON object from a coding agent's stdout.
//
// Different CLIs wrap their output differently:
//  - Claude Code (`claude -p`): plain text by default; with `--output-format
//    json`, emits {"result": "..."} where the inner string is the model output.
//  - Anthropic content-block format: {"content": [{"type":"text","text":...}]}
//  - Codex CLI: plain text, occasionally with banner metadata.
//  - Ollama / Gemini: plain text, sometimes with terminal escapes.
//
// Strategy:
//  1. Try to parse the whole stdout as JSON. If it parses to a known wrapper
//     shape, unwrap it. If it parses to a JSON-encoded string, parse the inner.
//  2. Otherwise, scan for the first balanced `{...}` block by string-aware
//     brace matching, then try to parse that.
//  3. If both fail, throw ParseError with a stdout preview for the caller.
//
// We deliberately do NOT try to fix malformed JSON. Retry-with-feedback is the
// contract: if the agent emits invalid JSON, the runner re-prompts it.

export class ParseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ParseError';
  }
}

const FENCE_RE = /^\s*```(?:json)?\s*\n([\s\S]*?)\n\s*```\s*$/i;

function stripFences(text) {
  const m = text.match(FENCE_RE);
  return m ? m[1] : text;
}

function tryParse(text, { allowUnwrap }) {
  const stripped = stripFences(text.trim());
  const obj = JSON.parse(stripped);
  return allowUnwrap ? unwrap(obj) : obj;
}

function unwrap(obj) {
  if (obj !== null && typeof obj === 'object' && !Array.isArray(obj)) {
    // Claude Code --output-format json: {"result": "..."}
    if (typeof obj.result === 'string') {
      return tryParse(obj.result, { allowUnwrap: false });
    }
    // Anthropic content-block: {"content": [{"type":"text","text":...}, ...]}
    if (Array.isArray(obj.content)) {
      for (const block of obj.content) {
        if (block && block.type === 'text' && typeof block.text === 'string') {
          return tryParse(block.text, { allowUnwrap: false });
        }
      }
    }
  } else if (typeof obj === 'string') {
    // Plain-string shape: top-level JSON is itself a JSON-encoded string.
    try {
      return tryParse(obj, { allowUnwrap: false });
    } catch {
      return obj;
    }
  }
  return obj;
}

// Find the first balanced top-level `{...}` substring, ignoring braces inside
// JSON strings. Not a JSON parser — just balanced braces with string awareness.
// Good enough to find the agent's response when banners precede it.
function findFirstJsonObject(text) {
  let depth = 0;
  let start = -1;
  let inStr = false;
  let escape = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start >= 0) return text.slice(start, i + 1);
      }
    }
  }
  return null;
}

export function extractJson(stdout) {
  if (!stdout || !stdout.trim()) {
    throw new ParseError('agent produced empty output');
  }

  // Path 1: whole stdout parses (possibly through a wrapper).
  try {
    return tryParse(stdout, { allowUnwrap: true });
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw e;
  }

  // Path 2: balanced {...} substring (banners, escape codes, footer text).
  const candidate = findFirstJsonObject(stdout);
  if (candidate !== null) {
    try {
      return tryParse(candidate, { allowUnwrap: true });
    } catch (e) {
      const preview = stdout.length > 600 ? stdout.slice(0, 600) + '…' : stdout;
      throw new ParseError(
        `found a JSON-shaped substring but it failed to parse: ${e.message}\n---\n${preview}`,
      );
    }
  }

  const preview = stdout.length > 600 ? stdout.slice(0, 600) + '…' : stdout;
  throw new ParseError(`no JSON object found in agent output\n---\n${preview}`);
}
