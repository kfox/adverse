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

One more thing about that table, because it is the only roster in this file:
**the agent driving the panel is not a fifth lane.** It reports no findings and
nothing it does can block; its questions are how the repair should be divided,
what each agent has to be told, and what may run at the same time. Those are
decisions, not observations, so the rules governing them sit at the phase where
each one is made — Phases 7, 9 and 11 — and not here. A rule read at the top of
a long file is not read at the moment it applies, which is the failure this
arrangement is built against: a doctrine that was written down and then not
followed by the same person who wrote it, because the remembered habit and the
filed correction feel equally like knowledge.

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
In this flow, skip it: a 250KB blob costs every reviewer the same tokens
whether or not they needed the file, and it truncates exactly the large files
most worth reading.

**Give each reviewer its own checkout.** Reviewers run concurrently and some of
them mutate the tree to test a claim; without isolation one lane reads another
lane's half-applied experiment as the code under review.

One checkout per **agent**, not per persona — a split lane's two agents
mutate the tree independently, so they need `-a` and `-b` checkouts of their
own. The loop reads the plan rather than a fixed roster:

```bash
WORKTREES=$(mktemp -d)
AGENTS=$(node ${SKILL_DIR}/scripts/plan.mjs --agents "$ADVERSE_RUN/plan.json")
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
    those tools already prove;
  - the exact path to **write its own JSON object to** with the Write tool —
    `$ADVERSE_RUN/round1-<persona>.json` (`-a`/`-b` for a split lane) — not to
    reply with the JSON in chat.
- **Model**: `opus` unless the user asked otherwise. If the user picks a smaller
  model, pass it to every persona — mixing models across personas defeats the
  single-model design. That rule is about the panel, whose whole method is one
  model wearing four lenses. The roles outside it — a fix agent, the absorber
  commit, the regression pass — are not lanes and are tiered per role instead;
  Phase 7 says on what basis.

The Steward needs one thing the others don't: point it at where this repo keeps
its rules and its architecture notes (`CLAUDE.md`, `CONTRIBUTING.md`,
`docs/architecture*`, a committed schema). Its lane is code-versus-claim, and
it cannot check a claim it was never shown.

**A split lane** (two agents, from the Phase 1 plan) partitions
`$ADVERSE_RUN/files.txt` roughly in half between its two agents. Tell each
agent which files are its half; both run under the **same persona name**, each
in its own checkout (`$WORKTREES/<persona>-a`, `-b`), and each writes its own
`round1-<persona>-a.json` / `round1-<persona>-b.json`. The synthesizer counts
distinct personas, not agents, so a split lane cannot inflate consensus. If
one member of a split lane fails, the lane is **degraded** unless that
member's half is re-run — half the files got no reviewer, and an undeclared
gap reads exactly like a clean review.

**Tell each half its agent id, and tell it to put that id in `agent`** —
`"persona": "auditor"`, `"agent": "auditor-a"`. The shared persona name is what
stops two halves inflating one finding into agreement between two reviewers;
the agent id beside it is what lets Phase 4 tell one half's findings from the
other's, so that a half's judgment on its sibling's work counts as the
independent review it is. Both are needed and neither substitutes for the
other. Omit `agent` on any lane that was not split.

The id is checked against the **filename**: `validate.mjs` refuses
`round1-auditor-a.json` unless its `agent` is exactly `auditor-a`, refuses an
unlabeled half, and refuses a half id in a file whose name names no half. What
that buys is that a payload cannot disagree with its own path — it is **not**
an unforgeable identity, and this section used to say it was. The authority
holds only for an agent that writes the one path it was given, and every
reviewer has a Write tool and a shared `$ADVERSE_RUN`. One author writing three
files still renders `confidence: consensus`.

What is missing to close it is **enforcement, not layout.** The bridges do not
require one shared directory — they take the paths you hand them, so
`combine.mjs --round1 "$ADVERSE_RUN"/*/round1-*.json` works with each agent
writing into `$ADVERSE_RUN/<agent>/` of its own, and `validate.mjs` still binds
each payload to its basename. Only the flat globs written in Phase 2 and Phase 5
assume siblings.

So give each agent its own subdirectory when the harness can make that
subdirectory the only place it may write, and widen those globs by one segment.
Absent that enforcement the layout buys nothing — an agent free to write
anywhere can write into a sibling's directory as easily as into a sibling's
filename — which is why this is a harness capability and not a Phase 0 step you
can simply adopt. Until you have it, treat these guards as what they are: they
stop a payload contradicting its own path, and they do not authenticate its
author. `combine.mjs --plan`
refuses a lane whose two halves claim one id or an id the plan never spawned.
A half declaring its sibling's id would rule on its own finding as if it were
the other half's — two characters, and consensus is counterfeit.

Each subagent's JSON object, written to its own path rather than returned in
chat, has this shape:

```json
{
  "persona": "<auditor|adversary|steward|pragmatist>",
  "agent": "<persona>-a | <persona>-b — split lanes only, else omit",
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

**The reviewer writes the file — you never retype it.** The orchestrator used
to copy each subagent's JSON reply into a file by hand, and that hand was a
defect source in its own right: a retyped `detail` field truncated mid-word, a
finding remembered instead of read back, a fix recorded that had never
actually been written down. Once each agent has its own path (above) and the
Write tool, the orchestrator's job is to check what landed, not to produce it:

```bash
node ${SKILL_DIR}/scripts/validate.mjs --phase round1 "$ADVERSE_RUN"/round1-*.json
```

It reports `ok (<persona>)` per file on stdout, or the schema error on stderr —
the same message a retry needs. Exit 2 means a file is missing or unreadable,
which for this phase means **the agent never wrote it**; do not reconstruct it
from the transcript, retry the persona instead.

If a subagent's file is missing, or `validate.mjs` rejects it, **retry that one
persona once**, appending the validator's stderr line and a reminder to use
Write rather than reply in chat. If the retry also fails, drop that persona
**and pass it to `synthesize.mjs` as `--degraded <persona>`** in Phase 5. If
fewer than 2 personas survive, abort — synthesis needs at least 2 voices.

The one narrow exception: a subagent environment with no Write tool. There,
extract the JSON **verbatim from that subagent's own final reply** and write
it unedited to the path — copying its bytes, not reconstructing them, is what
keeps this from becoming the retyping problem under a different name — then
validate it exactly as above.

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
    --plan "$ADVERSE_RUN/plan.json" \
    --out "$ADVERSE_RUN"/briefing.json
    # --plan reads which lanes Phase 1 split (agents > 1) straight out of
    # plan.json, so the split roster is never retyped by hand — same flag,
    # same meaning, as the combine.mjs invocation in Phase 5. Without it (or
    # an explicit --merge-personas <persona>), a second payload under a
    # persona that was NOT split is refused rather than silently merged: that
    # silent merge is what let a stale run's leftover files pass as extra
    # reviewers before this guard existed.
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
  **co-citations** (one finding's prose names another's file as a whole path
  token — cross-file, or same-file when the other finding's line is cited too,
  and only ever targeting a file the claim check actually opened). These
  are candidate *one defect seen twice* — exactly the pairs a title join drops.
- **Candidate root causes** (`groups`), the transitive closure of those two
  edge sets. If A clusters with B and B's prose cites C, all three arrive as
  one candidate — `G1`, `G2`, … — with a canonical statement and every member
  attached as a citation that keeps its own reporter, kind, severity and
  anchor. This is a *proposal*: round 2 rules on it (Phase 4), and until it
  does, the members are reported and decided one at a time exactly as before.
  A group marked `oversized` carries too many citations for one disposition to
  be honest and will never collapse, however round 2 rules it — and that cap is
  relative as well as absolute, so a group that is most of a small review is
  oversized even when it is well under the fixed limit.
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
EXPECT=$(node ${SKILL_DIR}/scripts/plan.mjs --expect "$ADVERSE_RUN/plan.json")
eval "$(node ${SKILL_DIR}/scripts/plan.mjs --escalate --expect "$EXPECT" --sh \
    "$ADVERSE_RUN"/round1-*.json)"
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
for each **round-1 agent** that produced a valid review **except the
Pragmatist's**, spawn a subagent with the same persona system prompt and:

1. `${SKILL_DIR}/scripts/prompts/round2.txt`
2. `$ADVERSE_RUN/briefing.json`
3. the repo path and `$BASE`
4. the path to write its own JSON object to: `$ADVERSE_RUN/round2-<agent>.json`

**Per agent, not per persona — a split lane spawns two.** `auditor-a` and
`auditor-b` each get their own round-2 call and each declares its own id in
`agent`, exactly as in round 1. That id is what makes the second call worth
making: every briefing finding carries `reporterAgent`, so `-b` can see which
entries under its persona are its sibling's rather than its own, and the
synthesizer counts `-b`'s ruling on an `-a` finding as the independent
cross-review it is. Left as one round-2 agent per persona, the orchestrator
either hands one agent both halves — where it reads its sibling's work as its
own prior work and passes it through unexamined — or spawns two that both claim
the whole lane, whose rulings the self-validation guard then discards.

The cost is **one extra round-2 call per split lane, on large diffs only**;
lanes only ever split when a diff is large enough to exhaust one reviewer's
attention (Phase 1), and only the Auditor and the Adversary split at all. What
it buys is a validator that read different files from the reporter and reached
its conclusions without seeing them — the same independence a cross-lane edge
has, on the half of the diff no other lane was assigned. Do not economize by
sending one agent both halves: that spends the tokens and produces nothing.

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

It must also **rule on every candidate root cause** in `groups`, as
`{id, ruling: "one" | "split", reason}`. A group becomes a single fix with a
single disposition only when **two independent personas** both call it `one` —
the same cross-validation the report's confidence labels require, for the same
reason: a confirmed group is one decision covering N findings, and one
unopposed voice deciding that is exactly the consensus-of-one this design
refuses everywhere else. A ruling from the **reviewer** that is the sole
reporter of every citation is not a voice — and for a split lane that reviewer
is the half that reported, not the lane: the other half's ruling on its
sibling's citations counts, exactly as its `validate` edge does. Two halves
agreeing are still one voice, because the quorum counts personas.

Everything short of that stays a candidate and its citations are decided one at
a time: unruled, contested, oversized, or agreed by only one lane. `split`
needs no quorum — it dissolves the group, which is the direction this tool
always fails in. So a missing ruling costs the remediation speedup, never a
finding — which is why the key is optional and why leaving it off is still a
waste, and why the report tells you when a group fell short and by how much.

Each reviewer writes its own file at the path it was given, same as round 1 —
the orchestrator does not retype it. Validate before repair:

```bash
node ${SKILL_DIR}/scripts/validate.mjs --phase round2 "$ADVERSE_RUN"/round2-*.json
```

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

Pass every round-2 file, including both halves of a split lane
(`round2-auditor-a.json`, `round2-auditor-b.json`) — `--round2
"$ADVERSE_RUN"/round2-*.json` expands to exactly that. Each is repaired to
`round2-<agent>.repaired.json`, keyed on the agent so two halves land in two
files rather than one refusing to overwrite the other.

It exits non-zero when an edge names an ID not in the briefing — a reviewer
invented a finding number and that edge is about to vanish. Read the stderr
lines; do not ignore the exit code.

Then combine both rounds:

```bash
node ${SKILL_DIR}/scripts/combine.mjs --round1 "$ADVERSE_RUN"/round1-*.json \
    --plan "$ADVERSE_RUN/plan.json" \
    --out "$ADVERSE_RUN"/round1.json
    # --plan reads the split roster from plan.json, same as Phase 3's triage
    # invocation. It requires BOTH halves of a named lane: a missing half
    # reviewed nothing, so combine refuses — re-run that half, or declare the
    # lane --degraded. Without --plan (or an explicit --merge-personas), a
    # duplicate persona is an error (a file passed twice).
node ${SKILL_DIR}/scripts/combine.mjs --round2 "$ADVERSE_RUN"/round2-*.repaired.json \
    --plan "$ADVERSE_RUN/plan.json" \
    --out "$ADVERSE_RUN"/round2.json
    # --plan carries both halves here too, same as round 1. The ROSTER half is
    # the gate: a payload from a lane the plan recorded `run: false` is a stale
    # file or a spoof, and this is the one place that can tell. The SPLIT half
    # unions a split lane's two round-2 payloads — validate, challenge, groups
    # and added, each entry stamped with the agent that made it — and demands
    # both: one half missing is a lane that cross-reviewed half the diff.
```


Combine the `.repaired.json` files, not the raw ones. That is the whole reason
Phase 5 exists.

## Phase 6 — synthesize

```bash
node ${SKILL_DIR}/scripts/synthesize.mjs \
    --round1 "$ADVERSE_RUN"/round1.json \
    --round2 "$ADVERSE_RUN"/round2.json \
    --briefing "$ADVERSE_RUN"/briefing.json \
    --out "$ADVERSE_RUN"/report.md \
    --json-out "$ADVERSE_RUN"/report.json \
    --html-out "$ADVERSE_RUN"/report.html
    # one --skipped per lane the plan skipped, quoting the plan's own reason:
    #   --skipped adversary="no trust boundary in the diff"
    #   --skipped pragmatist="small diff; design findings are advisory"
    # and, when Phase 4 skipped round 2:
    #   --round2-skipped "$R2_REASON"
```

`--briefing` is what carries the candidate root causes and round 2's rulings
into the report. Omit it and the report is exactly what it was before grouping
existed — one section per finding, the same aggregation done by hand.

Never LLM-render the findings yourself; the synthesizer's groupings
(cross-validated / consensus / disputed / solo, plus the advisory section)
carry the signal.

Present a **summary**, not the full report:

1. The verdict line and the **open blocking** count.
2. Counts by severity, kind, and confidence.
3. Any **confirmed root causes**, each as one item with its citation count —
   "one unreachable guard, cited by 3 reviewers as a defect, an attack, and a
   contract violation" is the honest shape of that news, and three separate
   bullets is not.
4. The top 3 blocking findings not already covered by a root cause above.
5. Advisory findings as a separate, clearly non-blocking list.
6. A pointer to the report and the HTML dashboard.

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
file, line, counterpart, citedLine, disposition, reason}]}` where `disposition`
is `fixed`, `declined`, `deferred`, or `noted`. Only `declined` and `deferred`
**settle** a question; `fixed` and `noted` do not, and `decisions.mjs` marks
which is which on its own summary line. **Carry `counterpart` on every
`contract` decision.** That kind's claim is "X contradicts Y", so Y is half its
identity and the ledger matches on it: an entry carrying no counterpart matches
only a finding that carries none either. Triage does not *require* one — it
annotates a counterpart-less `contract` finding as under-anchored and carries it
anyway — so whether the next pass's finding names a Y is up to the reviewer who
writes it. Record yours and the match is decided on identity; omit it and you are
betting the next reviewer omits it too. Do not read that as "an entry
without one matches nothing ever again", which is what this line used to say:
two counterpart-less records with the same title DO match and settle. Both arms
are pinned by `tests/ledger.test.mjs`, "two counterpart-less contract records
match; a one-sided counterpart does not" — that test is the mechanism, this
paragraph is a reading of it.

**Every decision needs a reason** — the script refuses one without it, because
an unexplained decision cannot be reviewed later and is indistinguishable from
an oversight.

**Work the confirmed root causes first, one decision each.** A group the report
calls `confirmed` is one fix and one disposition covering N citations. Write it
as one entry per citation, every entry carrying the same `disposition`,
`reason`, and the same `group` block:

```json
{"id": "F2", "title": "…", "kind": "defect", "severity": "critical",
 "confidence": "consensus", "file": "src/auth.py", "line": 88, "counterpart": null,
 "disposition": "fixed", "reason": "restored the guard",
 "group": {"id": "G1", "title": "the unreachable guard",
           "citations": [{"id": "F1", "title": "…"}, {"id": "F2", "title": "…"}]}}
```

Every identity field is there on purpose. `kind`, `severity`, `file`, `line`
and `counterpart` are exactly what `scoreMatch` matches on next iteration — an
entry written from a shorter example matches nothing, and the finding you just
decided is re-raised on the next pass. `report.json`'s
`root_causes[].citations[]` already carry all of them, so copy from there
rather than retyping.

One decision made, N entries recorded. The expansion is not busywork: identity
across iterations is still per-finding, so each citation needs its own entry to
be matched by later — and the shared `group` is what lets the next pass say
"the root-cause fix did not close every symptom" instead of the much weaker
"a fix did not take". A group the report calls `proposed`, `contested`,
`oversized`, or `split` gets ordinary per-finding decisions with no `group`
block; the panel did not confirm it is one thing, so do not record it as one.

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

### Fixing with agents, when the batch outgrows your own hands

Everything above assumes you make the fixes. That holds for a handful of
findings and stops holding the moment an iteration returns more than one
context window can carry — at which point repair splits across several agents,
and the brief each one gets is improvised prose, different every time. **A
reviewer's improvised brief costs a finding; a fix agent's costs a commit.** So
the brief is generated, exactly like the reviewers' are.

**Sequence the fix commits by blast radius, not by review unit.** The findings
arrive grouped by who was looking; that boundary is an artifact of the panel's
own partition, and the findings worth having are the ones that cross it.
Ordering repair by review unit forces every cross-cutting fix to be split across
commits or assigned to one of them arbitrarily. Order by how far the change
reaches instead — the shared type-level change, then its call sites, then the
prose — which also leaves each commit independently reviewable; the review
ordering does not.

**A class is an indivisible unit of fix work. Partition between classes freely;
never within one.** The worked example is three findings in three files with no
overlap: an unthrottled per-frame warning, a second unthrottled per-message
warning, and a reader bound that counts messages rather than the work each
message buys. A decomposer optimizing for partitionability splits them three
ways without hesitation. They are one lever — a byte on the wire buying
unbounded work inside a bounded reader — and three agents produce three one-shot
flags, leave the lever, and the next site anyone adds reintroduces the bug under
a new name.

Class closure is also where the fix phase out-finds the panel, and that is the
argument against fragmenting it. The sibling sweep this section closes with —
one agent, one working reproduction, a second reserved I/O window four reviewers
across two rounds had missed — needs the whole neighborhood in a single agent's
view. It is the first thing a finer partition loses and the last thing you would
want to lose.

**A class outranks the commit boundaries you drew for good reasons.** When a
class spans them, the commit that owns the class gets every file the class
reaches, and the *other* concerns in those files stay with their own commits.
Blast radius is measured in behavior, not in files. Below that line, prefer
batches touching **disjoint files**: two agents editing one file is a conflict
you resolve by reading the same code twice.

**Unbounded work is a task, not a rider.** "Fix the clock bug, then determine
which existing budget tests were passing for the wrong reason" is one bounded
clause and one with no stopping point; attached to the bounded work, the second
ran about ninety minutes past it before anyone interrupted. An audit, a sweep,
or a "check whether this is true everywhere" gets its own agent and its own
commit, or gets scoped down to a question that has an answer. A fix agent that
stops at its brief's boundary and names what it found there is behaving
correctly — `fix.txt` tells it to — and that costs one line in a report instead
of a fourth file in a commit three reviewers were about to read.

**Count postponed items against the receiving commit's budget.** A `deferred`
or `noted` entry is not free: it is a note that has to be written, placed, and
carried into the next iteration's briefing. A commit taking on six of them
alongside its fixes is doing more work than its finding count suggests — and a
`noted` one is still open, so it is work that comes back.

**Budget one docs-and-comments absorber commit per batch, placed after the fix
commits.** Boundary-respecting agents shed orphans — comment- and doc-level
items belonging to no remaining commit in the batch — and the `named_not_fixed`
channel records each one `noted`, which settles nothing, so an unabsorbed orphan
comes back every iteration until someone decides it. Riding them into an
unrelated commit instead breaks the boundary rule that produced them. So: one absorber per batch, not one per commit, and not
optional. Usually you write it yourself rather than spawning for it — the
orphans are individually trivial and you are already holding the batch context
someone else would have to be briefed on.

None of this reads as "always decompose". Findings that are one type-level
change seen from several call sites are one commit, because the intermediate
commits do not compile. And an ordering dependency between two fixes is real —
a budget test cannot be trusted until the clock it reads matches the clock the
code reads — so it is a sequence, not a parallel opportunity.

**Independent batches run concurrently, and the edge test is a file or a
class.** Draw a dependency edge between two fix nodes iff they share a file
**or** share a class; nodes with no edge between them can run at the same time,
each in its own `git worktree` — the same isolation Phase 1 already gives
reviewers, for the same reason. What serializes the fix phase otherwise is
mechanical, not logical: commits land on one branch in one checkout, and a
pre-commit hook that stashes unstaged changes fails spuriously while a second
agent is editing. Two commits in one batch shared no file and no class and ran
in sequence anyway, on that alone. `git worktree add --detach` off a checkout an
agent is actively editing was measured not to disturb it — its modified files
stayed modified and its index untouched — so the git half of this is safe. The
environment half, below, is not.

**Replay in topological order and re-run the gate on the composed result.**
Per-worktree green does not compose. Cherry-pick each worktree's commit onto the
branch in dependency order, then run the repo's own gate (Phase 0) over what
that produced: N worktrees means N gate runs plus one, and a conflict on replay
needs resolving. This buys wall-clock, not tokens — say which one you bought,
because the setup cost is visible and the saving is not.

**A worktree isolates the source tree. It does not isolate the build or
dependency environment, and that is where the shared mutable state usually
lives.** Phase 1 asks only that one worktree can run the gate, which is enough
for reviewers because reviewers read; a fix agent builds. This has already cost
a run: a worktree with no virtualenv of its own, a parent shell with the main
checkout's environment activated, and a `uv sync` invoked transitively by a
`make` target re-pointed the *shared* editable install at the worktree path. For
about two minutes every import in the main checkout resolved to a tree without
the concurrent agent's edits — no error, no warning, and the symptom is worse
than a crash, because that agent sees an unexplained failure and may "fix"
something that was never broken. So, before any agent runs in a worktree:

- provision that worktree's own environment, and unset an inherited
  `VIRTUAL_ENV` or whatever the toolchain's equivalent is — an activated parent
  environment is what makes the hijack reachable at all;
- **verify the parent still resolves to itself afterward.** One cheap command
  from the parent checkout — `uv run python -c "import pkg; print(pkg.__file__)"`
  for that toolchain — and the only thing that would have caught this;
- treat any test result a concurrent agent produced during a provisioning window
  as void, and say so to that agent rather than leaving it to reason from
  phantom failures.

The shape is not Python-specific: a shared target directory, a module cache, a
daemon with a project-keyed workspace, or any linked install does the same.

**Parallelism is not free, so it is not automatic.** Setup and replay cost the
same whether the concurrent work is long or short. For a four-line change the
worktree, its environment, and the topological replay cost more than waiting for
the running agent to finish. Rough rule: parallelize a fix node when it is
itself agent-sized. Orphans and the absorber commit are below that line and
should just wait.

Spawn one subagent per batch (`general-purpose`; there is no fix persona — a
fix agent is a batch of repair work, not a lane) with:

1. `${SKILL_DIR}/scripts/prompts/fix.txt`
2. **the repository's own constraint block** — see below
3. this batch's briefing entries, verbatim, with their `id`, `kind`, `severity`,
   `confidence`, `file`, `line` and `counterpart`
4. the path to write its own JSON object to: `$ADVERSE_RUN/fix-<batch>.json`

**The constraint block is not optional and it is not obvious.** A subagent
inherits nothing from you: not the rule that a test run prints only pass/fail
indicators, not the sandbox that decides which tree it may edit, not the
spelling convention, not the shape this repository's hooks demand of a search
command, not what the gate is called. Every one of those fails the gate when
missed, and every one of them is invisible from inside the subagent. Assemble
it once for the run out of `CLAUDE.md` / `CONTRIBUTING.md` / `AGENTS.md` and
the gate command from Phase 0, and append the same block to every batch. The
portable half — reproduce before fixing, close the class, the mutation catalog,
what to do with something found out of scope — is already in `fix.txt` and is
versioned with this skill, so it is not retyped per agent: each restatement is
a place a rule gets silently dropped.

**That per-agent cost is fixed, and it puts a floor under how small a batch is
worth spawning for.** Six small agents restate the repository half six times,
and the tokens are the cheap part: a rule lost in one of those restatements is
lost quietly, and the batch that lost it fails the gate for a reason invisible
from inside the agent. That is an argument against fine partitioning that has
nothing to do with model capability, and it points the same direction the class
rule does.

**Tier is per role, not per size.** "Smaller tasks let you use a smaller model"
bundles a premise that does not need to be true, and tier is testable at today's
granularity with no decomposition change at all. Best candidate first: the
regression pass (Phase 9), which is read-only, one question, bounded in output,
the most repeated role in the loop and the least destructive if it comes back
weak; then the docs-and-comments absorber, where nothing changes behavior and
the gate is the whole test; then a test-only pinning commit. **Not the
class-closure fix commit** — that is where the value is.

The caveat is the crux, because a tier experiment measuring the wrong thing
passes. On the "mechanical" test-only commit in one batch, the larger model
re-derived three cycle constants from the assembly they model rather than
trusting the brief, verified a reviewer-supplied arithmetic figure instead of
asserting it, and caught a mutation-trap shape in its own new tests mid-pass —
recognizing that a green mutation was anomalous and reaching for `fix.txt`'s
catalog by name. That is recognition, not procedure. Whether a smaller model
does it under load is unknown, and it is the difference between a fix and a
plausible fix. So measure trap-recognition specifically rather than whether the
commit landed green: a commit that lands green on a vacuous test is the failure
this whole loop exists to prevent, and it looks identical to success.

Then check what landed and fold it, the same way round 1 is checked:

```bash
node ${SKILL_DIR}/scripts/validate.mjs --phase fix "$ADVERSE_RUN"/fix-*.json

node ${SKILL_DIR}/scripts/decisions.mjs --fix "$ADVERSE_RUN"/fix-*.json \
    --out "$ADVERSE_RUN"/decisions.json
```

`decisions.mjs` folds every payload of this iteration into the `decisions.json`
the `--record` command above reads — `fixed` and `declined` become decisions of
those dispositions carrying the identity fields the payload already holds, so
you never reassemble them by hand. Fold the whole iteration in one call.

**An item a fix agent names but does not fix is a finding with no ID.** It is
not in `report.json`, `--record` has nowhere to put it, and it exists only in
the agent's final report — which you read once and then lose. The measured cost
of losing one: an agent reported that a preflight step was not budgeted, under a
heading that said "out of scope, named not fixed"; nothing was recorded, and the
next iteration two independent round-1 reviewers spent a lane-pair's attention
re-deriving it. So the payload carries a `named_not_fixed` list, `decisions.mjs`
mints an id for each entry (`NF-<batch>-<n>`, which cannot collide with triage's
`F<n>`) and records it `noted` with the agent's own reasoning. `noted` settles
nothing, deliberately: an untriaged footnote annotates the next briefing and
adjudicates no finding. It used to be recorded `deferred`, which settles — so a
fix agent copying a blocking critical's title into `named_not_fixed`, which
`fix.txt` tells it to do verbatim, closed that critical with no code change and
no warning. Read the block it prints before you record — a channel you forward
without reading is the same footnote in a new place, and **an item that is
`noted` still needs a decision from you.**

**Every fix commit gets a regression pass** (Phase 9), run by a lane that did
not report the findings it closes. `fix.txt` tells the agent so, and names the
four questions that pass will ask — which is what makes the agent's own "What
else this changed" section honest. Run it per commit, while the diff is small
and its intent is still known.

**Do not re-run the panel to look for siblings of a finding you fixed.** The fix
agent has already done it, better and cheaper: a reviewer is reasoning about a
diff and the fix agent is holding a working reproduction. Asked for a sibling
sweep, one found a reserved window seven times the size of the reported one,
reachable by the same mechanism from the same two attacker-controlled bytes,
that four reviewers across two rounds had missed. A re-run panel will spend a
full round rediscovering the parent.

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
4. the path to write its own JSON object to: `$ADVERSE_RUN/verify-<persona>.json`

Verification uses the **original reporter's** persona, not a dedicated
verifier: judging whether a finding is closed needs the lens that produced it.

Each writes its own `{persona, verified: [{id, title, status, reason}], added:
[...]}` to that path — same as round 1, the orchestrator does not retype it —
where `status` is `closed`, `open`, or `moot`. `verify.mjs` below validates it
against the schema before anything downstream trusts it; there is no separate
check to run first.

The `added` half is not a formality. **A fix written under pressure to close a
finding is unreviewed code**, written by whoever was most convinced the finding
was real — precisely the frame of mind that ships a hasty patch. A verification
pass that only ever confirms closures would launder new defects into the tree
one iteration at a time.

### The regression pass — one per fix commit, by a lane that did not report it

Verification asks the reporter whether its finding is closed. Nobody is asking
what else the fix changed, and the reporter is the worst available lens for it:
it is the agent most invested in the finding being closed. The `added` channel
exists to catch exactly that and is being asked of the one reviewer least
motivated to find anything there.

The cost of leaving it unasked, measured: one campaign's first iteration fixed
25 findings and its second found 40 — at least one of them *created by* the
first. New warning paths added by a fix became fresh per-message work inside a
bounded drain loop, so the bound stopped bounding. The fix was correct in
isolation and wrong in context, which is the characteristic shape and the one
nobody catches by reading a diff for correctness.

So: **one read-only pass per fix commit, run once, on complete work, by a lane
that did not report any of the findings that commit closed.** Not oversight of a
fix agent while it works — a half-applied change is indistinguishable from a
bug, it pays for a second full-context agent holding the same lens, and by the
time it objects the edits exist.

Which lane is not yours to choose. You just fixed the code; picking your own
reviewer is the one selection an interested party must not make:

```bash
node ${SKILL_DIR}/scripts/regression.mjs --repo . --commit <fix-sha> \
    --closed-by <persona> [--closed-by <persona> …]
```

`--closed-by` is every persona that reported a finding this commit closed,
spelled the way the registry spells it — lowercase, or a split lane's half like
`auditor-a`. A name this review could not have written is refused at exit 2,
not ignored — and that is a wider rule than "resolves to no lane". Both of
these are refused: `--closed-by Auditor` differs by one capital letter,
excluded nobody, and handed the pass to the lane that reported the finding
under a line asserting it had reported none of them; `--closed-by auditor-ab`
*does* name the auditor lane but is not a half the splitter emits, and one
tightening of that suffix pattern silently moved it from excluding the auditor
to excluding nobody. If the bridge would have to guess at a name, retype it.

**The flag is required, and omitting it is the same failure spelled shorter.**
With no `--closed-by` at all the run used to exit 0 having excluded nobody,
under that same line — a clean artifact claiming a disinterest nothing checked.
If the commit really closes no reported finding, say so with
`--closed-by-none`: the pass then runs with nothing excluded and its `reason`
attributes that to you rather than asserting it. The two cannot be combined.

The answer is the Adversary when the fix diff crosses a trust boundary and the
Auditor otherwise (`assessScope`, the same signal that gates the Adversary in
Phase 1), skipping any lane that reported into the commit — and never the
Pragmatist, whose findings are advisory and so cannot hold a regression. When
every eligible lane reported into the commit it says `CONFLICTED` and picks one
anyway: skipping is the silent direction, and a skipped pass reads exactly like
a clean one. Print that line into your Phase 7 notes when it fires.

Spawn one subagent, with that persona's system prompt and:

1. `${SKILL_DIR}/scripts/prompts/regression.txt`
2. **the repository's own constraint block** — the same one the fix agents got
3. the fix commit's diff: `git show <fix-sha>`, and what it was written to close
4. the path to write its own JSON object to:
   `$ADVERSE_RUN/regression-<persona>-<pass number>.json`

**The pass number is a digit, and it is not optional when a lane runs more than
one pass.** This phase is per fix commit and a lane routinely reads several in
one iteration, so `regression-<persona>.json` for all of them means N−1 passes
overwrite each other and vanish before the glob below ever runs. Number them
from 1 in the order you spawn them: `regression-auditor-1.json`,
`regression-auditor-2.json`.

Numbering restarts each iteration, and the loop reuses `$ADVERSE_RUN`, so
iteration 2 overwrites `-1` and *leaves iteration 1's `-2` and `-3` for its own
glob to pick up* — the Phase 0 "never reuse a fixed run directory" rule, one
directory deeper. The fold refuses that rather than trusting you to remember
it: a pass file naming a commit this outdir already folded is exit 2, naming
the file and the commit. Delete the leftovers, fold into a fresh `--outdir`, or
pass `--refold` when re-reading the same commit is what you meant.

A `round1-<persona>.regression.json` the fold cannot parse is exit 2 for the
same reason — it cannot tell which passes it would re-sign — and the same three
remedies apply, `--refold` included: the flag skips the prior folds rather than
overruling them, so it clears this refusal as well as the stale one. That
matters because the path is derived from a persona name, so any agent, or a
fold killed mid-write, can leave a byte there; while `--refold` did not clear
it, one such byte wedged every lane of the fold and only deleting the file got
past it.

Two of the three remedies apply when that path is not a regular file at all.
`--refold` escapes by overwriting the file, and a directory does not take an
overwrite, so the fold says so and exits 2 with or without the flag: remove the
path, or fold into a fresh `--outdir`.

Digits, never letters. `regression-auditor-c.json` is a well-formed *split-lane
half* id everywhere else in this skill, and round 2's independence signal keys
on that distinction — a pass numbered `-c` would be counted as a third half of
the auditor lane. A lane that is itself split writes both:
`regression-auditor-a-1.json` is half a's first pass.

One agent per fix commit, and it is cheap precisely because the fix diff is
small and the intent is known — the two properties that make a full re-review
expensive are both absent. It **supplements** verification rather than replacing
it: they answer different questions and only one of them is about closure.

This is also the **first role to try on a smaller model** (#53). It is
read-only, single-question, bounded in output, and the most repeated role in the
loop, so a weak result costs an observation rather than a commit. Measure the
right thing if you try it: not "did the commit land green", but whether the pass
still recognizes an anomaly nobody handed it — the recognition, not the
procedure, is what the role is for.

Then fold every pass of the iteration in one call, and feed the result to triage
beside the verifications:

```bash
node ${SKILL_DIR}/scripts/validate.mjs --phase regression "$ADVERSE_RUN"/regression-*.json

node ${SKILL_DIR}/scripts/regression.mjs --payload "$ADVERSE_RUN"/regression-*.json \
    --outdir "$ADVERSE_RUN"
```

`--phase regression` reads the persona off the basename with the pass number
stripped, so `regression-auditor-1.json` and `regression-auditor-2.json` both
validate as the `auditor` lane, and a payload declaring a different `persona`
than its filename is refused. That stripping is only done for this phase: a
`-1` on a round-1 or round-2 file still implies a persona named `auditor-1` and
is refused as an unknown lane, because there the basename is the only thing
holding a payload to the path it was written to. **Letters after the persona are halves, digits are passes** —
`regression-auditor-c.json` validates as half `c`, not as pass three.

The reshape stamps each finding `provenance: "regression"`, and both renderers
print it: "a landed fix commit's regression pass found this" is a different fact
from "round 2 noticed this", and an operator reading a ranked list cannot act on
the first without knowing which it is. The findings themselves feed `added` like
any other new finding — a regression against a commit that already landed *is*
that shape.

The stamp does **not** say the fix introduced anything, and neither renderer
claims it does. A regression entry is classified `intended-inert`,
`intended-undocumented` or `unintended`, and only the last was introduced in the
sense a reader takes from that word — so `provenance` records which pass found
the finding and nothing about causation. The classification is where causation
lives.

### Loop

Feed `verified` + `added` back through triage → synthesize → Phase 7, with the
ledger attached, and loop:

```bash
node ${SKILL_DIR}/scripts/verify.mjs --verify "$ADVERSE_RUN"/verify-*.json \
    --outdir "$ADVERSE_RUN" --briefing "$ADVERSE_RUN"/briefing.json

node ${SKILL_DIR}/scripts/triage.mjs \
    --round1 "$ADVERSE_RUN"/round1-*.verified.json \
    --round1 "$ADVERSE_RUN"/round1-*.regression.json \
    --repo . --base "$BASE" --gate "$GATE" --ledger "$LEDGER" \
    --out "$ADVERSE_RUN"/briefing.json
```

Drop the second `--round1` line when no regression pass ran. If a lane both
verified its own findings and ran a regression pass on someone else's fix
commit, it arrives twice — add `--merge-personas <persona>`, which unions the
findings and keeps the worse verdict, exactly as it does for a split lane.

`regression.mjs --payload` refuses to fold a lane whose `round1-<persona>.regression.json`
already names commits these passes do not, because that file is an earlier
iteration's and re-folding it re-signs stale passes as this iteration's
evidence. Pass `--refold` when re-reading the same passes is what you meant.

`verify.mjs` validates each payload against the schema before anything trusts
it — the same discipline every other leg of this flow already has — then
reshapes it into the round-1 shape triage.mjs reads. `added` becomes
`findings` — **and so does every `verified` entry still `open`**, because that
is the reviewer saying the fix did not work, and the stop condition is
arithmetic over `findings`. A verification that cannot reach `findings` cannot
hold the loop open, which is how a run once converged with exit 0 on a payload
whose own verdict was `reject`.

Pass `--briefing` (the previous iteration's, still on disk at this point) so a
reopened finding keeps the severity, kind and anchor it was first reported
with. Without it each one falls back to a blocking `warning`/`behavioral`:
noisy rather than silent, and recoverable by passing the flag.

The bridge binds by id and then by title, and the second route is not a
convenience. `briefing.mjs` re-mints finding ids **positionally on every triage
run**, so an id a reviewer copied out of an earlier iteration's briefing names
nothing here — or, worse, names a different finding. Binding by id alone put
every such verification at the blocking fallback, which for a `design` finding
contradicts the rule that design never blocks and made the loop unable to
converge on advisory work.

One case neither route reaches: a finding a round-2 reviewer **added**. It is
in `briefing.json` under no key at all — triage's only finding input is
`--round1` — so its verification keeps the blocking `warning`/`behavioral`
fallback with a null anchor. That is noisy rather than silent, which is the
direction to fail in, but it is a gap and not a covered case: an advisory
round-2 addition verified `open` will hold the loop open until someone records
a decision on it. A title that matches two briefed findings binds to neither: it cannot say
which is meant, and guessing is how a severity gets copied off the wrong
finding, so that case falls back to blocking and says so.

The full `verified` array also rides along on the reshaped file, so you can
read every disposition — closed and moot included — while deciding what to
record in Phase 7. It is not carried into `report.json`: the dispositions that
have to reach the arithmetic are the open ones, and those are findings now.
Its exit codes follow the same contract as every other bridge:
2 means it never read a payload, 1 means it read one that failed the schema.
Either way it publishes nothing: every payload is read and validated before the
first `round1-<persona>.verified.json` is written, so a refusal on the last
payload does not leave the earlier ones on disk for the next glob to read as a
complete set. `repair.mjs` and `regression.mjs --payload` hold to the same rule.


Findings the ledger records as settled will not be re-litigated; anything
recorded `fixed` that comes back is flagged `REGRESSED` and is the loudest
thing in the run — and one carrying `adjudicated.group` is louder still: it
says a root-cause fix left a symptom live, and names the sibling citations
that fix was supposed to cover.

Finding and group IDs are **per-run**, re-derived by each triage pass. The
ledger does not depend on them: a recorded group carries its own title and
citation titles, which is what the next iteration matches and renders.

### Four cheaper answers than another panel

A maintainer running this loop across several repositories re-ran the full panel
after every fix batch and reported that fixing a batch "resulted in many
regressions and new bugs (including criticals) every single time", which then
needed another full review — "not a cheap or speedy proposition." The re-panel
is the single largest expense in the loop and it is not what this skill asks
for. Before reaching for one:

- **Phase 9 exists.** Verification plus the regression pass above answers both
  questions a re-panel would, against a small diff with the intent known. A full
  re-panel after a fix batch is not the prescribed path.
- **Smaller fix commits.** Regression risk scales worse than linearly with diff
  size, and the pass above is cheap enough to run on every commit only because
  each commit is small.
- **Fix in dependency order.** A test cannot be trusted until what it reads is
  correct, so a test-only commit that lands before the code it pins is a green
  gate that proves nothing.
- **Decline more.** The loop's exit condition is *decisions recorded*, not
  *findings fixed* — `declined` and `deferred` both settle a finding, and both
  keep the ledger from raising it again. `noted` does neither; naming a finding
  in `named_not_fixed` is not a way to close it. A real-but-low-consequence finding
  fixed hastily is net negative: it is unreviewed code written by whoever was
  most convinced the finding was real. A campaign that fixes everything is
  choosing maximum churn, and every orchestrator defaults to fixing because
  nothing else tells it otherwise.

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

A fourth shape belongs to you rather than to the panel: **a decision you had to
derive because nothing told you how.** How to divide the batch, what a fix agent
had to be told, which nodes could run at once, which role could drop a tier —
if you worked one of those out mid-run, the next orchestrator will work it out
again. Write it into the phase where the decision gets made, not into a section
about orchestration: doctrine filed near a decision is doctrine that gets
skipped at it.

Where each lesson goes:

| The lesson is about | Write it to |
|---|---|
| how a reviewer should look | the persona's prompt in `src/personas.mjs`, or `VERIFY_INSTRUCTIONS` in `src/prompts.mjs` if it is about checking a fix |
| how this repository works | its `CLAUDE.md` / `AGENTS.md` / architecture notes |
| how the loop itself should run | this file — in the phase that makes the decision, never as an appendix |
| how *you* should work, across projects | your own persistent instructions or memory, if the harness gives you one |

Then say what you wrote and why, in one or two sentences. Do not pad this: a
run that taught nothing generalizable should say so and stop. The point is that
the panel gets better at reviewing this codebase every time it runs, rather than
re-learning the same lesson and re-reporting the same class of finding.

## Compaction-safe checkpoints

A convergence-loop run often outlives one context window, and the orchestrator
cannot trigger `/compact` itself — only the operator watching context pressure
can. This table exists so they know when it's cheap: a checkpoint is safe when
every fact the loop needs next already lives in a file, a commit, or the
ledger, rather than only in conversation state.

| Phase | Safe to compact | Why |
|---|---|---|
| 0 — scope, run dir, gate | At its end, before Phase 1 | Nothing has been spent yet; `$BASE`, `$GATE`, `$LEDGER` are all cheap to recompute if lost. |
| 1 — file list & plan | Once `plan.json` is written | The plan is a file now, not a fact anyone has to remember. |
| 2 — round 1 | **Never** until every persona's file passes `validate.mjs` | An unsaved or unvalidated reviewer payload is exactly the state a mid-phase compaction loses — a subagent still working has nothing durable yet. |
| 3 — triage | Once `briefing.json` is written | Triage's whole output is a file; Phase 4 reads it, not the conversation. |
| 4 — round 2 | **Never** until every `round2-<agent>.json` passes `validate.mjs` — both halves of a split lane, not one file per persona, and never between triage and synthesize | Same unsaved-payload risk as Phase 2, plus `$ROUNDS`/`$CAP`/`$R2_REASON` exist only as shell variables until Phase 6 writes the report that carries them forward. |
| 5 — repair, combine | Once `round1.json` and `round2.json` are written | The repaired and combined files are the only state Phase 6 needs. |
| 6 — synthesize | Once `report.json` / `report.md` are written | This is the artifact the whole triage → synthesize span exists to produce. |
| 7 — decide, record | **Never mid-fix-batch.** Safe once decisions are `--record`ed to the ledger *and* every fix commit is on the branch with the gate re-run green over all of them together | Before that, "which findings are fixed" and "what the diff contains" exist only as edits in flight — exactly the state Phases 8–9 depend on. A worktree's own green is not the composed one, so a batch that ran concurrently is not checkpointable until the replay is done. |
| 8 — check convergence | Anytime after it runs | Its exit code is derived entirely from the ledger and `report.json`, both already durable. |
| 9 — verify | **Never** until every `verify-<persona>.json` passes validation | Same unsaved-reviewer-payload rule as Phases 2 and 4. |
| 10 — hand over | Anytime | Everything is in the ledger, the branch, and (if opened) the PR. |
| 11 — harvest lessons | Once the lesson is written to its destination file | Before that, what was learned only exists in conversation. |

Underneath all twelve rows, the same three rules: **never mid-fix-batch, never
with an unsaved reviewer payload, never between triage and synthesize.**
Everywhere else, disk already holds what the loop needs next.

## Failure handling

| Failure | What to do |
|---|---|
| The repo's own gate is red | Stop before Phase 2. Report which check failed; a panel review of a broken build is wasted tokens. |
| `git merge-base` finds no base | Ask which ref to diff against. Do not guess `main`. |
| One reviewer returns garbage twice | Continue without it, mark the run degraded in your summary. |
| ≥2 reviewers fail | Abort. The model is misbehaving; suggest re-running or a single round. |
| `triage.mjs` reports many `DISPROVED` | Surface it. A reviewer inventing line numbers is worth the user knowing. |
| `triage.mjs` reports `REGRESSED` | Lead with it. A fix that did not take is more important than any new finding. |
| `repair.mjs` exits non-zero | Read the unresolvable IDs on stderr. Usually one invented ID; drop that edge or ruling and continue. |
| `triage.mjs` reports an `OVERSIZED` candidate root cause | The edges chained further than one root cause plausibly reaches. It will not collapse whatever round 2 says; tell round 2 to name the smaller root causes inside it. |
| Any bridge script (`collect`/`combine`/`triage`/`repair`/`synthesize`/`plan`/`converge`/`verify`/`decisions`/`regression`) exits 2 with a JSON path in the message | It could not read that input file — check the path, or that a previous step actually wrote it. Exit 2 means "this run never got as far as judging anything"; it is never a claim about the review itself. |
| `converge.mjs` exits 3 | The cap, not success. Say plainly what is still open. |
| Ledger version mismatch | Do not delete it. Tell the user which version it is; the schema changed under them. |
| `node` not on PATH | Tell the user to install Node 22+. Do not improvise a fallback. |
| User interrupts | Stop spawning subagents. Say where the partial artifacts are. |

## Notes for the orchestrator

- **Cost.** The full shape is 4 round-1 calls + 3 round-2 calls = **7**. The
  Phase 1 plan scales that in both directions: a small boundary-free diff runs
  2 round-1 calls (Auditor + Steward) and, when round 1 reports nothing of a
  blocking kind, no round 2 — a floor of **2**. A large diff splits the
  per-file lanes into two agents each, and round 2 is per AGENT rather than per
  persona — both halves rule, which is the point of splitting — so it is
  6 + 5 = **11**, not 6 + 3: four round-2 calls from the two split lanes plus
  the Steward, the Pragmatist never cross-reviewing. Each loop iteration adds
  ~3 cheap verification calls, not another 7, plus one regression pass per fix
  commit.
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
