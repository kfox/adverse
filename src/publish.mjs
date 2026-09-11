// Where the report goes when the session that produced it ends.
//
// A run writes report.md, report.json and report.html into a `mktemp -d` under
// the session scratchpad, prints a summary, and ends. The directory is reaped;
// the ledger survives but is local and per-machine. So the most durable thing
// a run produces is the least reachable: if the change under review was a pull
// request, that PR carries no trace that a panel ever looked at it — not the
// verdict, not the blocking count, not which lanes were skipped. Nobody
// reviewing the change can see any of it, and neither can the same user on
// another checkout.
//
// This module resolves the venue and renders the comment. Two properties are
// load-bearing and they pull in opposite directions, so both are stated here:
//
// ONE COMMENT PER BRANCH, REWRITTEN. Every body carries a fingerprint
// (`markerFor`), and a later pass finds that comment and rewrites it. Without
// that, a five-iteration convergence loop leaves five stacked reports, four of
// them stale — and the stale ones are the dangerous kind, because an
// iteration-1 report goes on saying a finding is open long after iteration 3
// closed it. One comment showing current state is the only shape that stays
// true.
//
// TARGET RESOLUTION IS THE RISK. This is the one capability in this repository
// that has already, twice, sent a fork's output somewhere it did not belong —
// three issues and a 60-file pull request opened against the upstream project
// by an agent acting alone, and GitHub has no deletion for pull requests at
// all. So the target is resolved from `origin` and nothing else, there is no
// repo argument of any kind anywhere in this feature, a branch whose pushes go
// somewhere other than `origin` is refused rather than redirected, an `origin`
// that has become indistinguishable from `upstream` is refused, and the
// default is a dry run that prints the exact body it would post. Publishing is
// opt-in per run and never automatic. See CLAUDE.md.
//
// What this deliberately does NOT do:
//
//   - Post a REVIEW. A GitHub review carries approve / request-changes
//     semantics. `design` and `contract` findings are advisory and can never
//     block (src/taxonomy.mjs); routing them through a mechanism that formally
//     requests changes breaks that rule at the venue where breaking it costs
//     the most. This posts an ordinary comment.
//   - Post INLINE comments. An inline comment can only anchor to a line in the
//     diff, and a finding whose `claimCheck.inDiff` is `outside` cannot anchor
//     at all — those are the latent defects the change newly makes reachable,
//     which triage protects on purpose as often the most valuable on the table.
//     Splitting the report across two mechanisms would drop exactly those.
//     Everything goes in the body with `path:line`.
//   - Re-narrate the report. The body is a PROJECTION of report.json. The
//     confidence groupings are the signal and prose regenerated from them
//     loses it — which is why SKILL.md forbids LLM-rendering the findings, and
//     the reason applies twice as hard once the artifact is public.

import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';

import { refuseDirectRun } from './entryGuard.mjs';
import { flatten, verbatim } from './markdown.mjs';
import { laneOf } from './personas.mjs';
import { probeState } from './probe.mjs';
import { ADVISORY_KINDS, isLaneList } from './taxonomy.mjs';

refuseDirectRun(import.meta.url);

export const DEFAULT_VENUE_TIMEOUT_MS = 30_000;

// GitHub rejects an issue-comment body over this with a 422, which would land
// at the worst possible moment: after a full run, with the report nowhere. The
// body is budgeted against it and declares its own truncation (`renderComment`).
export const MAX_COMMENT_CHARS = 65_536;

// What `resolveVenue` can conclude, and what each answer obliges a caller to
// do. The three are deliberately distinct, because collapsing the middle one
// into either neighbor is a bug in a different direction each way:
//
//   ok        there is a GitHub repository to publish into
//   none      there is nowhere to publish, and that is a normal state —
//             reviewing uncommitted changes with no PR anywhere is a
//             first-class use of this tool, not a degraded one
//   refused   there is somewhere, and it is not somewhere this may write
export const VENUE_STATUSES = Object.freeze(['ok', 'none', 'refused']);

// The only remote this feature reads. Not a default, not a preference — the
// name is here, once, so that "which remote" is never a parameter, an argument,
// or a fallback chain a later edit can extend.
export const VENUE_REMOTE = 'origin';

// The fork's upstream, by convention. Only ever used to REFUSE (see
// `originIsUpstream`), never to resolve anything.
const UPSTREAM_REMOTE = 'upstream';

const GITHUB_HOSTS = Object.freeze(['github.com', 'www.github.com', 'ssh.github.com']);

// A path segment GitHub accepts as an owner or a repository name. Deliberately
// narrower than "not a slash": the value is interpolated into a `gh api` path,
// and a segment holding `..` or a query separator is a different endpoint.
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// ---------- the fingerprint -------------------------------------------------

// Anything outside this set is percent-encoded into the marker. Branch names
// may legally contain `>`, so a branch called `a-->b` would close the HTML
// comment early and render the rest of the marker as body text; encoding it
// means the marker cannot be terminated by the value inside it.
const MARKER_SAFE = /[^A-Za-z0-9._/-]/g;

const encodeMarkerValue = (value) => flatten(value)
  .replace(MARKER_SAFE, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);

// An HTML comment, which GitHub does not render, carrying the one fact that
// makes the post repeatable: which branch this report is about. Nothing else
// goes in it — the repository is already settled by the endpoint the comment
// was fetched from, and a second field is a second thing that can disagree.
export function markerFor(branch) {
  return `<!-- adverse:run branch=${encodeMarkerValue(branch)} -->`;
}

export const hasMarker = (body, branch) =>
  typeof body === 'string' && body.includes(markerFor(branch));

// ---------- resolving the venue ---------------------------------------------

// `owner/name`, and only from a URL that actually names GitHub.
//
// src/telemetry.mjs has a `repoFromRemote` that looks similar and must not be
// reused here: it answers a different question. Telemetry wants a stable
// identity LABEL for a JSONL line, so it takes the last two path segments of
// any remote spelling and never looks at the host — `git@evil.example:kfox/
// adverse.git` is `kfox/adverse` to it, which is correct for a label and is
// precisely the hazard for a routing target. This function is the strict one,
// and the two are kept apart on purpose; tests/publish.test.mjs pins the case
// where they disagree so that a later de-duplication fails loudly.
export function parseGitHubRemote(url) {
  const raw = String(url ?? '').trim();
  if (!raw) return null;

  // A `..` anywhere in the path, refused before anything is parsed.
  //
  // `new URL()` NORMALIZES it, so `https://github.com/kfox/../addyosmani/adverse`
  // parsed to two clean segments naming a repository nobody wrote down — while
  // the scp-style branch below, which does no URL parsing, refused the same
  // spelling. Two branches disagreeing about what a remote means is not
  // something to reconcile in favor of the permissive one: a routing target has
  // to be unambiguous on its face, and no legitimate remote URL contains `..`.
  if (/(^|[/:])\.\.($|\/)/.test(raw)) return null;

  // scp-style (`git@github.com:owner/name`) has no scheme for URL to parse.
  const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(raw);
  let host;
  let pathname;
  if (scp && !raw.includes('://')) {
    [, host, pathname] = scp;
  } else {
    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      return null;
    }
    // A local path or a `file://` remote is somebody's directory layout, not a
    // project on a host. It can never be a venue.
    if (parsed.protocol === 'file:') return null;
    host = parsed.hostname;
    pathname = parsed.pathname;
  }

  if (!GITHUB_HOSTS.includes(String(host).toLowerCase())) return null;

  const segments = String(pathname).replace(/\.git$/, '').split('/').filter(Boolean);
  // Exactly two. A longer path is some other GitHub endpoint, and taking its
  // last two segments is how a URL that is not a repository becomes one.
  if (segments.length !== 2) return null;
  const [owner, name] = segments;
  if (!SEGMENT.test(owner) || !SEGMENT.test(name)) return null;
  return `${owner}/${name}`;
}

function git(args, { cwd, run, timeoutMs }) {
  const r = run('git', args, {
    cwd, encoding: 'utf-8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (r.error != null || r.signal != null || r.status !== 0) return null;
  return String(r.stdout ?? '').trim();
}

// Whether this is a checkout git can read at all, or a sentence saying why not.
//
// Called BEFORE `resolveVenue`, because all three of that function's answers
// presume a working git in a real repository. Without this check, a mistyped
// `--repo`, a path that does not exist, and a `git` missing from PATH all
// arrive as `status: 'none'` with "HEAD is not on a branch" — which is the same
// answer an honest local-only branch gets. The operator then reads "nothing to
// publish", believes the report had nowhere to go, and the environment that
// broke is never mentioned. Silent and noisy failure modes, and this is the
// repository's rule about which to pick.
export function checkCheckout({ cwd, run = spawnSync, timeoutMs = DEFAULT_VENUE_TIMEOUT_MS } = {}) {
  // Checked before spawning, because spawnSync reports a missing CWD and a
  // missing `git` as the same ENOENT — and the operator's next move differs
  // completely: fix the `--repo` you typed, or install git. A message covering
  // both is a message that helps with neither.
  try {
    if (!statSync(cwd).isDirectory()) return `${cwd} is not a directory`;
  } catch (e) {
    return `${cwd} cannot be read (${e.code ?? e.message})`;
  }

  const r = run('git', ['rev-parse', '--git-dir'], {
    cwd, encoding: 'utf-8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (r.error != null || r.signal != null || typeof r.status !== 'number') {
    return `git could not be run (${r.error?.message
      ?? (r.signal ? `killed by ${r.signal}` : 'no exit status')})`;
  }
  if (r.status !== 0) return `${cwd} is not a git checkout`;
  return null;
}

// The accident this exists for: `origin` pointed at the upstream project.
//
// Every other guard here checks that the target came from `origin`. None of
// them can notice that `origin` itself has been made to be upstream — by a
// clone of the wrong URL, a `set-url` typed once, or a fork relationship
// somebody rearranged. When both remotes resolve to the same repository the
// fork/upstream distinction has collapsed, and publishing lands on upstream.
//
// Stated as "origin and upstream are the same repository" rather than as a
// hardcoded name, because this tool reviews other people's repositories and a
// denylist would be a fix for one project. A fork whose `upstream` is a
// genuinely different repository resolves normally; a clone with no `upstream`
// remote has nothing to collide with and also resolves normally.
function originIsUpstream(target, opts) {
  const other = git(['remote', 'get-url', UPSTREAM_REMOTE], opts);
  if (other === null) return false;
  return parseGitHubRemote(other) === target;
}

// Where this branch's report may be published, or why it may not be.
//
// `cwd` is a checkout. There is no parameter for the repository, the remote, or
// the branch: all three are read out of that checkout, because every one of
// them is a way to steer where output lands.
export function resolveVenue({ cwd, run = spawnSync, timeoutMs = DEFAULT_VENUE_TIMEOUT_MS } = {}) {
  const opts = { cwd, run, timeoutMs };
  const nothing = { status: 'none', target: null, branch: null, pushRemote: null };

  // Detached HEAD, or a repository with no commits. There is no branch, so
  // there is no pull request for one, so there is nothing to refuse.
  const branch = git(['symbolic-ref', '--quiet', '--short', 'HEAD'], opts);
  if (!branch) {
    return { ...nothing, why: 'HEAD is not on a branch, so no pull request can name it' };
  }

  const originUrl = git(['remote', 'get-url', VENUE_REMOTE], opts);
  if (originUrl === null) {
    return { ...nothing, branch, why: `this checkout has no \`${VENUE_REMOTE}\` remote` };
  }

  const target = parseGitHubRemote(originUrl);
  if (target === null) {
    return {
      ...nothing,
      branch,
      why: `\`${VENUE_REMOTE}\` does not name a GitHub repository, so there is no pull request to comment on`,
    };
  }

  // Where git itself would push this branch — its own composed answer, rather
  // than this module's reading of `branch.*.remote`, `remote.pushDefault` and
  // `push.default` in some order that drifts from git's.
  const pushRemote = git(
    ['for-each-ref', '--format=%(push:remotename)', `refs/heads/${branch}`], opts);

  // Empty means the branch has no configured push destination: never pushed,
  // no upstream, no `remote.pushDefault`. That is "nowhere to publish", not
  // "the wrong place" — a local-only branch has no pull request anywhere, and
  // refusing it as dangerous would misdescribe the most ordinary run there is.
  if (!pushRemote) {
    return {
      ...nothing,
      branch,
      why: `\`${branch}\` has no push remote, so it has no pull request anywhere yet`,
    };
  }

  // The local branch name is used as the pull request's head ref below, and
  // under a custom push refspec (`remote.origin.push = refs/heads/*:refs/heads/
  // prefix-*`) the remote-side name differs and the lookup finds nothing.
  // `%(push:strip=3)` would give the remote-side name, and it is deliberately
  // not read: it would put two branch names into every message and record, for
  // a configuration this tool has never been run under, and the failure
  // without it is already in the safe direction — "no open pull request",
  // exit 0, nothing written anywhere. A silent miss that posts nothing beats a
  // second name a reader has to keep straight.

  // Set, and not `origin`. This is the dangerous one: the branch's commits go
  // to some other remote, so `origin`'s pull requests are not this branch's
  // venue, and posting there attributes this report to somebody else's change.
  if (pushRemote !== VENUE_REMOTE) {
    return {
      status: 'refused',
      target: null,
      branch,
      pushRemote,
      why: `\`${branch}\` pushes to \`${pushRemote}\`, not \`${VENUE_REMOTE}\``
        + ' — this refuses to publish into a repository the branch does not push to',
    };
  }

  if (originIsUpstream(target, opts)) {
    return {
      status: 'refused',
      target: null,
      branch,
      pushRemote,
      why: `\`${VENUE_REMOTE}\` and \`${UPSTREAM_REMOTE}\` both resolve to ${target}`
        + ' — a fork whose origin is its own upstream cannot be published to safely',
    };
  }

  return { status: 'ok', target, branch, pushRemote, why: '' };
}

// ---------- talking to GitHub ------------------------------------------------

// One place the `gh` command line is built, and the only place. `run` is
// injected so the tests never reach the network.
function gh(args, { run = spawnSync, timeoutMs = DEFAULT_VENUE_TIMEOUT_MS, cwd, input } = {}) {
  const r = run('gh', args, {
    cwd, encoding: 'utf-8', timeout: timeoutMs, input, stdio: 'pipe',
  });
  const couldNotRun = r.error != null || r.signal != null || typeof r.status !== 'number';
  return {
    ok: !couldNotRun && r.status === 0,
    stdout: String(r.stdout ?? ''),
    // A `gh` that is not installed reports itself through `error`, and that is
    // the single most likely failure here — worth saying in those words rather
    // than as an empty stderr.
    stderr: couldNotRun
      ? (r.error?.message ?? (r.signal ? `killed by ${r.signal}` : 'no exit status'))
      : String(r.stderr ?? '').trim(),
  };
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// The open pull request whose head is this branch, or null.
//
// `--repo` is passed explicitly with the value resolved from `origin`, rather
// than omitted to let `gh repo set-default` answer. For a person typing a
// command the default is the safer habit; for a program it is the opposite —
// this tool runs in repositories whose default is unset or stale, and a value
// this process computed from `origin` is the only one it can vouch for.
export function findPullRequest({ target, branch }, opts = {}) {
  const r = gh(['pr', 'list', '--repo', target, '--head', branch,
    '--state', 'open', '--limit', '1', '--json', 'number,url'], opts);
  if (!r.ok) return { error: r.stderr || 'gh pr list failed', pr: null };

  const list = parseJson(r.stdout);
  if (!Array.isArray(list)) return { error: 'gh pr list did not return a JSON array', pr: null };
  if (!list.length) return { error: null, pr: null };

  const [{ number, url }] = list;
  if (!Number.isInteger(number) || number <= 0) {
    return { error: `gh pr list returned no usable PR number (${JSON.stringify(number)})`, pr: null };
  }
  return { error: null, pr: { number, url: typeof url === 'string' ? url : null } };
}

// The login `gh` is authenticated as. Needed, not cosmetic: see
// `findMarkedComment`.
export function viewerLogin(opts = {}) {
  const r = gh(['api', 'user', '--jq', '.login'], opts);
  const login = r.stdout.trim();
  if (!r.ok || !login) return { error: r.stderr || 'could not read the authenticated login', login: null };
  return { error: null, login };
}

// This run's own previous comment on that pull request, if it left one.
//
// Two conditions, both required. The marker says the comment is one of these
// reports for this branch; the author says it is OURS. The marker alone is not
// enough — a comment body is public, writable by anyone who can comment, and a
// stranger who pastes the marker into their own comment would otherwise have it
// rewritten by the next pass. That is not merely rude: a token with write
// access to the repository CAN edit other people's comments, so the API would
// not refuse it.
export function findMarkedComment({ target, number, branch, login }, opts = {}) {
  // `--paginate` merges a paged JSON array into one array, so a marker on a
  // pull request with hundreds of comments is still found. Missing it would
  // post a duplicate, which is the exact failure the marker exists to prevent.
  const r = gh(['api', '--paginate',
    `repos/${target}/issues/${number}/comments?per_page=100`], opts);
  if (!r.ok) return { error: r.stderr || 'gh api could not list the comments', comment: null };

  const list = parseJson(r.stdout);
  if (!Array.isArray(list)) return { error: 'the comment listing was not a JSON array', comment: null };

  const mine = list.filter((c) => c
    && hasMarker(c.body, branch)
    && typeof c.user?.login === 'string'
    && c.user.login === login);
  if (!mine.length) return { error: null, comment: null };

  // The oldest, when somehow there are several: rewriting the first one keeps
  // the report where a reader already found it, and a later duplicate is
  // visibly stale rather than silently authoritative.
  const [first] = mine;
  if (!Number.isInteger(first.id)) {
    return { error: 'a matching comment had no usable id', comment: null };
  }
  return { error: null, comment: { id: first.id, url: typeof first.html_url === 'string' ? first.html_url : null } };
}

// Create the comment, or rewrite the one already there.
//
// The body travels on stdin as JSON rather than in argv: a report is tens of
// kilobytes, argv has a limit, and a body assembled by shell quoting is a body
// that can be broken by its own content.
export function publishComment({ target, number, body, commentId = null }, opts = {}) {
  const endpoint = commentId === null
    ? `repos/${target}/issues/${number}/comments`
    : `repos/${target}/issues/comments/${commentId}`;
  const method = commentId === null ? 'POST' : 'PATCH';

  const r = gh(['api', endpoint, '--method', method, '--input', '-'],
    { ...opts, input: JSON.stringify({ body }) });
  if (!r.ok) return { error: r.stderr || `gh api ${method} ${endpoint} failed`, url: null };

  const created = parseJson(r.stdout);
  return { error: null, url: typeof created?.html_url === 'string' ? created.html_url : null };
}

// ---------- rendering the body ----------------------------------------------

// Present, or this refuses to render.
//
// The accounting fields are the reason this check exists and the reason it
// throws rather than defaulting. `synthesize` already refuses to produce a
// report without the skipped-lane accounting, because a lane that was skipped
// and not mentioned reads exactly like a lane that looked and found nothing —
// and that failure gets strictly worse when the artifact is public, permanent,
// and read by people who were not in the session. A `report.json` missing them
// is truncated, hand-written, or from another tool; publishing it would
// silently publish a run that looks more thorough than it was.
const REQUIRED_REPORT_KEYS = Object.freeze([
  'consensus_label', 'verdicts', 'findings', 'open_blocking', 'root_causes',
  'degraded', 'skipped', 'round2_skipped', 'depth',
]);

const SEVERITY_MARKER = Object.assign(Object.create(null),
  { critical: '🔴', warning: '🟡', info: '🔵' });

// What the run's planned depth means for reading this report, for the two
// depths that are not the baseline. A Map for the same reason SEVERITY_MARKER
// has a null prototype: the key arrives from a plan.json on disk, and an object
// literal answers `constructor` with a function that renders as a note nobody
// wrote.
const DEPTH_NOTES = new Map([
  ['cheap', '**Planned depth `cheap`.** A lane whose every kind is advisory could skip'
    + ' one size bucket earlier than usual. An absent finding here is weaker evidence'
    + ' than in a standard run.'],
  ['thorough', '**Planned depth `thorough`.** Every lane ran whatever the diff\'s size'
    + ' said, at a higher model tier.'],
]);

// The plan's reason, flattened and re-punctuated. Flattened because this is
// the one renderer whose output is public and permanent: a newline inside the
// reason would end the paragraph and render the rest of the accounting as
// document body, and a plan.json is a file on disk that this process did not
// write.
const planReason = (reason) => `${flatten(reason).replace(/\s*\.*\s*$/, '')}.`;

// The probe declaration, in this renderer's words. Same table shape and same
// null-prototype reasoning as DEPTH_NOTES above; the state itself is decided
// once, in src/probe.mjs, for all three renderings.
//
// This one earns its place here more than in either local artifact: a reader of
// a pull-request comment was not in the session, cannot see the run directory,
// and has no other way to learn that the panel was never offered a way to run
// the code it is reporting on.
const PROBE_NOTES = new Map([
  ['not-offered', (p) => '**Probes were not offered.** No finding below was settled by'
    + ' running the code, and none could be.'
    + `${p.reason ? ` The plan's reason: ${planReason(p.reason)}` : ''}`],
  ['unrecorded', () => '**No probe was recorded.** Reproductions were available to the'
    + ' panel and this run has no record of one being run — the phase was skipped, or no'
    + ' reviewer attached one. Nothing below was settled by execution.'],
  ['not-enabled', (p) => `**Probe execution was not enabled.** ${p.attached}`
    + ' reproduction(s) were attached and every one was recorded as declined. Nothing'
    + ' below was settled by execution.'],
  ['ran', (p) => (p.attached === 0
    ? '**Probes were enabled and none was attached.** Every lane declined, which costs a'
      + ' reviewer nothing. Nothing below was settled by running the code.'
    : `**Probes ran.** ${p.attached} attached, ${p.ran} re-run, ${p.confirmed} reproduced,`
      + ` ${p.contradicted} ran without reproducing`
      + `${p.sandboxed ? ', under the sandbox the operator supplied' : ', with no sandbox'}.`
      + ' A reproduction that did not reproduce disproves nothing.')],
]);

const locator = (f) => (f.file
  ? verbatim(`${f.file}${f.line === null || f.line === undefined ? '' : `:${f.line}`}`)
  : '_no location_');

// A finding as one line. `title` is prose and stays prose — a reviewer's
// emphasis is a formatting choice inside a block already labeled as that
// reviewer's words (src/markdown.mjs) — but it is FLATTENED, because a raw
// newline inside a list item ends the list and renders the remainder as
// document body.
//
// `isOpen` marks the findings the header's **Open blocking** count is counting.
// Without it that number names a set the reader cannot find: `blocking` on a
// finding is kind-based and true of far more findings than the count, and
// leaving the two unlinked is how a reader concludes the wrong three are the
// ones holding the change.
function findingLine(f, isOpen) {
  const marker = SEVERITY_MARKER[f.severity] ?? '·';
  const open = isOpen(f) ? ' · **open blocking**' : '';
  return `- ${marker} ${locator(f)} — ${flatten(f.title)}`
    + ` _(${verbatim(f.kind)} · ${verbatim(f.confidence)})_${open}`;
}

function accounting(report) {
  const out = [];
  if (report.degraded.length) {
    out.push(`**Degraded run.** These reviewers failed and were excluded: `
      + `${report.degraded.map(verbatim).join(', ')}.`);
  }
  if (report.skipped.length) {
    out.push(`**Lane not run.** ${report.skipped
      .map((s) => `${verbatim(s.persona ?? s)}${s.reason ? ` — ${s.reason}` : ''}`)
      .join('; ')}. Nothing below reflects that perspective.`);
  }
  if (report.round2_skipped) {
    out.push(`**Round 2 skipped.** ${report.round2_skipped} No finding below was `
      + 'cross-examined, and round 2\'s cross-lane additions were forgone.');
  }
  const depth = DEPTH_NOTES.get(report.depth);
  if (depth) out.push(depth);
  // Absent on a report.json written before the field existed, which is why
  // `probes` is not in REQUIRED_REPORT_KEYS: `probeState` returns null for a
  // missing block and this declares nothing, rather than refusing to publish
  // an older report or — worse — asserting that probes were off.
  const probes = PROBE_NOTES.get(probeState(report.probes));
  if (probes) out.push(probes(report.probes));
  return out;
}

// What a truncated body says about itself. One function, so the space reserved
// for it and the text finally written into it are the same length by
// construction.
const truncationNote = (n) => `> **${n} finding${n === 1 ? '' : 's'} omitted.** This body`
  + ` reached GitHub's ${MAX_COMMENT_CHARS}-character comment limit. The report in the`
  + ' run directory is complete; this comment is not.';

// The body, as a projection of report.json.
//
// Sections are assembled in priority order and the finding lists are budgeted
// against `MAX_COMMENT_CHARS`, so what gets dropped when a report is enormous
// is the tail of a list rather than the header — and the drop is declared in
// the body. A truncated comment that does not say it was truncated is a report
// claiming there is nothing more to see.
export function renderComment(report, { branch, head = null, base = null, iteration = null } = {}) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    throw new Error('venue: not a report.json (expected a JSON object)');
  }
  const missing = REQUIRED_REPORT_KEYS.filter((k) => !Object.hasOwn(report, k));
  if (missing.length) {
    throw new Error(`venue: this report.json is missing ${missing.join(', ')}`
      + ' — it cannot be published without its own run accounting');
  }
  for (const k of ['verdicts', 'findings', 'open_blocking', 'root_causes', 'degraded', 'skipped']) {
    const value = report[k];
    const wrong = k === 'verdicts'
      // An array IS an object, so it passed this check and then reported a
      // reviewer count of 0 instead of refusing a report it could not read.
      ? (!value || typeof value !== 'object' || Array.isArray(value))
      : !Array.isArray(value);
    if (wrong) throw new Error(`venue: this report.json has an unusable \`${k}\``);
  }

  // The KEYS of `verdicts`, not only its shape. This renderer prints
  // `Object.keys(report.verdicts).length` as "N reviewers" in a comment that
  // is public and permanent, and uses the same count to decide between "All
  // reviewers reported clean" and "this is an empty review, not a clean one" —
  // so one extra key is one reviewer nobody heard from, vouching. The shape
  // check above passes any object, and `root_causes[].reporters` below is
  // already held to this vocabulary; the map that does the counting was not.
  //
  // `laneOf`, not a shape check: a shape check closes the SPELLING and leaves
  // the class. `referee` and `helper` are both well-formed lane names, and a
  // report.json keyed `auditor` (reject, one critical), `referee` (approve)
  // and `helper` (approve) published `SHIP (2/3 ship, 1/3 block)` over that
  // critical with "3 reviewers" beside it. A name nobody can point at a lane
  // for is not a reviewer.
  //
  // Counted rather than quoted, the same way the telemetry writer handles an
  // unknown lane: the strings here are whatever a hand-edited file says, and
  // this message is read on a terminal.
  const strangers = Object.keys(report.verdicts).filter((k) => !laneOf(k)).length;
  if (strangers) {
    throw new Error(`venue: this report.json keys \`verdicts\` by ${strangers} name(s)`
      + ' that name no review lane, so the reviewer count it publishes is not one');
  }

  // A root cause's own lists, for the reason the top-level ones are checked and
  // one more: this renderer COUNTS them, and a string counts. `"auditor"`
  // published "7 reviewers" — in the one artifact people outside the session
  // read, which is permanent and which nobody in the session will re-read.
  // html.mjs and synthesis.mjs throw on that same value; this was the reader
  // that answered.
  for (const [i, rc] of report.root_causes.entries()) {
    if (!rc || typeof rc !== 'object' || Array.isArray(rc)) continue;
    if (rc.citations !== undefined && !Array.isArray(rc.citations)) {
      throw new Error(`venue: this report.json has an unusable \`root_causes[${i}].citations\``);
    }
    if (rc.reporters !== undefined && !isLaneList(rc.reporters)) {
      throw new Error(`venue: this report.json has an unusable \`root_causes[${i}].reporters\``);
    }
  }

  const findings = report.findings.filter((f) => f && typeof f === 'object');
  const blocking = findings.filter((f) => !ADVISORY_KINDS.has(f.kind));
  const advisory = findings.filter((f) => ADVISORY_KINDS.has(f.kind));
  const demonstrated = findings.filter((f) => f.probe?.confirmed === true);
  // Matched on title, which is what `open_blocking` carries. A Set with a null
  // prototype is unnecessary here — `Set` has no prototype keys to collide
  // with — but the membership test is the reason the titles are normalized the
  // same way on both sides: `open_blocking` is built from the same `title`
  // field the findings carry, so an exact match is the whole join.
  const openTitles = new Set(report.open_blocking.filter((t) => typeof t === 'string'));
  const isOpen = (f) => openTitles.has(f.title);
  const counts = ['critical', 'warning', 'info']
    .map((s) => `${findings.filter((f) => f.severity === s).length} ${s}`).join(' · ');

  const head1 = [
    markerFor(branch),
    '## Adversarial code review',
    '',
    `**Verdict:** ${verbatim(report.consensus_label)}  `,
    `**Open blocking:** ${report.open_blocking.length}`
      + ' (demonstrated, cross-validated or consensus, not advisory, not `info`)  ',
    `**Findings:** ${counts} (${findings.length} total across`
      + ` ${Object.keys(report.verdicts).length} reviewers)  `,
  ];
  if (demonstrated.length) {
    head1.push(`**Demonstrated:** ${demonstrated.length} — a reproduction was re-run`
      + ' and the behavior occurred  ');
  }
  const at = [
    branch ? verbatim(branch) : null,
    head ? `at ${verbatim(String(head).slice(0, 12))}` : null,
    base ? `over ${verbatim(String(base).slice(0, 12))}` : null,
    iteration ? `pass ${Number(iteration)}` : null,
  ].filter(Boolean).join(' · ');
  if (at) head1.push(`**Reviewed:** ${at}  `);

  // One blockquote per note, separated by a bare `>`: GFM folds adjacent
  // blockquote lines into a single paragraph, so a skipped lane and a depth
  // note rendered as one run-together sentence that said neither thing.
  const notes = accounting(report);
  if (notes.length) {
    head1.push('');
    notes.forEach((n, i) => {
      if (i > 0) head1.push('>');
      head1.push(`> ${n}`);
    });
  }

  const confirmed = report.root_causes.filter((rc) => rc && rc.status === 'confirmed');
  if (confirmed.length) {
    head1.push('', '### Root causes confirmed by round 2', '');
    for (const rc of confirmed) {
      head1.push(`- **${verbatim(rc.id)}** ${flatten(rc.title)}`
        + ` — ${(rc.citations ?? []).length} citations from`
        + ` ${(rc.reporters ?? []).length} reviewers,`
        + ` ${rc.blocking ? 'blocking' : 'advisory only'}`);
    }
  }

  const tail = [
    '',
    '---',
    '',
    '<sub>Posted by <a href="https://github.com/kfox/adverse">adverse</a>.'
    + ' One comment per branch, rewritten on each pass — so this is the current'
    + ' state of the review, not a log of it. The full report, including every'
    + " finding's reasoning, stays in the run directory.</sub>",
  ];

  // Budget the lists against what the header, the footer, and the truncation
  // note they might need all cost.
  //
  // The note is RESERVED unconditionally, even on a report that will not need
  // it. It is only rendered when something was dropped — but a note appended
  // after the budget has been spent is exactly how the body first overshot the
  // limit, by 123 characters of its own warning about being too long. Reserving
  // the widest count it could ever print costs a dozen characters and cannot be
  // got wrong later.
  // One rule for what a block of lines costs, used for every block. Sizing the
  // openers with `join('\n').length` and the individual lines with
  // `length + 1` was two rules for one thing, and it under-counted each
  // section by exactly the newline that joins it to what came before —
  // survivable only because the reserve above happened to cover it.
  const cost = (lines) => lines.reduce((n, l) => n + l.length + 1, 0);

  const fixed = cost([...head1, ...tail]);
  let budget = MAX_COMMENT_CHARS - fixed - cost([truncationNote(Number.MAX_SAFE_INTEGER), '']);
  const body = [];
  let dropped = 0;

  const section = (heading, items, preamble = null) => {
    if (!items.length) return;
    const opener = ['', heading, ''];
    if (preamble) opener.push(preamble, '');
    const upfront = cost(opener);
    if (upfront > budget) {
      dropped += items.length;
      return;
    }
    budget -= upfront;
    body.push(...opener);
    for (const f of items) {
      const line = findingLine(f, isOpen);
      // `continue`, not `break`: a shorter line from the section below can
      // still fit after a long one did not, and the advisory section must not
      // vanish entirely just because the blocking list filled the budget.
      if (cost([line]) > budget) {
        dropped += 1;
        continue;
      }
      budget -= cost([line]);
      body.push(line);
    }
  };

  // Blocking first, and advisory always in its own labeled section: the whole
  // point of the advisory kinds is that they cannot hold a change open, and a
  // reader skimming one list cannot tell which half they are in.
  section('### Blocking findings', blocking);
  section(`### Advisory (${[...ADVISORY_KINDS].join(', ')} — recorded, never blocking)`, advisory,
    '_Real feedback and worth acting on, but they cannot hold this change open:'
    + ' a reviewer can always want different structure, and prose claims never run'
    + ' out, so a loop that waits for either supply to be exhausted never ends._');

  // The same distinction the Markdown report draws, and it matters more here:
  // this body is public and durable, and "all reviewers reported clean" over a
  // run where nobody reported at all is the most misleading sentence this tool
  // could publish.
  if (!findings.length) {
    body.push('', Object.keys(report.verdicts).length
      ? '_No findings. All reviewers reported clean._'
      : '_No findings, and no reviewer reported one either: every lane is accounted'
        + ' for above as not run or degraded. This is an empty review, not a clean one._');
  }
  if (dropped) body.push('', truncationNote(dropped));

  return [...head1, ...body, ...tail].join('\n');
}
