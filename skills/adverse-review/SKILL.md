---
name: adverse-review
description: >
  Multi-agent adversarial code review. Spawns three reviewer subagents
  (Auditor, Adversary, Pragmatist) on a single model, runs a cross-examination
  round, then deterministically synthesizes a single ranked report. Use this
  for non-trivial PRs, security-sensitive changes, refactors that touch many
  files, or any change where one perspective has obvious blind spots. Trigger
  phrases include "adverse review", "adversarial review", "multi-perspective
  review", "review my changes from multiple angles", "panel review". NOT
  suitable for trivial diffs (typos, dependency bumps, formatting).
---

# Adverse — Multi-Agent Adversarial Code Review

This skill is the Claude Code-native side of the
[adverse](https://github.com/addyosmani/adverse) project. The same logic is
also available as a standalone CLI (`adverse review …`). When you run inside
Claude Code, prefer this skill — it uses Claude Code's native Agent tool to
spawn reviewers (no subprocess auth issues, faster) and calls Node helpers
only for the deterministic collection, triage, and synthesis steps.

## What this fork changes, and why it cannot go upstream

The flow below hands reviewers a **repo checkout plus a pinned merge-base SHA**
instead of a pre-collected source blob, and hands round 2 a **triaged briefing**
instead of the source blob a second time.

That is only sound because Claude Code subagents run on the same filesystem as
the repo. The standalone CLI subprocesses a coding agent (`claude -p`,
`codex exec`, …) that cannot be assumed to share a filesystem, a working
directory, or a git binary with the repo under review — the collected blob
exists *precisely* so those agents can review code they cannot open. **Do not
port the read-the-repo-directly parts of this file upstream.** The Node helpers
under `scripts/` are upstreamable; this file's flow is not.

Measured on one real 39-file branch, same model, same personas:

| | Round 1 blob flow (v1) | Read-the-repo + briefing (v2) |
|---|---|---|
| Auditor | 197k tokens · 84 tool calls · 28 min | ~124k tokens · 32-34 tool calls · ~6 min |
| Adversary | 155k tokens | ~124k tokens · 32-34 tool calls · ~6 min |
| Pragmatist | 150k tokens | ~124k tokens · 32-34 tool calls · ~6 min |
| Total | ~503k tokens | ~372k tokens |

The v2 reviewers did *more* verification work — they open files the blob would
have truncated away — for less. The round-2 briefing is ~30KB against a ~250KB
source block, an 88% reduction on the largest single input.

## When to use this skill

The user explicitly asked for an adversarial / multi-perspective / panel
review of their code, OR they're about to merge / land / ship a non-trivial
change and asked for one more pass. If the diff is trivially mechanical
(formatting, dependency bumps, typos), do NOT invoke this — say so and stop.

## Prerequisites

`node` (>= 20) on PATH. Verify with `node --version`. The skill scripts live
under `${SKILL_DIR}/scripts/` and are stdlib-only (no `npm install` needed).

If `node` is missing, tell the user: install Node 20+ from nodejs.org (or
their package manager) and re-invoke. Do not fall back to a different
implementation; the deterministic synthesizer is the contract.

## Phase 0 — scope, run directory, and the repo's own gate

**Pick scope.**

1. If the user named a path, that's the scope.
2. Else if `git status --porcelain` reports uncommitted changes, review those
   (diff mode against `HEAD`).
3. Else if the current branch is ahead of `main` (or `master` / the configured
   upstream), review the diff since the merge base.
4. Else review the whole working directory.

State the scope you picked in one sentence so the user can redirect.

**Pick a run directory.** Use the session scratchpad directory when the harness
provides one; otherwise `mktemp -d`. Everything below writes there. Never
hardcode `/tmp/adverse-*` — parallel runs collide, and the files outlive the
session.

```bash
ADVERSE_RUN="${SCRATCHPAD:-$(mktemp -d)}/adverse-run"   # SCRATCHPAD = session scratchpad if the harness gave you one
mkdir -p "$ADVERSE_RUN"
```

**Run the repo's own gate first, and abort if it is red.** Whatever this repo
calls its checks — `make check`, `npm test`, `cargo test`, lint, typecheck —
run them before spending a single reviewer token. Two reasons:

- A red gate means the change is not ready for a panel. Say so and stop; a
  failing build makes every reviewer waste findings on symptoms of it.
- A green gate is *evidence*, and reviewers should be told about it. Findings
  that a type-checker, linter, or test suite would already have caught are pure
  noise, and reviewers reliably produce them when they don't know the tools ran.

Record a one-line summary — it rides into the briefing in Phase 3:

```bash
GATE="lint green · pyright/mypy clean · 1,412 tests pass (0 fail, 3 skip) · schema no drift"
```

**Pin the base.** Every reviewer must read the same tree, and the triage step
needs a stable ref for its in-diff/outside-diff classification:

```bash
BASE=$(git merge-base HEAD origin/main)   # or the branch the user named
```

## Phase 1 — file list, not a source blob

Reviewers read the repo themselves, so all you need is the inventory and the
diff stat:

```bash
git diff --stat "$BASE"...HEAD | tee "$ADVERSE_RUN/diffstat.txt"
git diff --name-only "$BASE"...HEAD > "$ADVERSE_RUN/files.txt"
```

`collect.mjs` still exists and still works — it is what the standalone CLI
needs, and it is the fallback if the reviewers you spawn somehow cannot reach
the filesystem. In this flow, skip it: a 250KB blob costs every reviewer the
same tokens whether or not they needed the file, and it truncates exactly the
large files most worth reading.

## Phase 2 — round 1: independent reviews

Spawn **three reviewers in parallel** using Claude Code's Agent tool, one per
persona. Each one gets:

- **System prompt**: read from `${SKILL_DIR}/scripts/prompts/<persona>.txt`
  (auditor / adversary / pragmatist).
- **User message**: `${SKILL_DIR}/scripts/prompts/round1.txt`, then:
  - the repo path and the pinned `$BASE` SHA, with the instruction to read the
    diff and the files directly (`git diff $BASE...HEAD -- <path>`, then open
    whatever the diff makes them want to see);
  - the diffstat and file list from Phase 1;
  - the gate summary `$GATE`, with the instruction **not** to report anything
    those tools already prove.
- **Model**: `opus` unless the user asked for a different one. If the user
  picks a smaller model, pass it to all three personas — different models
  across personas defeats the single-model design.

Each subagent must respond with a single JSON object matching this schema:

```json
{
  "persona": "<auditor|adversary|pragmatist>",
  "verdict": "approve|conditional|reject",
  "summary": "<one sentence>",
  "findings": [
    {
      "severity": "critical|warning|info",
      "file": "<path or null>",
      "line": <int or null>,
      "title": "<short noun phrase>",
      "detail": "<2-6 sentences>",
      "fix": "<concrete remediation or null>"
    }
  ]
}
```

`file` and `line` are load-bearing in this flow, not decoration: Phase 3
claim-checks them against the checkout, and round 2 navigates by them instead
of by a source block. Tell reviewers that an unanchored finding is a finding
nobody can verify.

Save each parsed JSON object to `$ADVERSE_RUN/round1-<persona>.json`.

If a subagent returns malformed JSON, **retry that one persona once** with
the parser/validator error appended to the original prompt. If the retry also
fails, drop that persona. If fewer than 2 personas survive, abort the run and
report the failure — synthesis requires at least 2 voices.

## Phase 3 — triage (deterministic, no model)

This is the step that makes round 2 cheap and makes cross-lane consensus
survive. Run it before spawning anything:

```bash
node ${SKILL_DIR}/scripts/triage.mjs \
    --round1 "$ADVERSE_RUN"/round1-auditor.json \
    --round1 "$ADVERSE_RUN"/round1-adversary.json \
    --round1 "$ADVERSE_RUN"/round1-pragmatist.json \
    --repo . \
    --base "$BASE" \
    --gate "$GATE" \
    --out "$ADVERSE_RUN"/briefing.json
```

It prints a summary and writes the briefing. What it gives you:

- **Stable IDs** (`F1`..`Fn`) for every finding, so round 2 can reference a
  finding without retyping its title. Synthesis still joins on title; Phase 5
  repairs the title from the ID so it cannot miss.
- **Claim checks.** A cited file that doesn't exist, or a line past end of
  file, is marked `DISPROVED` before any model spends a token on it.
- **Clusters** — same file, within 15 lines, different reporters — and
  **cross-file co-citations**, where one finding's prose names another
  finding's file. These are candidate *one defect, seen twice*: exactly the
  pairs the title join drops on the floor.
- **In-diff classification.** `inDiff: "outside"` means the cited line is not
  in the diff. That is **annotated, never rejected** — a latent bug the change
  newly makes reachable lives in unchanged lines by definition, and in the run
  that motivated this flow the only CRITICAL on the table was one of those.
  Round 2 is told to judge whether the finding explains why *this diff* puts
  it in play, not to discard it.

Read the summary line yourself. A large `DISPROVED` count means a reviewer was
inventing line numbers — worth telling the user.

## Phase 4 — round 2: cross-review from the briefing

For each persona that produced a valid round-1 review, spawn a subagent with
the same persona system prompt and a user message of:

1. `${SKILL_DIR}/scripts/prompts/round2.txt`
2. `$ADVERSE_RUN/briefing.json`
3. the repo path and `$BASE` again

**Not the source block.** The briefing (~30KB) anchors every finding to a file
and line; reviewers open exactly the regions they need to rule on. That is the
88% input reduction in the table above, and it buys deeper verification, not
shallower — a reviewer chasing one finding reads 200 lines of real context
instead of whatever survived the blob's truncation.

Round 2 must produce an explicit one-defect-or-two ruling on every cluster and
every cross-reference. That ruling is the whole point: when two personas found
one root cause under two titles, the validate edge is what turns two lone
opinions into consensus.

Output schema:

```json
{
  "persona": "<auditor|adversary|pragmatist>",
  "validate":  [{ "id": "F3", "from": "<reporter>", "title": "<verbatim>", "reason": "<…>" }],
  "challenge": [{ "id": "F7", "from": "<reporter>", "title": "<verbatim>", "reason": "<…>" }],
  "added":     [<finding object>]
}
```

Save each to `$ADVERSE_RUN/round2-<persona>.json`.

If the user asked for a faster review or `--single-round`, skip phases 4 and 5
entirely. The synthesizer treats missing round 2 as an empty cross-review.

## Phase 5 — repair, then combine

Repair rewrites each edge's title to the briefing's canonical string, keyed on
the finding ID, so a paraphrase or a helpfully-fixed typo cannot silently drop
the edge:

```bash
node ${SKILL_DIR}/scripts/repair.mjs \
    --briefing "$ADVERSE_RUN"/briefing.json \
    --round2 "$ADVERSE_RUN"/round2-auditor.json \
    --round2 "$ADVERSE_RUN"/round2-adversary.json \
    --round2 "$ADVERSE_RUN"/round2-pragmatist.json \
    --outdir "$ADVERSE_RUN"
```

It exits non-zero when an edge names an ID that isn't in the briefing — a
reviewer invented a finding number, and that edge is about to vanish. Read the
stderr lines and decide; do not ignore the exit code.

Then combine both rounds:

```bash
node ${SKILL_DIR}/scripts/combine.mjs \
    --round1 "$ADVERSE_RUN"/round1-*.json \
    --out "$ADVERSE_RUN"/round1.json

node ${SKILL_DIR}/scripts/combine.mjs \
    --round2 "$ADVERSE_RUN"/round2-*.repaired.json \
    --out "$ADVERSE_RUN"/round2.json
```

Combine the `.repaired.json` files, not the raw ones. That is the whole reason
Phase 5 exists.

## Phase 6 — synthesize

Run the deterministic synthesizer. This produces the canonical report — never
LLM-render the findings yourself, the synthesizer's groupings (cross-validated
/ consensus / disputed / solo) carry the signal.

```bash
node ${SKILL_DIR}/scripts/synthesize.mjs \
    --round1 "$ADVERSE_RUN"/round1.json \
    --round2 "$ADVERSE_RUN"/round2.json \
    --out "$ADVERSE_RUN"/report.md \
    --json-out "$ADVERSE_RUN"/report.json \
    --html-out "$ADVERSE_RUN"/report.html
```

Read `$ADVERSE_RUN/report.md` and present a **summary** to the user, not the
full report:

1. The verdict line (e.g., `SHIP-WITH-CAVEATS (2/3 ship, 1/3 block)`).
2. Counts by severity and confidence.
3. The top 3 findings (cross-validated first, then consensus, then disputed)
   with one-line previews.
4. A pointer to the full report on disk and the HTML dashboard.

Then ask the user how they want to proceed:

- Apply fixes for cross-validated findings only? (highest confidence)
- Apply fixes for everything except disputed? (most common)
- Show me a specific finding's full reasoning?
- Just save the report; I'll review it myself.

Do not start editing files until the user picks one.

## Phase 7 — clean up

After the user is done with the report, delete `$ADVERSE_RUN` and tell the
user the run is complete. Do not commit those files.

## Failure handling

| Failure | What to do |
|---|---|
| The repo's own gate is red | Stop before Phase 2. Report which check failed; a panel review of a broken build is wasted tokens. |
| `git merge-base` finds no base | Ask the user which ref to diff against. Do not guess `main`. |
| One reviewer returns garbage twice | Continue with 2 reviewers, mark the run "degraded" in your summary. |
| ≥2 reviewers fail | Abort. Tell the user the model is misbehaving and suggest re-running with a different model or with `--single-round`. |
| `triage.mjs` reports many `DISPROVED` | Surface it. Those findings are dead, and a reviewer inventing line numbers is worth the user knowing about. |
| `repair.mjs` exits non-zero | Read the unresolvable IDs on stderr. Usually one invented ID; drop that edge and continue. |
| `node` not on PATH | Tell the user to install Node 20+. Do not improvise a fallback. |
| User interrupts | Stop spawning new subagents. Tell the user where the partial artifacts are. |

## Notes for the orchestrator

- This skill spends ~6 model calls (3 × round-1 + 3 × round-2). Skip round 2
  on user request to halve it.
- Persona prompts are deliberately written to "stay in your lane" — do NOT
  override them with general-purpose review instructions, doing so collapses
  the orthogonality the design relies on.
- The synthesizer is deterministic Node code (`synthesize.mjs`). Counting
  validate/challenge edges is the consensus signal; do not run a fourth LLM
  "judge" pass. Triage and repair are deterministic for the same reason: they
  exist to keep a real edge from being lost, never to invent one.
- `prompts/round2.txt` in this fork is hand-written for the briefing flow and
  no longer matches `PHASE2_INSTRUCTIONS` in `src/prompts.mjs`. Running
  `dump-prompts.mjs` will overwrite it with the CLI's version. Don't, until
  the two are reconciled upstream.
- The standalone CLI (`adverse review`) is an alternative path that
  subprocesses any coding agent (`claude -p`, `codex exec`, …). Mention it
  to the user only if they ask how to run this without Claude Code — and note
  that it uses the blob flow, not this one.
