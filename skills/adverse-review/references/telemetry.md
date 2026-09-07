# Run telemetry — `runs.jsonl`

Every synthesis appends one JSON line of **counts** to

```
${ADVERSE_TELEMETRY_FILE:-${XDG_CACHE_HOME:-~/.cache}/adverse/runs.jsonl}
```

One file per machine, covering every repository — not one file per checkout.
The questions this exists to answer are questions about many runs across many
projects ("at what diff size does a lane actually start failing?"), a per-repo
file answers them only for the repo you happen to be standing in, and it
disappears with the clone. The repository is a **field** on each line instead,
taken from the origin remote's `owner/name`.

It sits beside the per-branch ledgers, and for the same reason: the run
directory is scratch and evaporates.

## Why it exists

The ledger records *decisions* — per finding, per branch. Nothing recorded the
run's own arithmetic, so every rule in `src/scaling.mjs` (the Pragmatist skip on
a small diff, the two-agent split on a large one, the escalated iteration cap)
rests on a single remembered incident. This file is how those rules become
arguable from data (kfox/adverse#72).

## What it never contains

Counts, ids, statuses, and the vocabulary the tool itself defines. **No prose:**
no finding titles, no details, no fixes, no reviewer summaries, no skip reasons,
no plan reasons, no file paths — a pinned path is counted, never quoted. The
file has to stay something you can paste into an issue while arguing about a
threshold. `tests/telemetry.test.mjs` builds a record from payloads whose every
string field is a sentinel and asserts that none of them survives, so this is a
test rather than a promise.

## Turning it off

- `--no-telemetry` on `adverse review` or `adverse synthesize`.
- `ADVERSE_NO_TELEMETRY=<anything>` in the environment, for when you do not
  control the invocation. `npm test` sets it for the whole suite, so a test run
  never appends to your real file.
- `ADVERSE_TELEMETRY_FILE=<path>` writes somewhere else. The append refuses to
  follow a symlink at the destination, so this is also how you point the file at
  another location deliberately.

A run whose line cannot be written still publishes its report and still exits on
its verdict — one warning goes to stderr. This is the one place in the flow that
fails open: it is an observation *of* a review, not a claim *about* one, and
bookkeeping must never gate a merge decision.

## The record

| Field | Meaning |
|---|---|
| `schema` | Bumped when a field changes meaning, never when one is added. |
| `at` | ISO timestamp of the synthesis. |
| `repo` | `owner/name` from the origin remote; a local-path remote gives its basename; `null` outside a repository. |
| `head` | HEAD sha at synthesis time. |
| `base` | The base the briefing pinned, when `--briefing` was passed. |
| `iteration` | Convergence-loop pass number, from `--iteration`; `null` for a single pass. |
| `plan` | `bucket`, `files`, `changedLines`, `deletedLines`, `measured`, `pinned` (a count), `rounds`, `maxIterations`, and `agents` — agents per lane, `0` for a lane the plan ruled out. `null` without `--plan`. |
| `roster` | `reported`, `degraded`, `skipped`, `crossReviewed` (persona lists) and `round2Skipped` (a boolean). |
| `lanes.<persona>` | `status` (`reported` / `degraded` / `skipped` / `silent`), `reported` (findings, `null` if the lane did not look), `disproved` and `underAnchored` (`null` without a briefing). |
| `triage` | Totals from the briefing: `findings`, `disproved`, `underAnchored`, `outside`, `clusters`, `crossReferences`, `groupsProposed`, `settled`, `regressed`. `null` without `--briefing`. |
| `findings` | `total`, `blocking`, `openBlocking`, and tallies `bySeverity`, `byKind`, `byConfidence`, `byProvenance`. |
| `rootCauses` | `total` and `byStatus` (`confirmed` / `split` / `contested` / `oversized` / `proposed`). |
| `round2` | `personas`, `validated`, `challenged`, `added`. `null` when round 2 did not run. |
| `verdict` | `label` and `score`. |

**`null` is not `0`.** A lane that was skipped or that failed records `null`
findings, because "it did not look" and "it looked and found nothing" are
different facts and collapsing them is the failure the roster accounting exists
to prevent. The same rule applies to every field a run without `--briefing`
could not observe.

## Reading it

```bash
RUNS=${XDG_CACHE_HOME:-$HOME/.cache}/adverse/runs.jsonl

# Does the Pragmatist skip cost anything? Its round-1 findings, when it ran.
jq -s '[.[] | select(.lanes.pragmatist.status == "reported")
        | .lanes.pragmatist.reported] | add' "$RUNS"

# Lane failure against diff size: does the two-agent split earn its keep?
jq -s 'group_by(.plan.bucket)[]
       | {bucket: .[0].plan.bucket, runs: length,
          degraded: [.[] | .roster.degraded | length] | add}' "$RUNS"

# Anchor quality per persona: the reviewer-hallucination gauge.
jq -s '[.[] | select(.triage != null) | .lanes | to_entries[]
        | select(.value.disproved != null)]
       | group_by(.key)[]
       | {persona: .[0].key,
          reported: ([.[] | .value.reported] | add),
          disproved: ([.[] | .value.disproved] | add)}' "$RUNS"

# What round 2 is actually for: findings round 1 missed.
jq -s '[.[] | select(.round2 != null) | .round2.added] | add' "$RUNS"

# How often does a run hit the cap instead of converging?
jq -s '[.[] | select(.iteration != null)]
       | group_by(.repo + ":" + .base)[]
       | {run: .[0].base, passes: length, cap: .[0].plan.maxIterations}' "$RUNS"
```
