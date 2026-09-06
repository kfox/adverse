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

If `node` is missing, tell the user: install Node 22+ from nodejs.org (or their
package manager) and re-invoke. Do not fall back to a different implementation;
the deterministic synthesizer is the contract.

## The two shapes of a run

**Single pass** (default) — review, report, hand the findings to the user.
Phases 0–7.

**Convergence loop** — review, fix, verify, repeat until nothing blocking is
left. Phases 0–7, then 8–9, looping. Use it when the user says "until clean",
"until it's done", "keep going", or asks to institutionalize review in a
workflow. Announce which shape you are running.

The loop terminates on arithmetic, not on judgment. `converge.mjs` holds it
open while **any blocking finding is unsettled** — where settled means a
decision was recorded on it, not that a reviewer felt good about it. Credibility
and cross-examination decide what a finding is *called*, not whether the loop
stops:

- **Open** — credible (cross-validated or consensus) and consequential.
- **Not cross-examined** — blocking, but nobody went on record either way. A
  round-2 reviewer's own added critical has no validators by construction —
  surfacing what round 1 missed is the entire point of a cross-review — so the
  credibility test alone silently deleted exactly those findings.
- **Disputed** — reported and challenged. It still blocks. `synthesis.mjs`
  applies that label on the *first* challenger, before it counts reporters, so
  one persona could otherwise erase a critical two others found by disagreeing
  once. A dispute is not a verdict; it is the case that most needs a decision.
- **Unclassified** — blocking and unsettled but matching none of the above.
  Should be unreachable; reported rather than dropped, because three separate
  leaks in this loop's history were a blocking finding that matched no bucket.

A run whose lanes **failed** does not converge either, however few findings the
survivors returned: a lane that failed did not find nothing, it did not look.

The loop is capped at 3 iterations — 5 when round 1 reported a critical
finding of a blocking kind (`plan.mjs --escalate` decides; Phase 4) — and a
run that hits the cap is a **stop, not a pass**.

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
Never reuse a fixed name inside the scratchpad either, for the same reason: a
second invocation in the same session would glob the first run's leftover
`round1-*.json` straight into its own briefing, with no error and no
indication that had happened. `mktemp -d` on a template makes every run its
own directory, whichever branch supplies the parent:

```bash
ADVERSE_RUN=$(mktemp -d "${SCRATCHPAD:-${TMPDIR:-/tmp}}/adverse-run.XXXXXX")
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

## Phase 1 — file list and review plan

Reviewers read the repo themselves, so all you need is the inventory:

```bash
git diff --stat "$BASE"...HEAD | tee "$ADVERSE_RUN/diffstat.txt"
git diff --name-only "$BASE"...HEAD > "$ADVERSE_RUN/files.txt"
```

Then ask how much review this change deserves:

```bash
node ${SKILL_DIR}/scripts/plan.mjs --repo . --base "$BASE" --json \
    > "$ADVERSE_RUN/plan.json"
node ${SKILL_DIR}/scripts/plan.mjs --repo . --base "$BASE"
```

`plan.json` is the run's manifest: the worktree loop below, Phase 4's expected
roster, and the split-lane bookkeeping all read it, so the plan's decisions
travel as data instead of prose someone retypes.

The plan says which lanes run, how many agents each gets, and the starting
rounds and iteration cap. The rules and their rationale live in
`src/scaling.mjs`; the short version:

- The Auditor and the Steward always run. The Adversary runs unless the
  trust-boundary gate (src/scope.mjs, which `plan.mjs` runs for it) says it
  has nothing to look at — and it is forced on regardless when the diff holds
  unmeasurable content (which the gate cannot scan) or heavy deletions (a
  bulk removal can take a guard with it without matching any signal). The
  Pragmatist is skipped on a small diff: everything it reports is advisory, so
  the skip costs a backlog item and one potential second round-1 reporter (the
  duplicate that would promote a solo finding to cross-validated) — never a
  finding that could block on its own, and not a round-2 validator: that lane
  never cross-reviews.
- On a large diff the Auditor and the Adversary each get **two agents**,
  partitioned by file (Phase 2): a large diff exhausts one reviewer's
  attention budget, the documented cause of deterministic lane failures.
  A lane is never split more ways than it has files to partition, so a
  one-file large diff stays one agent.
- Rounds and the cap start at 2 and 3 and are re-decided after round 1
  (Phase 4).

If the repository's own workflow doc names paths that must always get the full
panel (credential handling, sandboxes, wire protocols), pass each as
`--pin <path-substring>` — any match overrides every size-based skip. Size is
a bad proxy for risk, and a one-line change to a boundary is exactly the diff
that must not get the cheap pass.

The plan is a **budget policy, not a judgment**, and it is biased toward
running: a false positive costs model calls, a false negative ships a problem
nobody looked for. Skip a lane only when the plan says skip AND the user has
not asked for a thorough pass. Every skipped lane must be **said out loud** and
passed to the synthesizer in Phase 6 — a lane that was skipped and not
mentioned reads exactly like a lane that looked and found nothing.

`collect.mjs` still exists and still works — it is what the standalone CLI
needs, and it is the fallback if spawned reviewers cannot reach the filesystem.

**Give each reviewer its own checkout.** Reviewers run concurrently and some of
them mutate the tree to test a claim; without isolation one lane reads another
lane's half-applied experiment as the code under review.

One checkout per **agent**, not per persona — a split lane's two agents
mutate the tree independently, so they need `-a` and `-b` checkouts of their
own. The loop reads the plan rather than a fixed roster:

```bash
WORKTREES=$(mktemp -d)
AGENTS=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))
  .lanes.filter((l) => l.run)
  .flatMap((l) => (l.agents === 2 ? [`${l.persona}-a`, `${l.persona}-b`] : [l.persona]))
  .join(" ")' "$ADVERSE_RUN/plan.json")
for agent in $AGENTS; do
  git worktree add --detach "$WORKTREES/$agent" HEAD
done
```

Then tell each agent, in its prompt, to work **only** in its own path, and name
the sibling directories it must not touch. Two things about this are easy to get
backwards, and both have cost a whole iteration:

- A harness flag that "isolates" an agent creates a worktree of the **session's**
  repository, which is not necessarily the repository under review. An agent
  reviewing another checkout lands somewhere that does not contain the code.
- The rule is "work only in *your* path", **not** "never use an absolute path".
  The second forbids the agent from reaching the code at all, and a reviewer
  that cannot read the code cannot verify anything.

Confirm one worktree can run the repo's gate before spawning — a detached
worktree may lack installed dependencies.
In this flow, skip it: a 250KB blob costs every reviewer the same tokens
whether or not they needed the file, and it truncates exactly the large files
most worth reading.

## Phase 2 — round 1: independent reviews

Spawn the reviewers the plan selected **in parallel** using the Agent tool,
one per persona — two for a lane the plan split. Each gets:

- **Subagent type**: `auditor` / `adversary` / `steward` / `pragmatist`, if
  those agent definitions are installed (`~/.claude/agents/<persona>.md`,
  generated by `dump-prompts.mjs` and symlinked from `agents/`). They carry the
  persona system prompt, so you do not pass it separately — and the agent list
  then shows which lane each reviewer is, instead of four identical
  `general-purpose` rows. That matters mid-run: with four indistinguishable
  rows you cannot tell which lane is still working, which finished, or which
  one died. Fall back to `general-purpose` plus the prompt file below if they
  are not installed.
- **System prompt** (only when falling back):
  `${SKILL_DIR}/scripts/prompts/<persona>.txt`.
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

**A split lane** (two agents, from the Phase 1 plan) partitions
`$ADVERSE_RUN/files.txt` roughly in half between its two agents. Tell each
agent which files are its half; both run under the **same persona name**, each
in its own checkout (`$WORKTREES/<persona>-a`, `-b`), and their replies are
saved as `round1-<persona>-a.json` and `round1-<persona>-b.json`. The synthesizer counts distinct personas, not
agents, so a split lane cannot inflate consensus. If one member of a split
lane fails, the lane is **degraded** unless that member's half is re-run —
half the files got no reviewer, and an undeclared gap reads exactly like a
clean review.

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
validator error appended. If the retry also fails, drop that persona **and pass
it to `synthesize.mjs` as `--degraded <persona>`** in Phase 5. If fewer than 2
personas survive, abort — synthesis needs at least 2 voices.

Dropping a lane silently is the failure this flag exists to prevent: a lane
that failed did not find nothing, it did not look, and both produce zero
findings. A run that dropped its Adversary and said nothing rendered as
`SHIP (unanimous, 3/3)` and converged with exit 0 — which the `ship` workflow
reads as "hand over a green PR". `--degraded` holds the loop open until the
lane is re-run. Use `--skipped <persona>=<reason>` only for a lane you chose
not to run; it is reported but does not block, and it is not a place to put a
lane that crashed.

## Phase 3 — triage (deterministic, no model)

This is what makes round 2 cheap and what keeps cross-lane consensus alive:

```bash
node ${SKILL_DIR}/scripts/triage.mjs \
    --round1 "$ADVERSE_RUN"/round1-*.json \
    --repo . --base "$BASE" --gate "$GATE" \
    ${LEDGER:+--ledger "$LEDGER"} \
    --out "$ADVERSE_RUN"/briefing.json
    # one --merge-personas <persona> per lane the plan split in Phase 2 —
    # same flag, same meaning, as the combine.mjs invocation in Phase 5.
    # Without it, a second payload under a persona that was NOT split is
    # refused rather than silently merged: that silent merge is what let a
    # stale run's leftover files pass as extra reviewers before this guard
    # existed.
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

First, re-plan from what round 1 actually found — criticality is not knowable
until now. Pass the roster the plan ran, so a lane whose payload is missing or
unreadable fails closed instead of reading as "found nothing":

```bash
EXPECT=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))
  .lanes.filter((l) => l.run).map((l) => l.persona).join(",")' "$ADVERSE_RUN/plan.json")
node ${SKILL_DIR}/scripts/plan.mjs --escalate --expect "$EXPECT" --json \
    "$ADVERSE_RUN"/round1-*.json > "$ADVERSE_RUN/escalation.json"
ROUNDS=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).rounds' "$ADVERSE_RUN/escalation.json")
CAP=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).maxIterations' "$ADVERSE_RUN/escalation.json")
R2_REASON=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).roundsReason' "$ADVERSE_RUN/escalation.json")
```

Two dials move, both deterministic:

- **Round 2 is skipped only when round 1 reported nothing blocking** under the
  synthesizer's own `isBlocking` (info-severity findings do not block; a
  missing or unrecognized kind does). The skip is never free — it forgoes
  round 2's additive channel, the findings a reviewer only sees with the other
  lanes in view — so it is never taken on size, and never taken silently:
  Phase 6 must declare it with `--round2-skipped "$R2_REASON"`. A missing or
  off-shape round-1 payload fails closed: round 2 runs.
- **The cap rises to 5** when round 1 holds a critical finding of a blocking
  kind. It never drops below 3: lowering the cap can only manufacture false
  exit-3 stops, raising it only costs model calls. `$CAP` carries it to
  `converge.mjs --max-iterations` in Phase 8.

If `$ROUNDS` is 1, phases 4–5 collapse the same way the "faster review" path
does — but the skip rides into the report via `--round2-skipped`. Otherwise:
for each persona that produced a valid round-1 review **except the
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
    # one --merge-personas <persona> per lane the plan split in Phase 2. The
    # flag names the lane so the duplicate guard stays live everywhere else,
    # and it requires BOTH halves: a missing half reviewed nothing, so combine
    # refuses — re-run that half, or declare the lane --degraded. Without the
    # flag a duplicate persona is an error (a file passed twice).
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
    # one --skipped per lane the plan skipped, quoting the plan's own reason:
    #   --skipped adversary="no trust boundary in the diff"
    #   --skipped pragmatist="small diff; design findings are advisory"
    # and, when Phase 4 skipped round 2:
    #   --round2-skipped "$R2_REASON"
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
    --record "$ADVERSE_RUN"/decisions.json --report "$ADVERSE_RUN"/report.json \
    --repo . --at "$REVIEWED" --base "$BASE"
```

`--base` is optional but recommended: it is the only thing that binds the
ledger to the branch's merge base once recorded (`checkBinding` then refuses a
ledger whose `base` does not resolve in this repository). `decisions.json`
carries no `base` field — see below.

`--report` is not optional. It stamps each decision with the identity of the
report it answered, which is the only thing that lets the next check tell "not
yet verified" from "the fix did not take". Omit it and every finding you just
recorded `fixed` comes back flagged **REGRESSED** on the very next check —
because it is the same report, and of course it still contains them. Phase 3
calls a `REGRESSED` count the most important line in the run, so a playbook
that makes it fire falsely after every fix batch destroys the one signal the
loop trusts most.

`decisions.json` is `{"decisions": [{id, title, kind, severity, confidence,
file, line, citedLine, disposition, reason}]}` where `disposition` is `fixed`,
`declined`, or `deferred`. **Every decision needs a reason** — the script
refuses one without it, because an unexplained decision cannot be reviewed later
and is indistinguishable from an oversight.

Carry `confidence` through from the report for the same reason you carry the
reason. Without it the ledger cannot tell a later reader whether a `declined`
was declined against a cross-validated finding — a significant call — or a solo
one. Matching never reads the field, so omitting it costs nothing at the time
and everything to whoever audits the decision afterward.

**Record a decision on every finding, not only the blocking ones.** An advisory
finding you chose not to act on is a decision; leave it unrecorded and the next
pass raises it again and you decide it again from scratch, which is exactly the
circling the ledger exists to stop.

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
    --report "$ADVERSE_RUN"/report.json --repo . --head HEAD \
    ${CAP:+--max-iterations "$CAP"}   # from Phase 4; unset falls back to the default 3
```

| Exit | Meaning | Do |
|---|---|---|
| 0 | converged — nothing blocking is unsettled | stop; report what was fixed and what was declined |
| 1 | findings still open | go to Phase 9 |
| 1 | *only* `NOT CROSS-EXAMINED` listed | Phase 9 cannot clear these — each persona verifies only its own findings, so verification can never cross-examine. **Record an explicit decision on each** (Phase 7) |
| 1 | `DISPUTED` listed | reported and challenged. Read the challenge, then decide it: `declined` with the challenger's reasoning, or fix it |
| 1 | `UNCLASSIFIED` listed | usually a stop-condition bug or a report whose `confidence`/`cross_examined` are off-contract — or, on a hand-edited report, a `blocking: true` override on a finding this tool would not otherwise call blocking. Decide those findings on their merits, and report it if the report came from this tool |
| 1 | `LANES THAT FAILED` listed | a lane that failed did not find nothing — it did not look. **Re-run it.** A run missing its Adversary is not a reviewed run, however few findings the others returned. If it fails again, **record the iteration anyway** (`--record` with the decisions you have; an empty list is valid) so the cap can fire |
| 2 | usage error, or a report that is not a synthesis report | fix the invocation. Exit 2 is deliberately not exit 1: exit 1 is a claim about a review, and this run could not read one |
| 3 | iteration cap reached, findings still open | **stop and say so.** This is not a pass. List what remains and hand it to the user |

Every exit-1 remedy above ends in a recorded iteration, and that is deliberate.
A lane that deterministically fails — the case this gate exists for, since a
diff large enough to exhaust a reviewer's budget fails the same way every retry
— would otherwise hold the loop open forever with no branch that advances the
counter. Recording is what makes the cap reachable, which is what makes exit 3
an honest stop rather than an unreachable one. The
iteration counter is `ledger.iterations.length + 1`, and `iterations` only grows
when `converge.mjs` runs with `--record` — so a remedy that does not record
leaves the counter frozen, `capped` never becomes true, exit 3 is unreachable,
and a loop that keeps taking that branch does not terminate. An earlier version
of this table offered "run a round 2 over them" for the unexamined case, which
is exactly that shape: if the round-2 reviewers keep declining to go on record,
the loop runs forever. Cross-examining them is still useful — but it informs the
decision, it does not replace it.

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
where `status` is `closed`, `open`, or `moot`. Save each to
`$ADVERSE_RUN/verify-<persona>.json`, same as round 1.

The `added` half is not a formality. **A fix written under pressure to close a
finding is unreviewed code**, written by whoever was most convinced the finding
was real — precisely the frame of mind that ships a hasty patch. A verification
pass that only ever confirms closures would launder new defects into the tree
one iteration at a time.

Feed `verified` + `added` back through triage → synthesize → Phase 7, with the
ledger attached, and loop:

```bash
node ${SKILL_DIR}/scripts/verify.mjs --verify "$ADVERSE_RUN"/verify-*.json \
    --outdir "$ADVERSE_RUN"
node ${SKILL_DIR}/scripts/triage.mjs \
    --round1 "$ADVERSE_RUN"/round1-*.verified.json \
    --repo . --base "$BASE" --gate "$GATE" --ledger "$LEDGER" \
    --out "$ADVERSE_RUN"/briefing.json
```

`verify.mjs` validates each payload against the schema before anything trusts
it — the same discipline every other leg of this flow already has — then
reshapes it into the round-1 shape triage.mjs reads: `added` becomes
`findings`, and `verified` rides along unchanged for Phase 7 to read (triage
has no way to re-litigate an old finding's status; that decision is still
yours to make). Its exit codes follow the same contract as every other bridge:
2 means it never read a payload, 1 means it read one that failed the schema.

Findings the ledger records as settled will not be re-litigated; anything
recorded `fixed` that comes back is flagged `REGRESSED` and is the loudest
thing in the run.

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

## Phase 11 — harvest what the run taught

A converged run leaves behind more than a green diff. Before you close it out,
look back over the iterations and ask whether anything generalizes past this
change. Findings are about this code; **lessons are about how the work is
done**, and those are worth more because they apply to the next change too.

Look for these three shapes in particular, because they are what a review
surfaces that reading cannot:

- **A defect class that recurred.** The same mistake in a second file, or the
  same shape of leak closed twice. That is not two findings, it is one thing
  worth knowing.
- **A fix that failed verification, and why.** A fix landing in one of two call
  sites, closing an instance rather than a class, or being correct and
  unreachable, says something about how fixes go wrong here.
- **A blind spot the panel did not cover** — most valuably one a human found
  that four lanes missed. That is a gap in the lanes, not in the change.

Where each lesson goes:

| The lesson is about | Write it to |
|---|---|
| how a reviewer should look | the persona's prompt in `src/personas.mjs`, or `VERIFY_INSTRUCTIONS` in `src/prompts.mjs` if it is about checking a fix |
| how this repository works | its `CLAUDE.md` / `AGENTS.md` / architecture notes |
| how the loop itself should run | this file |
| how *you* should work, across projects | your own persistent instructions or memory, if the harness gives you one |

Then say what you wrote and why, in one or two sentences. Do not pad this: a
run that taught nothing generalizable should say so and stop. The point is that
the panel gets better at reviewing this codebase every time it runs, rather than
re-learning the same lesson and re-reporting the same class of finding.

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
| Any bridge script (`collect`/`combine`/`triage`/`repair`/`synthesize`/`plan`/`converge`/`verify`) exits 2 with a JSON path in the message | It could not read that input file — check the path, or that a previous step actually wrote it. Exit 2 means "this run never got as far as judging anything"; it is never a claim about the review itself. |
| `converge.mjs` exits 3 | The cap, not success. Say plainly what is still open. |
| Ledger version mismatch | Do not delete it. Tell the user which version it is; the schema changed under them. |
| `node` not on PATH | Tell the user to install Node 22+. Do not improvise a fallback. |
| User interrupts | Stop spawning subagents. Say where the partial artifacts are. |

## Notes for the orchestrator

- **Cost.** The full shape is 4 round-1 calls + 3 round-2 calls = **7**. The
  Phase 1 plan scales that in both directions: a small boundary-free diff runs
  2 round-1 calls (Auditor + Steward) and, when round 1 reports nothing of a
  blocking kind, no round 2 — a floor of **2**. A large diff splits the
  per-file lanes into two agents each, up to 6 + 3 = **9**. Each loop
  iteration adds ~3 cheap verification calls, not another 7.
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
