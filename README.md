# adverse

Multi-agent adversarial code review for **any** coding agent. Ships as both a standalone **CLI** and a Claude Code **Skill** — pick whichever fits your workflow, the underlying logic is the same Node.js code.

> **This fork's Skill is optimized for Claude Code, and has diverged.** It runs
> four lanes instead of three, classifies findings by kind as well as severity,
> hands reviewers the repo directly rather than a collected source blob, and can
> run as a **convergence loop** — review, fix, verify, repeat, until nothing
> blocking is left, with a mechanical stop condition rather than a judgment
> call. See [What this fork adds](#what-this-fork-adds). The CLI path shares the
> same core and gains the fourth persona and the kind axis, but not the loop.

```
$ adverse review ./src
⏳ collecting source...
   42 files in ./src
⏳ round 1: 4 reviewers in parallel...
   ✓ auditor:    5 findings, conditional (38.2s)
   ✓ adversary:  3 findings, reject       (44.7s)
   ✓ steward:    4 findings, conditional (31.5s)
   ✓ pragmatist: 4 findings, approve      (29.1s)
⏳ round 2: 4 reviewers cross-examining...
   ✓ auditor:    2 validated, 1 challenged, 0 added
   ✓ adversary:  4 validated, 0 challenged, 1 added
   ✓ steward:    3 validated, 0 challenged, 0 added
   ✓ pragmatist: 1 validated, 2 challenged, 0 added
⏳ synthesizing...

# Adversarial Code Review

**Verdict:** SHIP-WITH-CAVEATS (3/4 ship, 1/4 block)
**Findings:** 3 critical · 5 warning · 1 info
**Open blocking:** 2 (cross-validated or consensus, not advisory, not info)

## Cross-validated findings (multiple reviewers reported independently)
### 🔴 [CRITICAL·defect] SQL injection in query builder — db.py:22
…

## Advisory (design — recorded, never blocking)
### 🔵 [INFO·design] Wrapper with a single caller — adapters/base.py
…
```

## Two ways to run it

### As a CLI

Wraps any coding-agent CLI that reads stdin and writes stdout — Claude Code, Codex CLI, Gemini, Aider, Ollama. Good when you want to gate CI, run from a Makefile, or use a non-Anthropic model.

```bash
npm install -g adverse
# or run directly without installing:
npx adverse review ./src
```

### As a Claude Code Skill

The skill is in [`skills/adverse-review/`](skills/adverse-review/). One-liner install via [skills.sh](https://skills.sh/):

```bash
npx skills add kfox/adverse
```

That clones the repo, locates `skills/adverse-review/`, and installs it to `~/.claude/skills/adverse-review/` (or `.claude/skills/` with `--project`). Re-run to update. If you'd rather pin the exact subpath, `npx skills add https://github.com/kfox/adverse/tree/main/skills/adverse-review` works too. Or do it by hand:

```bash
git clone https://github.com/kfox/adverse.git ~/.adverse-source
mkdir -p ~/.claude/skills
ln -s ~/.adverse-source/skills/adverse-review ~/.claude/skills/adverse-review
```

Inside Claude Code, ask for "adversarial review", "adverse review of these changes", or "review my changes from multiple angles" — or hit `/adverse-review`. The skill handles scope detection (uncommitted changes vs branch diff vs full tree), spawns reviewer subagents in parallel via Claude Code's native Agent tool (no nested-auth issues, no subprocess overhead), runs triage and the cross-review round, and calls small Node helpers for every deterministic step. Needs `node` ≥ 22 on PATH; no `npm install`.

Ask for "review until clean" (or "keep going until it's done") to get the convergence loop instead of a single pass.

Both modes share the same `src/` core, so a finding the CLI flags is the same finding the Skill flags. The Skill additionally triages before round 2, skips lanes that cannot contribute, and can iterate; the CLI does one pass with every persona.

## Why this design

The naive way to do "AI code review" is one model, one shot. You get one perspective with all the blind spots that perspective has.

The next step up is what some prior projects did: two **different** models (Claude + GPT Codex), so each catches what the other misses. This works but it's expensive, slow, requires two API keys, and ties you to whichever two providers the script knows about.

`adverse` does the third thing: one model, several **personas**, with explicit cross-examination between them. The personas are designed to be orthogonal — the Auditor catches logic bugs the Adversary won't go looking for; the Adversary names attack chains the Auditor won't think about; the Steward notices the docstring that stopped being true; the Pragmatist sees the design problem the rest ignore. Then in round 2 each persona has to go on record about the others' findings — validate or challenge — so the synthesizer can tell you which findings have multi-perspective support and which are one reviewer's hunch.

Trade-off, named honestly: a single model running several personas has anchoring bias that two separate models don't. The cross-review round mitigates this (each persona must defend a position visible to the others), and the personas themselves are written with explicit "stay in your lane / do not duplicate the others" instructions. But if you genuinely need decorrelated outputs across the model boundary, run `adverse` twice with different agents and diff the reports.

## Install

```bash
# global install (gives you the `adverse` binary on PATH)
npm install -g adverse

# or one-shot
npx adverse review ./src
```

Requires Node.js 20+. Zero runtime dependencies.

## CLI usage

```bash
# Default: review the current directory using `claude -p`.
adverse review

# Specific path with a specific agent.
adverse review ./src --agent "claude -p"
adverse review ./src --agent "codex exec --quiet"
adverse review ./src --agent "gemini"
adverse review ./src --agent "ollama run llama3.1"

# Review only the changes on this branch.
adverse review --diff main

# Review uncommitted changes.
adverse review --diff

# Save the report to a file (markdown, JSON, and self-contained HTML).
adverse review --out review.md --json-out review.json --html-out review.html

# Skip cross-review (faster, less rigorous).
adverse review --single-round

# Run a different subset of personas.
adverse review --personas auditor,adversary,steward

# See what came back from each agent (for debugging).
adverse review --save-artifacts ./.adverse-debug --verbose
```

The `--agent` flag accepts any command that reads a prompt from stdin and writes a response to stdout. Adverse handles the common output shapes — plain text, fenced JSON, Claude's `{"result": "..."}` wrapper, Anthropic content-block format — and retries once with feedback if the agent's first response doesn't parse.

### Environment variables

| Variable | Effect |
|---|---|
| `ADVERSE_AGENT` | Default for `--agent` (e.g. `export ADVERSE_AGENT="codex exec --quiet"`). |
| `ADVERSE_LIVE`  | Set to `1` to run the live-Claude integration tests. |

### Exit codes

| Code | Meaning |
|---|---|
| 0 | Review completed; verdict was approve, conditional, or hold |
| 1 | Review completed; verdict was reject |
| 2 | Bad arguments (target missing, unknown persona, etc.) |
| 3 | Fewer than 2 reviewers produced valid output — synthesis aborted |

Code 1 is what you wire into a CI gate.

### `synthesize` subcommand

Standalone: turn round-1/round-2 JSON from any source into a report.
`--skipped`, `--degraded`, and `--round2-skipped` — for declaring lanes that
did not run, and why — are flags on `adverse synthesize` itself, and `--plan`
reconciles those declarations against the run the plan describes: a planned
lane no payload or declaration accounts for is refused. The Claude
Code Skill reaches the same logic, and the same flags, through a bridge script
(`skills/adverse-review/scripts/synthesize.mjs`) that is a pass-through.

```bash
adverse synthesize \
    --round1 round1-combined.json \
    --round2 round2-combined.json \
    --briefing briefing.json \
    --out report.md \
    --html-out report.html
```

`--briefing` is optional and carries the candidate root causes triage
proposed. Without it the report is one section per finding.

## The personas

| Persona      | Lens                                     |
|------------- |------------------------------------------|
| **Auditor**    | Correctness, logic, and algorithmic soundness — does this code compute the right answer? |
| **Adversary**  | Security, abuse, trust boundaries — what can a hostile caller do? |
| **Steward**    | Contracts — what does this code *say* about itself, and is that still true? |
| **Pragmatist** | Shape — structure, coupling, complexity. **Advisory: never blocks.** |

`adverse personas` prints them at runtime. Each persona's full system prompt is in [`src/personas.mjs`](src/personas.mjs); they're written with explicit "what's in scope / what's out of scope" rules so they don't duplicate each other's work.

The **Steward** is this fork's addition, and it exists because code-versus-claim drift had no owner. It sat as one bullet in the Auditor's scope list and one in the Pragmatist's, each told to stay out of the other's lane, and neither was ever instructed to open the docs. Its lens makes documentation and tests one job rather than two: a docstring is a prose claim about the code, a test is an executable claim about the code, and both go stale the same way. Its findings must name *both* sides — the code in `file`, the thing it contradicts in `counterpart` — so "the docs should be updated" is triaged away as the chore it is.

**Adding a persona means editing every other persona's exclusion list**, in the same change. Two lanes that both believe they own some ground will each report the same issue, and two independent-looking reports of one issue is exactly what synthesis reads as cross-validated consensus — counterfeiting the strongest signal the design has. [`tests/personas.test.mjs`](tests/personas.test.mjs) checks the set as a set: every kind owned, the advisory kind owned exactly once, every persona handing off to every other by name. That last check failed the first time it ran.

## How it works

```
┌──────────────────────────────────────────────────────────────────────┐
│  Round 1 — Independent Reviews                    (parallel calls)  │
│  Each persona reviews the code with only its own lens.              │
│  Output: { verdict, summary, findings[] }, each finding typed       │
├──────────────────────────────────────────────────────────────────────┤
│  Triage — Deterministic                                 (no LLM)    │
│  Stable IDs · claim-check every cited file and line · flag          │
│  under-anchored findings · cluster likely-duplicate reports ·       │
│  aggregate co-cited findings into candidate root causes             │
├──────────────────────────────────────────────────────────────────────┤
│  Round 2 — Cross-Review                           (parallel calls)  │
│  Each persona sees every round-1 finding, triaged, and:             │
│    • validates findings it agrees with                              │
│    • challenges findings it thinks are wrong / overstated           │
│    • adds new findings the other angles surfaced                    │
│    • rules each candidate root cause one thing, or several          │
├──────────────────────────────────────────────────────────────────────┤
│  Synthesis — Deterministic                              (no LLM)    │
│  Merge findings, score consensus, render report:                    │
│    cross-validated → reported by ≥2 personas                        │
│    consensus       → reported by 1, validated by another            │
│    disputed        → reported by 1, challenged by another           │
│    solo            → reported by 1, no cross-talk                   │
│  Report leads with the confirmed root causes and their citations    │
└──────────────────────────────────────────────────────────────────────┘
```

Every step that is not a review is **deterministic Node code**, not another LLM call. A model in any of those positions can hallucinate consensus, and consensus is the product. Counting validate / challenge edges is enough.

Per review: the CLI runs 8 invocations (4 round-1 + 4 round-2); `--single-round` halves it. The Skill runs 7 for the full shape, and its Phase 1 plan (`plan.mjs`) scales that in both directions: a small boundary-free diff whose every changed line fits the scope gate's widest bounded span runs 2 round-1 calls (Auditor + Steward) and, when round 1 reports nothing blocking, no round 2 — a floor of 2, and reachable only under that span condition, because a changed line longer than 200 characters is unreadable-therefore-evidence and runs the Adversary (34 lines of this README are past that, including this one) — while a large diff splits the Auditor and Adversary lanes across two agents each and runs round 2 per agent rather than per persona, up to 11. The Pragmatist always skips round 2 (nothing advisory can block, so cross-validating it buys nothing). Wall time is roughly twice the slowest single invocation, since personas run in parallel within each round.

## What this fork adds

### Findings are classified by kind, not just severity

Severity says how bad a finding is. It cannot say what would *settle* it, and that is the question a repeatable review has to answer.

| Kind | Settled by | Blocks? |
|---|---|---|
| `defect` | reading the cited line | yes |
| `behavioral` | executing it, or an argument about execution | yes |
| `contract` | opening both files and comparing | **no** |
| `design` | nothing — it is an opinion about shape | **no** |

`design` and `contract` are advisory by construction, for the same reason from two directions. Design opinions do not converge: a reviewer can always want different structure, and such a finding is legitimately a `warning`, so any loop that counts them never terminates. Contract findings never run out: every sentence of prose is a checkable claim, so each fix's own comments and docs replenish the supply. Both are reported and ranked under their own heading, and handed over as a backlog rather than a gate.

An unclassified or unrecognized kind **blocks**. Defaulting the other way would let a real finding escape the gate by arriving mislabeled.

### Co-cited findings are aggregated into root causes, with the citations kept

Four lanes looking at one defect report it four times — as a correctness bug, as an attack, as a stale contract, as a design smell. Triage already saw the relationship: in the run that motivated this, it reported **95 co-citation edges across 34 findings**. It just never closed it. So each finding was remediated, decided, and ledgered on its own, the fixer re-derived the shared cause by hand every time, and the report read as three times the actual defect count.

[`groupFindings`](src/triage.mjs) takes the transitive closure of the cluster and co-citation edges and proposes one **candidate root cause** per connected component: a canonical statement plus every member as a citation that keeps its own reporter, kind, severity and anchor. Round 2 then rules `one` or `split` on each. A confirmed group is one fix and one disposition; the report leads with it, and the ledger records it so a later pass can say "the root-cause fix did not close every symptom" rather than the much weaker "a fix did not take".

Three things it deliberately refuses to do, because aggregation is exactly where a review tool can lie to itself:

- **It does not vote.** Confidence is still counted over distinct personas per finding. A group is a way to fix and decide several citations at once, never an extra voice — and two independent-looking reports of one issue is precisely what synthesis reads as cross-validated consensus, the signal the whole design trusts most and the easiest to counterfeit.
- **It does not decide.** The deterministic side proposes; only a reviewer that read the code can say whether two findings are one. An unruled or contested group stays a candidate and its citations are decided one at a time, which is the behavior that predates grouping — so a missing ruling costs the speedup and never a finding.
- **It does not collapse without limit.** Transitivity is greedy, and this is where the first version of the feature failed outright: on the 34-finding run it was built for, an unbounded edge predicate produced 95 edges whose closure was a single 29-member "root cause" spanning 10 files and all four lanes — not a root cause, the review. So the closure itself is bounded, not just its result. Co-citation edges are cross-file (or same-file with the other finding's line actually cited), match whole path tokens, only target a file the claim-checker opened, and are capped in both directions — how many one finding may emit, and how many may point at it. Proximity edges are bounded too: a cluster may not span more than its own window, and neither edge kind may merge a component past the confirmable cap. A refused edge is still reported — it just does not collapse two findings into one disposition. Where a group is legitimately large anyway, it is marked `oversized` and refused as a decision unit however round 2 rules it.

Grouping helps most where a handful of findings are tightly co-cited across two or three files. A dense, self-referential review — reviewers whose prose names half the tree — produces few groups and falls back to per-finding decisions, which is the pre-grouping behavior and costs nothing but the speedup.

### The Skill can run as a convergence loop

Review → fix → verify → repeat, stopping when **no blocking finding is left unsettled** — where settled means a decision was recorded on it, not that a reviewer felt good about it. Credibility (cross-validated or consensus) and cross-examination sort the remaining findings into what the loop *calls* them; they no longer decide whether it stops. That distinction is the fix for three separate leaks, each the same shape: a blocking finding that matched none of the categories the stop condition enumerated, and so converged the loop by being unclassifiable. Solo findings were dropped by the credibility gate; then a report-wide cross-examination flag disarmed the gate that replaced it; then a critical two reviewers found and one challenged fell between the two. Deriving the stop from what is unsettled — and reporting a bucket for anything unrecognized — closes the shape rather than the instance. Three pieces make that work, none of which puts a model in the loop:

**A position tracer** ([`src/trace.mjs`](src/trace.mjs)). Between iterations the fix itself shifts every line below it, so `file:line` cannot answer "is F3 still open?". The approach is GitLab's, halved: their diff comments are addressed by a line code of `SHA1(path)` plus old and new line ([gitlab-foss!7298](https://gitlab.com/gitlab-org/gitlab-foss/-/merge_requests/7298)), which bakes position into identity — which is why their notes go "outdated" and why `PositionTracer` had to be built afterward. Keep the split between file identity and line position; drop the hash, which exists to be a DOM id and in a JSON ledger only makes the file unreadable. Hunk arithmetic over `git diff -U0` gives `touched` and `untouched`; the surrounding trace adds `unanchored`, `not-file-bound`, `file-only`, `file-gone`, `past-eof`, and `trace-failed`. The last two are split out on purpose: a projection that runs off the end of a file, and a git that could not answer at all, both used to be reported as `file-gone` — which reads as "the file was deleted", which reads as evidence of a fix.

`untouched` annotates the verifier's question and never answers it. Reviewers cite where a problem *shows*, which is routinely not where it gets *fixed*.

**An adjudication ledger** ([`src/ledger.mjs`](src/ledger.mjs)) — a decision log, not a suppression list, and the asymmetry is the whole design:

- `declined` / `deferred` **settle** a question. A later pass is told the decision and its reason and told not to re-open it. This is what makes the loop terminate rather than circle.
- `noted` settles **nothing**. It is the disposition for an item a fix agent named but did not fix — a footnote the handoff would otherwise drop. It carries that agent's reasoning into the next briefing so nobody re-derives it, and adjudicates no finding: nobody triaged it, and the agent that wrote it was told deferring is not its call. Recording it `deferred` instead let a fix agent close a blocking critical by copying its title into a footnote, which is exactly what the fix prompt tells the agent to do.
- `fixed` settles **nothing**. A finding recorded fixed that comes back means the fix did not work — the most valuable thing a re-review can report. It is surfaced louder than a new finding and still holds the loop open. Suppressing it is the natural-looking optimization that would quietly turn this into a machine for declaring victory.

**A stop condition** ([`converge.mjs`](skills/adverse-review/scripts/converge.mjs)) — arithmetic on data the panel already produced, capped at 3 iterations — 5 when round 1 reported a critical finding of a blocking kind (`plan.mjs --escalate`). The cap exits `3`, not `0`: a capped run has open findings and has to say so, or the loop's promise is a lie told by an exit code.

The verification pass is not a re-review. It asks two questions — is this finding closed, and *did closing it break something new* — and the second half is not politeness. A fix written under pressure to close a finding is unreviewed code, written by whoever was most convinced the finding was real. A pass that only ever confirmed closures would launder new defects into the tree one iteration at a time.

## Tests

```bash
npm test                       # unit + contract tests, no API calls. Fast (~5s).
npm run test:live              # Live tests against `claude -p`. Requires `claude` on
                               # PATH and auth — won't pass from inside a nested Claude
                               # Code session because subprocesses don't inherit auth.
```

Coverage includes JSON-extraction across every wrapper shape Claude Code can produce (`{"result": ...}`, content-block, plain-string, fenced markdown, banner-then-JSON, raw), validator and synthesis logic, source collection, retry behavior, full CLI subprocess flow. Contract tests in [`tests/fixtures/claude-cli/`](tests/fixtures/claude-cli/) pin the wrapper shapes — drop a new file in there when Claude ships a CLI change and the suite picks it up automatically.

This fork adds suites for the deterministic layers, which is where a wrong answer is invisible downstream: triage and tracing run against throwaway git repositories, since half their answers come from `git diff`. Fixture repos run with `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_SYSTEM` pointed at `/dev/null`, so they cannot inherit signing, templates, or hooks from whoever is running the suite.

One test is load-bearing rather than incidental: [`tests/prompts.test.mjs`](tests/prompts.test.mjs) fails the build when `skills/adverse-review/scripts/prompts/*.txt` or `skills/adverse-review/agents/*.md` drift from the generators in `src/`. Nothing at runtime would notice the CLI and the Skill running two different reviews.

## Project layout

```
src/                          # Shared core, used by both CLI and Skill
  personas.mjs                # Four persona system prompts + the lane partition
  taxonomy.mjs                # The kind axis + severity rank, shared with no prompt prose
  prompts.mjs                 # Round-1/2/verify/fix/regression prompts, validators
  parse.mjs                   # JSON extraction across every wrapper shape
  collect.mjs                 # Directory walk + git-diff source collection
  runner.mjs                  # Subprocess agent invocation + parallel orchestration
  synthesis.mjs               # Deterministic merge + markdown rendering
  trace.mjs                   # Re-project a finding's anchor across commits
  triage.mjs                  # Claim/kind checks, clustering, root-cause grouping
  briefing.mjs                # Assembles those into the round-2 prompt
  ledger.mjs                  # Adjudication log + the convergence stop condition
  decisions.mjs               # Fold fix-agent payloads into ledger decisions
  scope.mjs                   # Does this change have a trust boundary in it?
  regression.mjs              # Which lane asks what else a fix commit changed
  scaling.mjs                 # How much review does this change deserve? + reading a plan back
  roster.mjs                  # Who counts as a reviewer: personas, split lanes, silent lanes
  html.mjs                    # Self-contained HTML dashboard renderer
  cli.mjs                     # Argv parsing + command dispatch
  fsSafe.mjs                  # Open-and-check without a TOCTOU gap
  entryGuard.mjs              # Nothing here is runnable: `node src/x.mjs` refuses, exit 2

bin/
  adverse.mjs                 # CLI entrypoint (#!/usr/bin/env node)

skills/adverse-review/
  SKILL.md                    # Claude Code playbook (the "code" of the Skill)
  scripts/
    bridge-io.mjs             # Shared bridge helpers: readJson, usage, write and roster guards
    collect.mjs               # Skill bridge: source collection
    combine.mjs               # Skill bridge: combine per-persona JSON
    triage.mjs                # Skill bridge: claim/kind checks, grouping, briefing
    validate.mjs              # Skill bridge: schema-check an agent-written round1/round2/verify/fix/regression payload
    repair.mjs                # Skill bridge: restore canonical titles by finding ID
    synthesize.mjs            # Skill bridge: deterministic synthesis
    plan.mjs                  # Skill bridge: which lanes, how many agents, rounds, cap
    converge.mjs              # Skill bridge: record decisions, decide whether to stop
    verify.mjs                # Skill bridge: validate a verify payload, reshape for triage
    regression.mjs            # Skill bridge: pick the lane for a fix commit's regression pass, fold what it found
    decisions.mjs             # Skill bridge: fold fix payloads into decisions.json
    dump-prompts.mjs          # Regenerate prompt files from src/ (a test enforces it)
    prompts/                  # Generated — edit src/, then re-run dump-prompts.mjs
      auditor.txt, adversary.txt, steward.txt, pragmatist.txt
      round1.txt, round2.txt, verify.txt, fix.txt, regression.txt
  agents/                     # Generated — subagent definitions, one per persona
      auditor.md, adversary.md, steward.md, pragmatist.md

tests/
  *.test.mjs                  # node --test, no Jest/Mocha
  fixtures/claude-cli/        # Pinned `claude -p` output shapes (contract tests)
  fixtures/fake-agent.mjs     # Stub agent for end-to-end CLI tests
```

## Limitations

- **Single-model anchoring bias.** Honest answer: a single model running four personas correlates more than four independent models would. Cross-review round mitigates; running adverse twice with different agents decorrelates. Don't pretend this is the same thing as two-provider review.
- **Source size cap.** Default 250 KB total / 30 KB per file. Trips on very large repos in non-diff mode. Use `--diff` for review-on-PR workflows where the change set is what matters.
- **Subprocess agent contract.** The CLI assumes the agent reads prompt from stdin and writes the response to stdout, exiting cleanly. Most coding agents support this; some need a flag (`-p` for Claude Code, `exec` for Codex CLI). When in doubt, run the agent manually with a stdin prompt first to confirm the shape.
- **Not a fix-applier — mostly.** The CLI produces a report and stops; hand it to your coding agent if you want fixes applied. The Skill's convergence loop *does* apply fixes, but only when the user asks for that shape, and it records a reason for every finding it declines as well as every one it fixes.
- **The review plan is a budget policy, not a judgment.** The scope gate decides whether the Adversary lane has anything to look at by pattern-matching changed paths plus added and removed lines — and by length, with no pattern involved: several of its patterns read a bounded span (200 characters) to stay linear on bytes a PR author picks, so any changed line longer than that span is treated as unreadable-therefore-evidence and runs the lane. That is reported as its own reason, never as a trust-boundary signal; the scaling policy sizes the rest — lanes, agents per lane, rounds, and the iteration cap — from the diff and from what round 1 found. Neither can know that an innocuous-looking helper is called from an auth path, so both are biased toward more review (pins force the full panel on paths a repo names), and a skipped lane is always named in the report — an unmentioned one reads exactly like a lane that looked and found nothing.
- **`design` and `contract` findings never gate.** That is deliberate, but it means the loop can converge with real design feedback and real documentation drift outstanding. Both are reported as a backlog; someone still has to read it.

## License and credit

MIT.

Originally written by [Addy Osmani](https://github.com/addyosmani) ([addyosmani/adverse](https://github.com/addyosmani/adverse)); the copyright notice in [LICENSE](LICENSE) is his and stays that way. This fork has diverged substantially, so **issues and questions belong here, not upstream** — please do not route them to Addy.
