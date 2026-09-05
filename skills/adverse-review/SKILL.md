---
name: adverse-review
description: >
  Multi-agent adversarial code review that converges. Spawns reviewer subagents
  (Auditor, Adversary, Steward, Pragmatist) on a single model, cross-examines,
  then deterministically synthesizes one ranked report — and can iterate:
  fix, verify, repeat, until nothing blocking is left. Use for non-trivial PRs,
  security-sensitive changes, refactors touching many files, or any change
  where one perspective has obvious blind spots. Trigger phrases include
  "adverse review", "adversarial review", "multi-perspective review", "review
  my changes from multiple angles", "panel review", "review until clean". NOT
  suitable for trivial diffs (typos, dependency bumps, formatting).
---

# Adverse — Multi-Agent Adversarial Code Review

This skill is the Claude Code-native side of the
[adverse](https://github.com/addyosmani/adverse) project, optimized for Claude
Code. It uses the native Agent tool to spawn reviewers and calls Node helpers
for every deterministic step — collection, triage, tracing, synthesis, and the
stop condition. No model ever judges whether the review is finished.

## When to use this skill

The user explicitly asked for an adversarial / multi-perspective / panel
review, OR they're about to merge a non-trivial change and asked for one more
pass. If the diff is trivially mechanical (formatting, dependency bumps,
typos), do NOT invoke this — say so and stop.

## Prerequisites

`node` (>= 20) on PATH. Verify with `node --version`. The skill scripts live
under `${SKILL_DIR}/scripts/` and are stdlib-only (no `npm install` needed).

If `node` is missing, tell the user: install Node 20+ from nodejs.org (or their
package manager) and re-invoke. Do not fall back to a different implementation;
the deterministic synthesizer is the contract.

## The two shapes of a run

**Single pass** (default) — review, report, hand the findings to the user.
Phases 0–7.

**Convergence loop** — review, fix, verify, repeat until nothing blocking is
left. Phases 0–7, then 8–9, looping. Use it when the user says "until clean",
"until it's done", "keep going", or asks to institutionalize review in a
workflow. Announce which shape you are running.

The loop terminates on arithmetic, not on judgment: `converge.mjs` counts the
findings that are both credible enough (cross-validated or consensus) and
consequential enough (not advisory, not `info`) and not already settled. It is
capped at 3 iterations, and a run that hits the cap is a **stop, not a pass**.

## The four lanes

| Persona | Owns | Kinds |
|---|---|---|
| **Auditor** | correctness: does it compute the right answer | `defect`, `behavioral` |
| **Adversary** | what an attacker can do | `defect`, `behavioral` (with an attack) |
| **Steward** | what the code says about itself: docs, schemas, rules, and tests | `contract`, `behavioral` |
| **Pragmatist** | shape: structure, coupling, complexity | `design` — **advisory** |

Two rules follow from that table and both are load-bearing:

- **`design` findings never block.** Design opinions do not converge — a
  reviewer can always want different structure — so counting them means the
  loop never ends. They are reported, ranked, and handed to the user as a
  backlog. Never treat one as a merge gate, and never let one hold a loop open.
- **Never override a persona prompt with general review instructions.** The
  lanes are what let a single model act as a panel; blurring them produces the
  same finding from two agents, and two independent-looking reports of one
  issue is exactly what synthesis reads as cross-validated consensus. That is
  the one signal the whole design trusts most, and it is the easiest to
  counterfeit.

## Phase 0 — scope, run directory, and the repo's own gate

**Pick scope.**

1. If the user named a path, that's the scope.
2. Else if `git status --porcelain` reports uncommitted changes, review those
   (diff mode against `HEAD`).
3. Else if the current branch is ahead of `main` (or `master` / the configured
   upstream), review the diff since the merge base.
4. Else review the whole working directory.

State the scope you picked in one sentence so the user can redirect.

**Pick a run directory.** Use the session scratchpad when the harness provides
one; otherwise `mktemp -d`. Everything below writes there. Never hardcode
`/tmp/adverse-*` — parallel runs collide and the files outlive the session.

```bash
ADVERSE_RUN="${SCRATCHPAD:-$(mktemp -d)}/adverse-run"
mkdir -p "$ADVERSE_RUN"
```

**Run the repo's own gate first, and abort if it is red.** Whatever this repo
calls its checks — `make check`, `npm test`, `cargo test`, lint, typecheck —
run them before spending a single reviewer token. Two reasons:

- A red gate means the change is not ready for a panel. Say so and stop; a
  failing build makes every reviewer waste findings on symptoms of it.
- A green gate is *evidence*, and reviewers should be told about it. Findings a
  type-checker, linter, or test suite would already have caught are pure noise,
  and reviewers reliably produce them when they don't know the tools ran.

Record a one-line summary — it rides into the briefing in Phase 3:

```bash
GATE="lint green · pyright/mypy clean · 1,412 tests pass (0 fail, 3 skip) · schema no drift"
```

**Pin the base.** Every reviewer must read the same tree, and triage needs a
stable ref for its in-diff classification:

```bash
BASE=$(git merge-base HEAD origin/main)   # or the branch the user named
```

**Start a ledger if this is a convergence loop.** It is just a path; the first
`--record` creates it.

```bash
# NOT inside $ADVERSE_RUN. The run directory is session-scoped scratch; the
# ledger has to outlive it, because a later pass on the same branch is exactly
# the thing that must start from these conclusions.
LEDGER_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/adverse"
mkdir -p "$LEDGER_DIR"
LEDGER="$LEDGER_DIR/$(git rev-parse --abbrev-ref HEAD | tr / -).ledger.json"
```

## Phase 1 — file list and lane scoping

Reviewers read the repo themselves, so all you need is the inventory:

```bash
git diff --stat "$BASE"...HEAD | tee "$ADVERSE_RUN/diffstat.txt"
git diff --name-only "$BASE"...HEAD > "$ADVERSE_RUN/files.txt"
```

Then ask whether the Adversary lane has anything to look at:

```bash
node ${SKILL_DIR}/scripts/scope.mjs --repo . --base "$BASE"   # exit 0 = run, 1 = skip
```

It is a **budget hint, not a security judgment**, and it is biased toward
running: a false positive costs two model calls, a false negative ships a
vulnerability nobody looked for. Skip the lane only when it says skip AND the
user has not asked for a thorough pass. If you skip it, **say so out loud** and
pass it to the synthesizer in Phase 6 — a lane that was skipped and not
mentioned reads exactly like a lane that looked and found nothing.

`collect.mjs` still exists and still works — it is what the standalone CLI
needs, and it is the fallback if spawned reviewers cannot reach the filesystem.
In this flow, skip it: a 250KB blob costs every reviewer the same tokens
whether or not they needed the file, and it truncates exactly the large files
most worth reading.

## Phase 2 — round 1: independent reviews

Spawn the selected reviewers **in parallel** using the Agent tool, one per
persona. Each gets:

- **System prompt**: `${SKILL_DIR}/scripts/prompts/<persona>.txt`
  (auditor / adversary / steward / pragmatist).
- **User message**: `${SKILL_DIR}/scripts/prompts/round1.txt`, then:
  - the repo path and the pinned `$BASE` SHA, with the instruction to read the
    diff and the files directly (`git diff $BASE...HEAD -- <path>`, then open
    whatever the diff makes them want to see);
  - the diffstat and file list from Phase 1;
  - the gate summary `$GATE`, with the instruction **not** to report anything
    those tools already prove.
- **Model**: `opus` unless the user asked otherwise. If the user picks a smaller
  model, pass it to every persona — mixing models across personas defeats the
  single-model design.

The Steward needs one thing the others don't: point it at where this repo keeps
its rules and its architecture notes (`CLAUDE.md`, `CONTRIBUTING.md`,
`docs/architecture*`, a committed schema). Its lane is code-versus-claim, and
it cannot check a claim it was never shown.

Each subagent must respond with a single JSON object:

```json
{
  "persona": "<auditor|adversary|steward|pragmatist>",
  "verdict": "approve|conditional|reject",
  "summary": "<one sentence>",
  "findings": [
    {
      "severity": "critical|warning|info",
      "kind": "defect|behavioral|contract|design",
      "file": "<path or null>",
      "line": <int or null>,
      "counterpart": "<path this contradicts, for kind=contract; else null>",
      "title": "<short noun phrase>",
      "detail": "<2-6 sentences>",
      "fix": "<concrete remediation or null>"
    }
  ]
}
```

`kind`, `file`, and `line` are load-bearing, not decoration. Phase 3
claim-checks them, round 2 navigates by them instead of by a source block, and
`kind` decides whether a finding can block. Tell reviewers that an unanchored
finding is a finding nobody can verify.

Save each parsed object to `$ADVERSE_RUN/round1-<persona>.json`.

If a subagent returns malformed JSON, **retry that one persona once** with the
validator error appended. If the retry also fails, drop that persona. If fewer
than 2 personas survive, abort — synthesis needs at least 2 voices.

## Phase 3 — triage (deterministic, no model)

This is what makes round 2 cheap and what keeps cross-lane consensus alive:

```bash
node ${SKILL_DIR}/scripts/triage.mjs \
    --round1 "$ADVERSE_RUN"/round1-*.json \
    --repo . --base "$BASE" --gate "$GATE" \
    ${LEDGER:+--ledger "$LEDGER"} \
    --out "$ADVERSE_RUN"/briefing.json
```

What it gives you:

- **Stable IDs** (`F1`..`Fn`), so round 2 references a finding without retyping
  its title.
- **Claim checks.** A cited file that doesn't exist, a line past EOF, or a
  `counterpart` that isn't in the checkout is `DISPROVED` before any model
  spends a token on it.
- **Kind checks.** A `defect` with no line, a `contract` with no counterpart —
  under-anchored, *annotated not rejected*. The reporter may have found
  something real and merely labeled it carelessly, and only a reviewer can tell
  those apart.
- **Clusters** (same file, within 15 lines, different reporters) and
  **cross-file co-citations** (one finding's prose names another's file). These
  are candidate *one defect seen twice* — exactly the pairs a title join drops.
- **In-diff classification.** `inDiff: "outside"` is **annotated, never
  rejected**: a latent bug the change newly makes reachable lives in unchanged
  lines by definition, and in the run that motivated this flow the only
  CRITICAL on the table was one of those.
- **Ledger annotations**, on later iterations: `settled` findings an earlier
  pass decided, and `REGRESSED` ones recorded fixed that came back.

Read the summary line. A large `DISPROVED` count means a reviewer was inventing
line numbers — tell the user. Any `REGRESSED` count is the most important line
in the run.

## Phase 4 — round 2: cross-review from the briefing

For each persona that produced a valid round-1 review **except the
Pragmatist**, spawn a subagent with the same persona system prompt and:

1. `${SKILL_DIR}/scripts/prompts/round2.txt`
2. `$ADVERSE_RUN/briefing.json`
3. the repo path and `$BASE`

**The Pragmatist skips round 2.** Its findings are advisory: cross-validation
exists to decide what blocks, and nothing it reports can. Its round-1 output
goes to the user as-is. That saved call is what pays for the Steward's.

**Do not re-send the source block.** The briefing (~30KB) anchors every finding
to a file and line; reviewers open exactly the regions they need. That is ~30KB
where the blob was ~250KB, and it buys *deeper* verification — a reviewer
chasing one finding reads 200 lines of real context instead of whatever
survived the blob's truncation.

Round 2 must produce an explicit one-defect-or-two ruling on every cluster and
every cross-reference. That ruling is the point: when two personas found one
root cause under two titles, the validate edge is what turns two lone opinions
into consensus.

Save each to `$ADVERSE_RUN/round2-<persona>.json`.

If the user asked for a faster review, skip phases 4–5. The synthesizer treats
a missing round 2 as an empty cross-review.

## Phase 5 — repair, then combine

Repair rewrites each edge's title to the briefing's canonical string, keyed on
the finding ID, so a paraphrase cannot silently drop the edge:

```bash
node ${SKILL_DIR}/scripts/repair.mjs \
    --briefing "$ADVERSE_RUN"/briefing.json \
    --round2 "$ADVERSE_RUN"/round2-auditor.json \
    --round2 "$ADVERSE_RUN"/round2-adversary.json \
    --round2 "$ADVERSE_RUN"/round2-steward.json \
    --outdir "$ADVERSE_RUN"
```

It exits non-zero when an edge names an ID not in the briefing — a reviewer
invented a finding number and that edge is about to vanish. Read the stderr
lines; do not ignore the exit code.

Then combine both rounds:

```bash
node ${SKILL_DIR}/scripts/combine.mjs --round1 "$ADVERSE_RUN"/round1-*.json \
    --out "$ADVERSE_RUN"/round1.json
node ${SKILL_DIR}/scripts/combine.mjs --round2 "$ADVERSE_RUN"/round2-*.repaired.json \
    --out "$ADVERSE_RUN"/round2.json
```

Combine the `.repaired.json` files, not the raw ones. That is the whole reason
Phase 5 exists.

## Phase 6 — synthesize

```bash
node ${SKILL_DIR}/scripts/synthesize.mjs \
    --round1 "$ADVERSE_RUN"/round1.json \
    --round2 "$ADVERSE_RUN"/round2.json \
    --out "$ADVERSE_RUN"/report.md \
    --json-out "$ADVERSE_RUN"/report.json \
    --html-out "$ADVERSE_RUN"/report.html
    # add --skipped adversary="no trust boundary in the diff" if you skipped a lane
```

Never LLM-render the findings yourself; the synthesizer's groupings
(cross-validated / consensus / disputed / solo, plus the advisory section)
carry the signal.

Present a **summary**, not the full report:

1. The verdict line and the **open blocking** count.
2. Counts by severity, kind, and confidence.
3. The top 3 blocking findings with one-line previews.
4. Advisory findings as a separate, clearly non-blocking list.
5. A pointer to the report and the HTML dashboard.

## Phase 7 — decide, and act

For a **single pass**, ask the user how to proceed and do not edit until they
pick:

- Fix cross-validated findings only? (highest confidence)
- Fix everything except disputed? (most common)
- Show a specific finding's full reasoning?
- Just save the report.

For a **convergence loop**, you already have authority to fix. Work through the
blocking findings and make an explicit decision on each — including the ones
you decline. Then record every decision:

```bash
node ${SKILL_DIR}/scripts/converge.mjs --ledger "$LEDGER" \
    --record "$ADVERSE_RUN"/decisions.json --repo . --at "$REVIEWED"
```

`decisions.json` is `{"decisions": [{id, title, kind, severity, file, line,
citedLine, disposition, reason}]}` where `disposition` is `fixed`, `declined`,
or `deferred`. **Every decision needs a reason** — the script refuses one
without it, because an unexplained decision cannot be reviewed later and is
indistinguishable from an oversight.

`--at` is **the commit the panel read**, not the one your fixes produced. Pin
it before you edit anything:

```bash
REVIEWED=$(git rev-parse HEAD)     # BEFORE the fixes are committed
```

The line numbers in `decisions.json` came from a report computed against that
tree, and the next pass traces from `atCommit` to the new `HEAD` to find where
each anchor moved. Recording the post-fix commit stores post-fix commit with
pre-fix lines, which makes `from` and `to` the same commit: the trace becomes
the identity and the whole re-projection layer silently does nothing — the
no-op it was built to replace. The script warns on stderr when `--at` is
missing; do not ignore that line.

## Phase 8 — check for convergence

```bash
node ${SKILL_DIR}/scripts/converge.mjs --ledger "$LEDGER" \
    --report "$ADVERSE_RUN"/report.json --repo . --head HEAD
```

| Exit | Meaning | Do |
|---|---|---|
| 0 | converged — nothing blocking is unsettled | stop; report what was fixed and what was declined |
| 1 | findings still open | go to Phase 9 |
| 3 | iteration cap reached, findings still open | **stop and say so.** This is not a pass. List what remains and hand it to the user |

## Phase 9 — verify, then loop

Do **not** re-run the full panel. A re-review asks "what is wrong with this
code"; verification asks the two questions that actually matter, and is much
cheaper — no source block, a small fix diff, findings already written down.

For each persona that reported a finding you acted on, spawn one subagent with
that persona's system prompt and:

1. `${SKILL_DIR}/scripts/prompts/verify.txt`
2. the briefing entries for its own findings, plus the ledger decisions
3. the fix diff: `git diff <commit before fixes>..HEAD`

Verification uses the **original reporter's** persona, not a dedicated
verifier: judging whether a finding is closed needs the lens that produced it.

Each returns `{persona, verified: [{id, title, status, reason}], added: [...]}`
where `status` is `closed`, `open`, or `moot`.

The `added` half is not a formality. **A fix written under pressure to close a
finding is unreviewed code**, written by whoever was most convinced the finding
was real — precisely the frame of mind that ships a hasty patch. A verification
pass that only ever confirms closures would launder new defects into the tree
one iteration at a time.

Feed `verified` + `added` back through triage → synthesize → Phase 7, with the
ledger attached, and loop. Findings the ledger records as settled will not be
re-litigated; anything recorded `fixed` that comes back is flagged `REGRESSED`
and is the loudest thing in the run.

## Phase 10 — hand over

Tell the user the run is complete and where the artifacts are. **Leave them on
disk. Do not delete the run directory**, and never `rm -rf` it:

- `mktemp -d` with no template puts it under `$TMPDIR`, which macOS reaps on
  its own (`com.apple.bsd.dirhelper`, ~3 days untouched). Cleanup is not your
  job, and the artifacts are what the user reads when they want to check a
  finding you summarized.
- The hazard was never the command, it is the interpolated variable. `rm -rf
  "$ADVERSE_RUN"` is a coin flip on a value *you* computed, in a shell where it
  may have been reset, misspelled, or emptied by a failed subshell. There is no
  version of that trade that is worth a few megabytes of scratch.

The ledger lives outside the run directory (Phase 0) precisely so that nothing
about cleaning up scratch can touch it. **Keep it if the work is not merged
yet** — a later pass on the same branch starts from these conclusions. Do not
commit either.

## Failure handling

| Failure | What to do |
|---|---|
| The repo's own gate is red | Stop before Phase 2. Report which check failed; a panel review of a broken build is wasted tokens. |
| `git merge-base` finds no base | Ask which ref to diff against. Do not guess `main`. |
| One reviewer returns garbage twice | Continue without it, mark the run degraded in your summary. |
| ≥2 reviewers fail | Abort. The model is misbehaving; suggest re-running or a single round. |
| `triage.mjs` reports many `DISPROVED` | Surface it. A reviewer inventing line numbers is worth the user knowing. |
| `triage.mjs` reports `REGRESSED` | Lead with it. A fix that did not take is more important than any new finding. |
| `repair.mjs` exits non-zero | Read the unresolvable IDs on stderr. Usually one invented ID; drop that edge and continue. |
| `converge.mjs` exits 3 | The cap, not success. Say plainly what is still open. |
| Ledger version mismatch | Do not delete it. Tell the user which version it is; the schema changed under them. |
| `node` not on PATH | Tell the user to install Node 20+. Do not improvise a fallback. |
| User interrupts | Stop spawning subagents. Say where the partial artifacts are. |

## Notes for the orchestrator

- **Cost.** A single pass is 4 round-1 calls + 3 round-2 calls = **7**, the same
  order as the old three-persona 6, with a whole extra lane: the Pragmatist's
  skipped round 2 pays for the Steward's round 1, and skipping the Adversary on
  a boundary-free diff takes it to 5. Each loop iteration adds ~3 cheap
  verification calls, not another 7.
- **Every deterministic step is deterministic on purpose.** Triage, repair,
  tracing, synthesis, and the stop condition are Node code because a model in
  any of those positions can hallucinate consensus, and consensus is the
  product. Do not add an LLM "judge" pass.
- **The prompt files are generated.** They come from `src/personas.mjs` and
  `src/prompts.mjs` via `dump-prompts.mjs`; edit the sources and regenerate. A
  test fails the build when the copies drift, because nothing at runtime would
  notice the CLI and the Skill running two different reviews.
- **The standalone CLI** (`adverse review`) subprocesses any coding agent
  (`claude -p`, `codex exec`, …). Mention it only if the user asks how to run
  this without Claude Code, and note it uses the blob flow, not this one.
