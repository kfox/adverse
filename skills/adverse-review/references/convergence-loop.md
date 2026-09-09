# The convergence loop

The default run is SKILL.md's single pass: Phases 0–7, then hand over. This
document is everything the loop adds on top when the user asks for "until
clean". Read it end to end before running one — the loop's failure modes are
all shapes of manufacturing its own work, and every rule here was paid for.

## The stop condition

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

## Phase 0 addendum — the ledger

**Start the ledger before Phase 1.** It is just a path; the first
`--record` creates it.

```bash
# NOT inside $ADVERSE_RUN. The run directory is session-scoped scratch; the
# ledger has to outlive it, because a later pass on the same branch is exactly
# the thing that must start from these conclusions.
LEDGER_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/adverse"
mkdir -p "$LEDGER_DIR"
LEDGER="$LEDGER_DIR/$(git rev-parse --abbrev-ref HEAD | tr / -).ledger.json"
```

## Phase 4 addendum — the iteration cap

Phase 4's re-plan also emits `$CAP`, and one more dial moves:

- **The cap rises to 5** when round 1 holds a critical finding of a blocking
  kind. It never drops below 3: lowering the cap can only manufacture false
  exit-3 stops, raising it only costs model calls. `$CAP` carries it to
  `converge.mjs --max-iterations` in Phase 8.

## Phase 7 addendum — record every decision

In the loop you already have authority to fix. Work through the
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

It is also the only place the reporting lanes are on record. `--record` reads
the report's findings and writes the lanes that filed each one onto the decision
it answers, which is what lets Phase 9 derive the pass's exclusion list instead
of asking you — the party that wrote the commit — to name it. Omit `--report`
and every fix commit in the iteration is recorded unable to say who must not
review it, and `--closed-by-ledger` refuses rather than deriving from half an
answer.

`decisions.json` is `{"decisions": [{id, title, kind, severity, confidence,
file, line, counterpart, citedLine, disposition, reason, agent, commit}]}` where
`disposition` is `fixed`, `declined`, `deferred`, or `noted`. `agent` is the fix
batch that decided it and `commit` is the one commit that closed it — `fixed`
only, since nothing else closes anything, and a `commit` on any other
disposition is refused. **There is no `reporters` field to write.** The lanes
that reported each finding are derived from `--report` when the decision is
recorded; a `reporters` you supply is refused rather than ignored, because that
is the field Phase 9 excuses a lane on and it must not come from whoever wrote
the decision. Only `declined` and `deferred`
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

**A decision that matches nothing is recorded and named.** With `--report`
given, `--record` checks each decision against the report's findings and the
ledger's own entries, and **exits 1** — after writing — listing any that match
neither, with what the report disagrees with each one about. This is the check
for a failure that has no other symptom: a decision whose identity fields are
subtly wrong is recorded, counted on the summary line, and settles nothing, so
the finding it honestly decided is re-raised from scratch next iteration or
holds the loop open until the cap.

Exit 1 here is **not** a refusal. The batch is in the ledger and the counter has
advanced, for the reason spelled out under Phase 8: a branch that does not
record makes the cap unreachable and the loop non-terminating. Three ordinary
things legitimately match no report finding — a `noted` item decided in a later
iteration, a root-cause citation synthesis could not resolve, and any decision
recorded without `--report`. Only the first is exempted, by the ledger check;
the second is listed like any other, and the third is not checked at all
because there is no report to check it against. This paragraph used to promise
an exemption for the root-cause one that no code has ever granted.

**The exemption is not granted by every `noted` entry.** One the fold checked
against `report.json` and could not bind excuses nothing: its title, kind and
file came from the fix payload and nothing corrected them, so honoring it would
let a batch mint in one iteration the token that excuses its own decision in
the next. Such a decision is listed with its own sentence, saying that is what
happened. A `noted` entry the report DID carry still excuses the decision that
answers it — the report chose its fields — and so does one from a hand-written
`decisions.json`, which makes no reconciliation claim at all.

The fix is upstream: pass `--report` to `decisions.mjs` and it corrects the
fields off `report.json` before they ever reach a decision. A hand-written
decision has to be corrected by hand and re-recorded as a second entry, which
the ledger is designed for — entries are appended, never rewritten.

**A `fixed` whose commit does not support it is named too.** `fixed` is the one
disposition that asserts a code change, and `--record` now asks git whether the
commit that decision names contains one. This check needs no `--report` — it
reads a commit, not a panel's output — so it runs on every `--record`,
including the degraded ones. Only the first row is silent:

| the commit… | |
|---|---|
| touches the file the decision cites | supported; nothing is printed |
| touches only other files | named, and told this is often right |
| changes no file at all | named; an empty commit closes nothing |
| cannot be read (a merge, or git failing) | named as unread, never as empty |
| resolves to no commit here | **refused**: nothing is recorded, exit 2 — see below |
| is not named at all | named; nothing records what change was made |

A decision may spell that commit `commit` (as the schema above documents) or
`fixCommit`; both are read.

Every row but the refused one is a line in one block, `FIX NOT SUPPORTED BY ITS
COMMIT`, printed beside the one above and exiting 1 the same way — recorded,
named, not refused. A fix landing in another file is **not** an accusation: a
root cause rarely sits where the symptom was reported, and the block exists to
make you say which case it is in the decision's `reason`. What it catches is the fix that was never made, whose
only other symptom arrives an iteration later as `REGRESSED` — which sends
whoever reads it looking for a fix that broke rather than one that is missing.

A merge is reported as unreadable rather than as empty on purpose. `git show
--name-only` lists nothing for a merge unless told which parent to read it
against, so "no files" there means "not known", and spelling not-knowing as
knowing-the-fix-is-absent would accuse real work of being invented.

**A ledger this tool would refuse to read is never written.** Before it saves,
`--record` puts the prospective ledger through the same `checkBinding` that
gates every run at startup. If it would be refused, `--record` prints
`REFUSING TO RECORD`, exits **2**, and writes **nothing** — the one check on
this path that refuses rather than recording. Four inputs reach it, none of
which needs anything to go wrong on purpose:

| input | what it does |
|---|---|
| a `fixCommit` that resolves nowhere | an amend, a squash before merge, an abbreviated sha that stopped being unique |
| `--at` that is not a commit here | lands on every entry in the batch |
| `--base` that is not a commit here | lands on the ledger itself |
| a batch carrying the ledger past 1000 entries | the entry cap `checkBinding` enforces |

This is the one place the record-anyway doctrine is inverted, and deliberately.
Everywhere else, refusing a write would freeze the iteration counter, because
only `--record` advances it. Here **recording** is what freezes it: the ledger
is append-only and this tool has no repair mode, so a ledger that fails
`checkBinding` is refused by every later invocation — status and `--record`
alike, at exit 2, before either does anything — and nothing can take it back.
Refusing writes nothing, so you correct one sha in `decisions.json` (a
per-iteration file this page already tells you to correct by hand) or one
argument, record again, and *that* record advances the counter.

**`decisions.json` must be a decisions document.** `--record` takes either
`{"decisions": [...]}` or a bare array; anything else — a file holding the
literal `null`, an object with no `decisions` array, a `report.json` passed by
mistake — is refused at exit 2 with nothing written. An empty batch is
`{"decisions": []}` and is recorded like any other, which is what makes the two
worth telling apart: "I could not find the decisions" must not be spelled the
way "there were none" is.

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

## Fixing inside the loop

Three rules join SKILL.md's fixing doctrine when the loop is running.

**Fix the instance, not the class.** A fix that needs a new named concept — an
enum, a dispatch table, a predicate, a classification — has more states than
the instance it fixes, and the uncovered states are where the next iteration's
findings live. The campaign that produced this document watched that for four
iterations: every blocking finding on a fix landed on something the fix had
introduced. Closing the class is the right instinct for maintained code and
the wrong one under review pressure, because the loop re-reviews everything a
fix adds. When a finding genuinely needs an abstraction, record it `declined`
with that reason and file an issue for the class; the loop is not the place to
build it.

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

Then check what landed and fold it, the same way round 1 is checked:

```bash
node ${SKILL_DIR}/scripts/validate.mjs --phase fix "$ADVERSE_RUN"/*/fix-*.json

node ${SKILL_DIR}/scripts/decisions.mjs --fix "$ADVERSE_RUN"/*/fix-*.json \
    --report "$ADVERSE_RUN"/report.json --out "$ADVERSE_RUN"/decisions.json
```

`decisions.mjs` folds every payload of this iteration into the `decisions.json`
the `--record` command above reads — `fixed` and `declined` become decisions of
those dispositions carrying the identity fields the payload already holds, so
you never reassemble them by hand. Fold the whole iteration in one call.

`--report` is what makes those fields the right ones. A fix agent copies its
briefing entry verbatim, as `fix.txt` tells it to, and **the briefing is
per-lane while the report is merged**: when two lanes report one title — the
cross-validated case — synthesis promotes `kind`, `file`, `line` and
`counterpart` from whichever lane supplied them, so the briefed entry can read
`design` with no file where the report reads `defect` at `src/auth.py:88`. The
ledger has to carry the report's copy, because a merged report is what every
later pass matches against; without `--report` the decision matches nothing,
settles nothing, and `converge.mjs --record --report` records it and names it
at exit 1. Every field it corrects is printed, so the rewrite can be read back
against the payload it came from.

**An item a fix agent names but does not fix is a finding with no ID.** It is
not in `report.json`, `--record` has nowhere to put it, and it exists only in
the agent's final report — which you read once and then lose. The measured cost
of losing one: an agent reported that a preflight step was not budgeted, under a
heading that said "out of scope, named not fixed"; nothing was recorded, and the
next iteration two independent round-1 reviewers spent a lane-pair's attention
re-deriving it. So the payload carries a `named_not_fixed` list, `decisions.mjs`
mints an id for each entry (`NF-<batch>-<n>`, which cannot collide with triage's
`F<n>`) and records it `noted` with the agent's own reasoning. Its identity
fields are corrected off `report.json` exactly as `fixed` and `declined` are:
`fix.txt` routes an ASSIGNED finding into this list whenever a batch leaves one
for later, so the report often does carry the item, and an identity that
reaches the ledger unchecked is one the coverage check would otherwise have to
take the batch's word for. Each entry records which of the two it was, and the
fold prints the ones the report does not carry under their own heading.
`noted` settles nothing, deliberately: an untriaged footnote annotates the next
briefing and adjudicates no finding. It used to be recorded `deferred`, which
settles — so a fix agent copying a blocking critical's title into
`named_not_fixed`, which
`fix.txt` tells it to do verbatim, closed that critical with no code change and
no warning. Read the block it prints before you record — a channel you forward
without reading is the same footnote in a new place, and **an item that is
`noted` still needs a decision from you.**

**A regression pass per fix commit is recommended, not required** (Phase 9),
run by a lane that did not report the findings it closes. Reach for it when a
commit touched a pinned path, closed a critical, or shipped verification you
could not watch fail; skip it, out loud, for a batch of small well-pinned
fixes. *Out loud* has a flag: the fold refuses a fix commit with neither a pass
nor a `--no-pass` declaration, because a skipped pass reads exactly like a clean
one (see the fold below). `fix.txt` tells the agent the pass may come and names
the four questions it asks — which is what makes the agent's own "What else this
changed" section honest. When it runs, run it per commit, while the diff is
small and its intent is still known.

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
4. the path to write its own JSON object to: `$ADVERSE_RUN/<persona>/verify-<persona>.json`

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

### The regression pass — recommended per fix commit, by a lane that did not report it

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
    --closed-by-ledger "$LEDGER" \
    --json > "$ADVERSE_RUN"/lane-choice-<fix-sha>.json
```

Save the `--json` output: it is the only record of HOW the reviewing lane was
picked and on whose word, and the fold below stamps it onto the pass so the
report can say which. Without it, a pass chosen under `--closed-by-none` is
indistinguishable on disk from one chosen against a named exclusion list.

**Prefer `--closed-by-ledger`.** It asks the ledger which decisions this commit
closed and which lanes reported them, so the list is derived rather than typed
by you, and the pass's `reason` says which of the two it was. It needs the
iteration recorded first — `--record` with `--report`, above — and it refuses
rather than guessing when the ledger cannot answer: a ledger written before
decisions carried a fix commit, or decisions recorded without their report, both
exit 2 naming what to pass instead. A ledger that answers "no decision was
closed by this commit" is a real answer and runs the pass with nothing excluded.

The two typed forms remain, for a commit whose findings were never recorded and
for the escape hatch. `--closed-by` is every persona that reported a finding
this commit closed, spelled the way the registry spells it — lowercase, or a split lane's half like
`auditor-a`. A name this review could not have written is refused at exit 2,
not ignored — and that is a wider rule than "resolves to no lane". Both of
these are refused: `--closed-by Auditor` differs by one capital letter,
excluded nobody, and handed the pass to the lane that reported the finding
under a line asserting it had reported none of them; `--closed-by auditor-ab`
*does* name the auditor lane but is not a half the splitter emits, and one
tightening of that suffix pattern silently moved it from excluding the auditor
to excluding nobody. If the bridge would have to guess at a name, retype it.

**An exclusion input is required, and omitting it is the same failure spelled
shorter.** With no `--closed-by` at all the run used to exit 0 having excluded nobody,
under that same line — a clean artifact claiming a disinterest nothing checked.
If the commit really closes no reported finding, say so with
`--closed-by-none`: the pass then runs with nothing excluded and its `reason`
attributes that to you rather than asserting it. No two of the three forms can
be combined — a commit either closes findings some lane reported or it does not,
and a caller that says two things about it has not decided which.

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
   `$ADVERSE_RUN/<persona>/regression-<persona>-<pass number>.json`

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
node ${SKILL_DIR}/scripts/validate.mjs --phase regression "$ADVERSE_RUN"/*/regression-*.json

node ${SKILL_DIR}/scripts/regression.mjs --payload "$ADVERSE_RUN"/*/regression-*.json \
    --outdir "$ADVERSE_RUN" --choice "$ADVERSE_RUN"/lane-choice-*.json \
    --repo . ${LEDGER:+--ledger "$LEDGER"} ${LEDGER:---no-ledger}
```

`--repo` is unconditional: it is what lets the fold resolve two spellings of
one commit to one identity, for the staleness check and for matching each
lane choice to its pass. Without it the fold falls back to exact string
equality — safe, but a choice recorded under an abbreviated sha then goes
unstamped, and the lane summary reports it unrecorded.

**Pass `--ledger` whenever the run has one, and `--no-ledger` when it does
not.** One of the two, never neither: the fold's own account of which fix
commits anybody looked at runs only under `--ledger`, and the party who decides
whether to pass it is the party whose fix commits it accounts for. Omitting it
turned that whole check off at exit 0 and left nothing in the output to say the
check had not run, which is the same shape as the check itself — a skipped one
reads exactly like a clean one. A ledger-less fold is legitimate (iteration 1
has none yet), so it is the ABSENCE that has to be declared, exactly as
`--closed-by-none` declares an empty exclusion list rather than leaving the flag
off. `--no-ledger` also prints a line saying so, so the declaration reaches
whoever reads the run rather than only whoever typed it.

With `--ledger` the fold annotates any finding
that re-litigates a settled decision with the recorded disposition and reason —
the same `adjudicated` block triage writes — so a pass that proposes reinstating
what an earlier iteration `declined` arrives already labeled. That oscillation
is measured, not hypothetical: a campaign's regression agent, briefed on a
commit alone, re-proposed a fix the ledger had recorded as critical two
iterations earlier, and only the operator's memory caught it.

It also answers *which of this iteration's fix commits anybody looked at*. Every
commit a `fixed` decision recorded must be accounted for, one of two ways — a
pass on record, or a declaration:

```bash
    --no-pass <commit>="four one-line fixes to pinned paths, each with its own test"
```

Neither way is preferred. The pass is recommended, not required, and skipping a
batch of small well-pinned fixes is the documented call. What the fold refuses
is a commit with **neither** — the one state nobody can tell apart from a pass
that ran clean. A declaration is refused without a reason (`--no-pass <sha>`
alone is the same silence in new syntax), refused without `--ledger` (nothing
else names the fix commits), and reported when it matches no fix commit of this
iteration, which is a typo or a stale sha rather than an account of anything —
including when this iteration recorded no fix commit at all, which is the one
state in which every declaration matches nothing.

The refusal is exit 1 and **nothing is written**, like every other refusal this
fold makes. So the remedy is to re-run this same fold with the declaration
added, and that re-run needs **no `--refold`**: the outdir holds no fold of
these commits, because the refused run published none.

That ordering is deliberate and it used to be the other way. Refusing after the
write meant the remedy re-read commits the outdir had already folded, so it
needed `--refold` — and `--refold` disarms the staleness check for every lane at
once, the check that stops an earlier iteration's leftover pass being signed as
this iteration's evidence. A guard the normal workflow tells you to switch off
is not a guard. Refusing first costs a delayed publish, which one flag
recovers, instead of a disarmed guard, which nothing does.

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
node ${SKILL_DIR}/scripts/verify.mjs --verify "$ADVERSE_RUN"/*/verify-*.json \
    --outdir "$ADVERSE_RUN" --briefing "$ADVERSE_RUN"/briefing.json \
    --report "$ADVERSE_RUN"/report.json

node ${SKILL_DIR}/scripts/triage.mjs \
    --round1 "$ADVERSE_RUN"/round1-*.verified.json \
    --round1 "$ADVERSE_RUN"/round1-*.regression.json \
    --repo . --base "$BASE" --gate-file "$ADVERSE_RUN"/gate.json --ledger "$LEDGER" \
    --out "$ADVERSE_RUN"/briefing.json
```

**Re-run `gate.mjs` before that triage, every iteration.** The fixes moved HEAD,
so the previous iteration's `gate.json` describes a tree that no longer exists.
It will not silently carry: `triage.mjs` re-binds the record to the HEAD under
review and marks a gate from any other commit `verified: false`, so a stale one
costs the suppression rather than faking it. Re-running is how the loop keeps
it — and it is the cheapest possible check that the fixes did not break the
build before four reviewers spend a round finding out.

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
noisy rather than silent, and recoverable by passing the flag. The inherited
anchor also makes the reopened finding matchable by the ledger — a prior
`declined` can settle it and a prior `fixed` flags it REGRESSED — both
consequences of the anchor, not of the severity alone.

The bridge binds by id and then by title, and the second route is not a
convenience. `briefing.mjs` re-mints finding ids **positionally on every triage
run**, so an id a reviewer copied out of an earlier iteration's briefing names
nothing here — or, worse, names a different finding. Binding by id alone put
every such verification at the blocking fallback, which for a `design` finding
contradicts the rule that design never blocks and made the loop unable to
converge on advisory work.

`--report` is what reaches a finding a round-2 reviewer **added**. It is in
`briefing.json` under no key at all — triage's only finding input is
`--round1` — and the previous iteration's `report.json` is the only file that
holds it, so pass that too (title-bound; the report carries no ids). Without
the flag, such a verification keeps the blocking `warning`/`behavioral`
fallback with a null anchor: noisy rather than silent, but an advisory
round-2 addition verified `open` then holds the loop open until someone
records a decision on it. A title that matches two findings in either source
binds to neither: it cannot say which is meant, and guessing is how a severity
gets copied off the wrong finding, so that case falls back to blocking and
says so.

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

## Compaction rows for the loop

SKILL.md's checkpoint table covers Phases 0–7 and hand-over; these rows join
it while a loop is running:

| Phase | Safe to compact | Why |
|---|---|---|
| 8 — check convergence | Anytime after it runs | Its exit code is derived entirely from the ledger and `report.json`, both already durable. |
| 9 — verify | **Never** until every `verify-<persona>.json` passes validation | Same unsaved-reviewer-payload rule as Phases 2 and 4. |

## Failure handling for the loop

These rows join SKILL.md's failure table:

| Failure | What to do |
|---|---|
| `converge.mjs` exits 3 | The cap, not success. Say plainly what is still open. |
| Ledger version mismatch | Do not delete it. Tell the user which version it is; the schema changed under them. |

## Cost per iteration

Each loop iteration adds ~3 cheap verification calls, not another 7, plus any
regression passes you choose to run — recommended per fix commit.
