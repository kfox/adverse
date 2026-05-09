# Claude CLI output fixtures

These fixtures pin the raw stdout shapes that `src/parse.mjs` must keep
accepting, plus the schema that `src/prompts.mjs` validators must keep
accepting. They exist because the unit suite cannot spawn `claude -p` (it
needs a paid API key, and nesting Claude Code under itself doesn't
authenticate). Without pinned fixtures, a silent contract drift in the
upstream CLI would surface only as a parse failure in production.

`claude-compat.test.mjs` parametrizes over every `*.json` and `*.txt` file
here and asserts that each one round-trips through `extractJson` to a
payload that satisfies the appropriate validator.

## File naming

`<phase>_<persona>__<shape>.<ext>`

- `phase` — `round1` or `round2`.
- `persona` — `auditor` / `adversary` / `pragmatist` / `clean` (any persona).
- `shape` — wrapper format being pinned:
  - `result_shape` — `{"result": "<inner JSON as string>"}`.
  - `content_block` — `{"content": [{"type": "text", "text": ...}]}`.
  - `content_block_not_first` — content list with non-text block before text.
  - `plain_string` — top-level JSON-encoded string.
  - `result_with_fences` — wrapper above, but inner string includes
    \`\`\`json fences.
  - `banner_then_json` — leading prose + raw JSON (some CLIs print banners).
  - `raw` — JSON written directly to stdout, no wrapper, no fences.

## Adding a fixture

When Anthropic ships a CLI change that alters the wrapper, capture the new
raw output to a file here. Naming + JSON shape must be valid for the relevant
validator. The contract test auto-discovers every file — no test edit needed.
