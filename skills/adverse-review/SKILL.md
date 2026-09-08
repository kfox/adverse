---
name: adverse-review
description: >
  Multi-agent adversarial code review. Spawns reviewer subagents (Auditor,
  Adversary, Steward, Pragmatist) on a single model, cross-examines, then
  deterministically synthesizes one ranked report and hands it to the user.
  On request it iterates — fix, verify, repeat, until nothing blocking is
  left. Use for non-trivial PRs, security-sensitive changes, refactors
  touching many files, or any change where one perspective has obvious blind
  spots. Trigger phrases include "adverse review", "adversarial review",
  "multi-perspective review", "review my changes from multiple angles",
  "panel review"; "review until clean" selects the iterating shape. NOT
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

## The shape of a run

Review, synthesize, report, hand the findings to the user — Phases 0–7 below,
then hand-over. One pass is the whole default doctrine: the panel's job is to
see clearly, and what happens to the findings is the user's call.

**Opt-in: the convergence loop.** When the user says "until clean", "until
it's done", "keep going", or asks to institutionalize review in a workflow, the
run continues past Phase 7 — fix, verify, re-check, repeat — with the stop
decided by arithmetic, never by judgment, and capped. Never run the loop
unasked, and before running one read
[references/convergence-loop.md](references/convergence-loop.md): it holds the
loop's stop condition, the ledger, Phases 8–9, the regression pass, and the
doctrine that keeps a loop from manufacturing its own work. Announce which
shape you are running.


## The four lanes

| Persona | Owns | Kinds |
|---|---|---|
| **Auditor** | correctness: does it compute the right answer | `defect`, `behavioral` |
| **Adversary** | what an attacker can do | `defect`, `behavioral` (with an attack) |
| **Steward** | what the code says about itself: docs, schemas, rules, and tests | `contract` — **advisory**, `behavioral` |
| **Pragmatist** | shape: structure, coupling, complexity | `design` — **advisory** |

Two rules follow from that table and both are load-bearing:

- **`design` and `contract` findings never block.** Design opinions do not
  converge — a reviewer can always want different structure — and contract
  findings never run out: every sentence of prose is a checkable claim, and a
  fix's own comments and docs replenish the supply. Counting either means the
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
each one is made — Phases 7 and 11 here, Phase 9 in the loop reference — and
not at the top of this file. A rule read at the top of
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

**Run them with `gate.mjs`, and do not summarize them yourself.** Name each
check; the bridge runs it, records its exit code, and binds the record to the
commit it ran against:

```bash
node ${SKILL_DIR}/scripts/gate.mjs --repo . \
    --check 'lint=npm run lint' \
    --check 'types=npx tsc --noEmit' \
    --check 'test=npm test' \
    --out "$ADVERSE_RUN/gate.json"
```

Exit 1 means a check said no — that is the red gate above, so stop. Exit 0 with
`status: partial` means a check could not be run: the panel may proceed, and the
gate will suppress nothing.

The reason this is a script and not a sentence is the same reason Phase 2 makes
each reviewer write its own payload. `gate.json` is the only artifact in this
flow whose job is to stop reviewers reporting things, and until it was measured
it was a line the orchestrator typed from memory — which is green whether or not
the checks ran, ran on this tree, or all passed. Only a gate that
`triage.mjs` can re-bind to the reviewed HEAD is allowed to suppress anything
(`verified: true`); every other state, a hand-written summary included, reaches
reviewers as a claim and costs nothing but a few findings they already knew
about. Never hand-write `gate.json`, and never describe a gate you did not run.

`--gate "<summary>"` still exists for a repo whose checks cannot be scripted.
It is honest and it is weak: it arrives as `source: "asserted"` and suppresses
nothing, so use it to inform reviewers, never to quiet them.

**Pin the base.** Every reviewer must read the same tree, and triage needs a
stable ref for its in-diff classification:

```bash
BASE=$(git merge-base HEAD origin/main)   # or the branch the user named
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

**If the user asked for more or less review than usual, that goes here**, as
`--depth thorough` or `--depth cheap`, and nowhere else. It is the one input
the diff cannot supply, it is easy to forget by Phase 4, and a run planned at a
depth nobody recorded renders exactly like a run at the default one. Pass it
once and every later decision reads `plan.json` instead of your memory of what
the user said.

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
nobody looked for. Skip a lane only when the plan says skip — a thorough pass
is `--depth thorough` above, which un-skips the lanes itself, so there is
nothing to remember here. Every skipped lane must be **said out loud** and
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

**That check is also the probe precondition.** A reviewer may attach a
reproduction to a finding (Phase 2.5), and the tool re-runs each one in a
worktree of its own. If the check above failed, probes are off for this run:
omit `--allow-execute` below, and **say so** in your summary. A report that is
silent about probes being unavailable reads exactly like a panel that did not
want one — the same reason a skipped lane has to be declared. `plan.json`'s
`probes.allowed` is the other half of the answer; both must say yes.

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
    whatever the diff makes them want to see), and the log (`git log
    $BASE..HEAD`) — commit messages are where this flow keeps rationale, so a
    decision explained there is documented;
  - the diffstat and file list from Phase 1;
  - the gate: `gate.json`'s `summary`, and whether it is `verified`. Tell a
    reviewer **not** to report what those tools already prove only when
    `verified` is true. An unverified gate is passed along as context and
    explicitly does not license silence — reviewers who suppress on an
    unmeasured green produce a report with a hole in it that reads like a clean
    lane;
  - the exact path to **write its own JSON object to** with the Write tool —
    `$ADVERSE_RUN/<agent>/round1-<agent>.json`, where `<agent>` is the persona
    (`-a`/`-b`-suffixed for a split lane's halves) — its own subdirectory, and
    not a reply with the JSON in chat. The Write tool creates the directory.
- **Model**: `sonnet` by default. `plan.json`'s `tier.escalate` carries the
  user's own answer: `true` means escalate the panel, `false` means the default
  tier stands, and `null` means depth made no claim and the call is yours — the
  diff makes the case, and it is pinned paths, credential or sandbox handling,
  subtle concurrency, a change whose failure ships something.
  Whatever the tier, pass the SAME model to every persona — mixing models
  across personas defeats the single-model design. That rule is about the
  panel, whose whole method is one model wearing four lenses. The roles outside
  it — a fix agent, the absorber commit, the regression pass — are not lanes
  and are tiered per role instead; Phase 7 says on what basis.

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

So each agent writes into `$ADVERSE_RUN/<agent>/`, its own subdirectory, and
every glob in this file is one segment wider for it. The bridges never required
siblings — they take the paths you hand them, and `validate.mjs` binds each
payload to its basename wherever it sits. What the layout closes is the
**accident** class: one campaign lost payloads three separate times to two
agents numbering files into the same flat directory, and a lost payload reads
as a lane that found nothing.

What it does not close is authorship (#62). An agent free to write anywhere can
write into a sibling's directory as easily as into a sibling's filename, so
until the harness can make an agent's subdirectory the only place it may write,
these guards remain what they are: they stop a payload contradicting its own
path, and they do not authenticate its author. `combine.mjs --plan`
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
node ${SKILL_DIR}/scripts/validate.mjs --phase round1 "$ADVERSE_RUN"/*/round1-*.json
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

## Phase 2.5 — re-run the reproductions round 1 attached

A `behavioral` finding is defined as one settled by executing the code **or**
by an argument about execution, and until this step every one of them was
settled the second way. A reviewer that reproduced a bug in its worktree wrote
prose about it, the worktree was deleted, and nothing downstream could tell
that finding from one that was reasoned out.

Skip this whole phase when Phase 1 said probes are off, or when no payload
attached one — it costs nothing and establishes nothing:

```bash
node ${SKILL_DIR}/scripts/probe.mjs --round1 "$ADVERSE_RUN"/*/round1-*.json \
    --repo . --plan "$ADVERSE_RUN/plan.json" --allow-execute \
    --out "$ADVERSE_RUN/probes.json" && PROBES=1
    # `$PROBES` is what the two invocations below expand on. Set it only when
    # this phase actually wrote a file — an unset variable means Phase 3 and
    # Phase 6 pass no --probes, which is the right shape for a run that had
    # none.
    # --allow-execute is the operator's yes and it is required: without it
    # every attached probe is recorded as declined and nothing runs. --plan
    # carries the other yes and the per-lane cap, so neither is retyped.
    # --sandbox '<command prefix>' prefixes every probe with real containment
    # you supply (bwrap --unshare-net --, sandbox-exec -f …). Pass one if you
    # have one: this runs code from the diff under review, and the tool cannot
    # unshare a namespace on its own. Whatever you pass is recorded, and so is
    # passing nothing.
```

**The reviewer proposes; the tool confirms.** Nothing a payload writes can make
a finding `demonstrated` — the bridge computes that from an exit code it
collected itself, in a fresh detached worktree, with a hard timeout. This is
the routing rule `regression.mjs` already documents: the interested party must
not be the one that confirms its own work.

What it can and cannot do to a finding:

- A probe that **reproduced** buys its finding `confidence: demonstrated`, the
  only label above `cross-validated`, and one that can block on its own.
- A probe that **ran and did not reproduce** is annotated, loudly, and is
  **never** a `DISPROVED`. Either the finding is wrong or the script is, and
  nothing here can tell those apart — so round 2 gets the question rather than
  a verdict. Read the stderr lines; a lane whose reproductions keep failing is
  a lane overstating what it saw.
- A probe that was **not run** — declined, capped, unenabled, unopenable —
  costs its finding nothing at all. That has to stay true: a reviewer that pays
  for declining invents a probe instead, and a fabricated reproduction is worse
  than an honest argument.
- Nothing here moves an advisory kind. A `design` finding with a reproduced
  probe is still advisory.

Exit is 0 whatever the probes said. A reproduction that failed is a fact about
a finding, never a verdict on the change.

## Phase 3 — triage (deterministic, no model)

This is what makes round 2 cheap and what keeps cross-lane consensus alive:

```bash
node ${SKILL_DIR}/scripts/triage.mjs \
    --round1 "$ADVERSE_RUN"/*/round1-*.json \
    --repo . --base "$BASE" --gate-file "$ADVERSE_RUN/gate.json" \
    ${LEDGER:+--ledger "$LEDGER"} \
    ${PROBES:+--probes "$ADVERSE_RUN/probes.json"} \
    --plan "$ADVERSE_RUN/plan.json" \
    --out "$ADVERSE_RUN"/briefing.json
    # --probes puts each re-run reproduction in front of round 2 as
    # `probeCheck`, re-bound to the reviewed HEAD first: a probes.json a
    # previous loop iteration left in this directory describes a tree that has
    # since moved, and every way of failing that check lands on "not run",
    # which confirms nothing.
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
- **Probe results**, when Phase 2.5 ran. `probeCheck.confirmed` is a behavior
  the tool watched happen; `status: "not-reproduced"` is a question for round 2
  and explicitly not a `DISPROVED`. A finding with no `probeCheck` is judged
  exactly as every finding was before probes existed.
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
    "$ADVERSE_RUN"/*/round1-*.json)"
```

One dial moves, deterministically:

- **Round 2 is skipped only when round 1 reported nothing blocking** under the
  synthesizer's own `isBlocking` (info-severity findings do not block; a
  missing or unrecognized kind does). The skip is never free — it forgoes
  round 2's additive channel, the findings a reviewer only sees with the other
  lanes in view — so it is never taken on size, and never taken silently:
  Phase 6 must declare it with `--round2-skipped "$R2_REASON"`. A missing or
  off-shape round-1 payload fails closed: round 2 runs.
(In a convergence loop a second dial — the iteration cap — moves here too;
see [references/convergence-loop.md](references/convergence-loop.md).)


If `$ROUNDS` is 1, phases 4–5 collapse, and the skip rides into the report via
`--round2-skipped`. That is the **only** way round 2 is dropped: it is earned
by a round 1 that found nothing blocking, never asked for up front. A
pre-flight skip would leave a small diff structurally unable to produce a
blocking finding at all, which is why `--depth cheap` does not touch rounds.
Otherwise: for each **round-1 agent** that produced a valid review **except the
Pragmatist's**, spawn a subagent with the same persona system prompt and:

1. `${SKILL_DIR}/scripts/prompts/round2.txt`
2. `$ADVERSE_RUN/briefing.json`
3. the repo path and `$BASE`
4. the path to write its own JSON object to: `$ADVERSE_RUN/<agent>/round2-<agent>.json`

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
node ${SKILL_DIR}/scripts/validate.mjs --phase round2 "$ADVERSE_RUN"/*/round2-*.json
```

The synthesizer treats a missing round 2 as an empty cross-review — which is
why a round 2 that did not run is declared with `--round2-skipped` rather than
simply left out.

## Phase 5 — repair, then combine

Repair rewrites each edge's title to the briefing's canonical string, keyed on
the finding ID, so a paraphrase cannot silently drop the edge:

```bash
node ${SKILL_DIR}/scripts/repair.mjs \
    --briefing "$ADVERSE_RUN"/briefing.json \
    --round2 "$ADVERSE_RUN"/auditor/round2-auditor.json \
    --round2 "$ADVERSE_RUN"/adversary/round2-adversary.json \
    --round2 "$ADVERSE_RUN"/steward/round2-steward.json \
    --outdir "$ADVERSE_RUN"
```

Pass every round-2 file, including both halves of a split lane
(`round2-auditor-a.json`, `round2-auditor-b.json`) — `--round2
"$ADVERSE_RUN"/*/round2-*.json` expands to exactly that. Each is repaired to
`round2-<agent>.repaired.json`, keyed on the agent so two halves land in two
files rather than one refusing to overwrite the other.

It exits non-zero when an edge names an ID not in the briefing — a reviewer
invented a finding number and that edge is about to vanish. Read the stderr
lines; do not ignore the exit code.

Then combine both rounds:

```bash
node ${SKILL_DIR}/scripts/combine.mjs --round1 "$ADVERSE_RUN"/*/round1-*.json \
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
    --plan "$ADVERSE_RUN"/plan.json \
    ${PROBES:+--probes "$ADVERSE_RUN/probes.json"} \
    --out "$ADVERSE_RUN"/report.md \
    --json-out "$ADVERSE_RUN"/report.json \
    --html-out "$ADVERSE_RUN"/report.html
    # one --skipped per lane the plan skipped, quoting the plan's own reason:
    #   --skipped adversary="no trust boundary in the diff"
    #   --skipped pragmatist="small diff; design findings are advisory"
    # and, when Phase 4 skipped round 2:
    #   --round2-skipped "$R2_REASON"
    # --probes is what turns a confirmed reproduction into
    # `confidence: demonstrated` and puts the script's own output in the
    # report beside the finding. Bound to --briefing's head, same as triage.
    # --plan also carries the run's depth into the report header, so a run
    # planned `cheap` cannot render like one planned at the default.
    # --plan makes the skipped-lane accounting arithmetic: a lane the plan ran
    # that has no payload and no --skipped/--degraded refuses the synthesis,
    # because its silence otherwise reads as a clean review.
    # in a convergence loop, name the pass so the run's counts can be read per
    # iteration. It is the LEDGER's counter (`ledger.iterations.length + 1`,
    # references/convergence-loop.md), never a number minted here:
    #   --iteration 2
```

This is also where the run leaves its one line of telemetry: counts only, no
prose, appended to `${XDG_CACHE_HOME:-~/.cache}/adverse/runs.jsonl` for every
repository on the machine. It is what makes the plan's own rules arguable from
data later — see references/telemetry.md, and pass `--no-telemetry` if the user
asks for none. A run whose line cannot be written still publishes its report.

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
6. Any **demonstrated** finding, called that: the tool re-ran a reproduction
   and the behavior happened. It is the strongest thing in the report and it
   deserves to be read before anything settled by argument. Say plainly when
   probes were off for the run, and why.
7. A pointer to the report and the HTML dashboard.

## Phase 7 — decide, and act

Ask the user how to proceed and do not edit until they
pick:

- Fix cross-validated findings only? (highest confidence)
- Fix everything except disputed? (most common)
- Show a specific finding's full reasoning?
- Just save the report.
- Post the report to the pull request, if the branch has one? Dry-run it and
  show them the body first — the mechanism and its refusals are in Phase 10.

In a convergence loop you already have authority to fix, and every decision —
including each decline — must be recorded to the ledger before the next check;
the recording step and its rules are in
[references/convergence-loop.md](references/convergence-loop.md).


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
because the setup cost is visible and the saving is not. Once a worktree's
commit is replayed, that worktree is spent — it goes in Phase 10's teardown
with the reviewer fleet.

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
4. the path to write its own JSON object to: `$ADVERSE_RUN/fix-<batch>/fix-<batch>.json`

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
regression pass (a loop role — references/convergence-loop.md), which is
read-only, one question, bounded in output, the most repeated role in the loop
and the least destructive if it comes back weak; then the loop's
docs-and-comments absorber, where nothing changes behavior and the gate is the
whole test; then a test-only pinning commit. **Not the
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

**Do not re-run the panel to look for siblings of a finding you fixed.** The fix
agent has already done it, better and cheaper: a reviewer is reasoning about a
diff and the fix agent is holding a working reproduction. Asked for a sibling
sweep, one found a reserved window seven times the size of the reported one,
reachable by the same mechanism from the same two attacker-controlled bytes,
that four reviewers across two rounds had missed. A re-run panel will spend a
full round rediscovering the parent.

Phases 8 and 9 belong to the opt-in convergence loop and live in
[references/convergence-loop.md](references/convergence-loop.md); a single
pass goes from here straight to hand-over.

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

### Post the report to the pull request, if there is one

The run directory is scratch the OS reaps, so by tomorrow the panel's whole
product is unreachable — and if the change under review was a pull request,
that PR carries no trace that a panel ever looked at it: not the verdict, not
the blocking count, not which lanes were skipped. This puts a projection of
`report.json` there as an ordinary comment, and **rewrites that same comment on
every later pass**, so a five-iteration loop leaves one comment showing current
state rather than five stacked reports with four stale ones. A stale report is
the dangerous kind: it goes on saying a finding is open long after a later pass
closed it.

**Dry run first, every time.** Publishing is the user's call per run, never a
default:

```bash
node ${SKILL_DIR}/scripts/publish.mjs \
    --report "$ADVERSE_RUN"/report.json \
    --repo . \
    --out "$ADVERSE_RUN"/comment.md
    # in a convergence loop, name the pass, from the LEDGER's counter as in
    # Phase 6 — never a number minted here:
    #   --iteration 2
    # and only after the user has read the body and said to post it:
    #   --publish
```

Show the user what it printed and let them decide. Exit 0 saying "nothing to
publish to" or "no open pull request" is a normal answer, not a failure —
reviewing uncommitted changes with no PR anywhere is a first-class use of this
tool, not a degraded one. Exit 1 means it refused, or the post failed, and the
reason is on stderr.

Four properties of this step are not negotiable:

- **The target is resolved from `origin` and nothing else.** There is no
  argument anywhere that names a repository on GitHub; `--repo` is a local
  checkout, exactly as in every other bridge here. A branch that pushes
  somewhere other than `origin`, and an `origin` that has become its own
  `upstream`, are refused rather than redirected. **Do not work around a
  refusal by posting by hand** — the refusal is the point. This is the one
  capability in this repository that has already sent its output to somebody
  else's project, twice, and GitHub has no deletion for pull requests at all.
- **A comment, never a review.** A GitHub review carries approve /
  request-changes semantics, and `design` and `contract` findings can never
  block. Posting them through a mechanism that formally requests changes breaks
  that rule at the venue where breaking it costs the most.
- **Nothing inline.** An inline comment can only anchor to a line inside the
  diff, and a finding whose `claimCheck.inDiff` is `outside` cannot anchor at
  all — and those are the latent defects this change newly makes reachable,
  which triage protects on purpose. Everything goes in the body with
  `path:line`.
- **Never write the body yourself.** It is a projection of `report.json`,
  rendered in Node, for the same reason the findings are never LLM-rendered:
  the confidence groupings are the signal and prose regenerated from them loses
  it. Once the artifact is public, permanent, and read by people who were not
  in the session, that reason gets stronger rather than weaker — and so does
  the skipped-lane accounting the body carries, because a lane that was skipped
  and not mentioned reads exactly like a lane that looked and found nothing.

The ledger lives outside the run directory (Phase 0) precisely so that nothing
about cleaning up scratch can touch it. **Keep it if the work is not merged
yet** — a later pass on the same branch starts from these conclusions. Do not
commit either.

**Worktrees are the one thing a run does delete.** The mktemp rule above covers
files, which the OS reaps; a `git worktree add` also registers state in the
repository's own `.git/worktrees`, which nothing reaps — one campaign left
about sixty stale registrations cluttering `git worktree list` and shadowing
its branches. Remove every worktree this run created with the tool built for
it, never `rm -rf` — the reviewer fleet by its roster, each fix-agent worktree
by the path it was created at:

```bash
for agent in $AGENTS; do
  git worktree remove --force "$WORKTREES/$agent"
done
# and each fix-agent worktree the run added, by its own path
git worktree prune
```

**Spent worktrees only.** A reviewer worktree is spent when its lane's payload
validated; a fix worktree is spent when its commit is replayed onto the branch
(the replay rule in Phase 7). A detached worktree holding an UNREPLAYED commit
is the one thing `--force` would orphan — that commit is reachable from no
branch once the worktree record goes — so an unreplayed worktree is unfinished
work to resolve, not scratch to clean. `git worktree list` against the run's
paths is the checklist.

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

A long run can outlive one context window, and the orchestrator
cannot trigger `/compact` itself — only the operator watching context pressure
can. This table exists so they know when it's cheap: a checkpoint is safe when
every fact the loop needs next already lives in a file, a commit, or the
ledger, rather than only in conversation state.

| Phase | Safe to compact | Why |
|---|---|---|
| 0 — scope, run dir, gate | At its end, before Phase 1 | Nothing has been spent yet; `$BASE` is cheap to recompute and the gate is a file (`gate.json`), not something to remember. |
| 1 — file list & plan | Once `plan.json` is written | The plan is a file now, not a fact anyone has to remember — including `--depth`, which came from something the user said and would otherwise have to survive as conversation. |
| 2 — round 1 | **Never** until every persona's file passes `validate.mjs` | An unsaved or unvalidated reviewer payload is exactly the state a mid-phase compaction loses — a subagent still working has nothing durable yet. |
| 2.5 — probes | Once `probes.json` is written, or immediately if the phase was skipped | The bridge tears down every worktree it made before it returns; the record is a file, and a skipped phase has nothing to lose. |
| 3 — triage | Once `briefing.json` is written | Triage's whole output is a file; Phase 4 reads it, not the conversation. |
| 4 — round 2 | **Never** until every `round2-<agent>.json` passes `validate.mjs` — both halves of a split lane, not one file per persona, and never between triage and synthesize | Same unsaved-payload risk as Phase 2, plus `$ROUNDS`/`$CAP`/`$R2_REASON` exist only as shell variables until Phase 6 writes the report that carries them forward. |
| 5 — repair, combine | Once `round1.json` and `round2.json` are written | The repaired and combined files are the only state Phase 6 needs. |
| 6 — synthesize | Once `report.json` / `report.md` are written | This is the artifact the whole triage → synthesize span exists to produce. |
| 7 — decide, act | **Never mid-fix-batch.** Safe once the report is saved and any fix commits are on the branch with the gate re-run green over all of them together (in a loop, also once decisions are `--record`ed) | Before that, "which findings are fixed" and "what the diff contains" exist only as edits in flight. A worktree's own green is not the composed one, so a batch that ran concurrently is not checkpointable until the replay is done. |
| 10 — hand over | Anytime | Everything is in the ledger, the branch, and — once `publish.mjs` has run — the PR comment itself, which is rewritten rather than duplicated on a later pass. |
| 11 — harvest lessons | Once the lesson is written to its destination file | Before that, what was learned only exists in conversation. |

Underneath these rows, the same three rules: **never mid-fix-batch, never
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
| `probe.mjs` reports reproductions that ran without reproducing | Surface it, and do not treat it as the findings being disproved. Either the finding is wrong or the script is; round 2 is being asked which. A lane doing it repeatedly is overstating what it observed, and that is worth telling the user. |
| `repair.mjs` exits non-zero | Read the unresolvable IDs on stderr. Usually one invented ID; drop that edge or ruling and continue. |
| `triage.mjs` reports an `OVERSIZED` candidate root cause | The edges chained further than one root cause plausibly reaches. It will not collapse whatever round 2 says; tell round 2 to name the smaller root causes inside it. |
| Any bridge script (`collect`/`combine`/`triage`/`repair`/`synthesize`/`plan`/`converge`/`verify`/`decisions`/`regression`/`probe`/`publish`) exits 2 with a JSON path in the message | It could not read that input file — check the path, or that a previous step actually wrote it. Exit 2 means "this run never got as far as judging anything"; it is never a claim about the review itself. |
| `publish.mjs` refuses the venue (exit 1) | Report the reason and stop. It means the branch does not push to `origin`, or `origin` and `upstream` have become the same repository. **Do not post the report by hand instead** — the refusal exists because this is the one output path that has already gone to the wrong project. |
| `publish.mjs` says there is no open pull request | Nothing is wrong. Say so and move on; a run with no PR anywhere is a first-class use of this tool. The body it printed is still worth showing. |
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
  the Steward, the Pragmatist never cross-reviewing. (A convergence loop's
  per-iteration cost is in references/convergence-loop.md.)
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
