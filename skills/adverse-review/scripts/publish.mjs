#!/usr/bin/env node
// Skill bridge: Phase 10. Put the report where the change is discussed.
//
// A run's report lives in a scratch directory that the OS reaps, so the panel's
// whole product is currently readable only by the person who ran it, in the
// session that ran it. This posts a projection of report.json to the branch's
// open pull request as an ordinary comment, and rewrites that same comment on
// every later pass — src/publish.mjs carries the full argument, including why it
// is a comment and not a review, and why nothing is posted inline.
//
// DRY RUN IS THE DEFAULT. Without `--publish` this resolves the venue, renders
// the exact body, prints it, and posts nothing. That is not a convenience: this
// is the one capability in this repository that has already sent a fork's
// output somewhere it did not belong, twice, and GitHub has no deletion for
// pull requests at all. Publishing is opt-in per run and never automatic.
//
// THERE IS NO REPO ARGUMENT. `--repo` names a local CHECKOUT, exactly as it
// does in every other bridge here. The target repository is resolved from that
// checkout's `origin` and from nothing else — not from a flag, not from `gh
// repo set-default`, not from a fallback chain. A branch that pushes somewhere
// other than `origin`, and an `origin` that has become its own `upstream`, are
// refused rather than redirected.
//
// Exit codes. The contract in bridge-io.mjs draws its line between "never read
// an input" (2) and "a claim about a review" (1); this bridge makes no claims
// about a review at all, so its 1 means one thing only:
//   0  the body was rendered — posted if --publish, or there is no venue to
//      post to, which is a normal state and says so
//   1  the report was NOT published: the venue was refused, or the post failed
//   2  usage, an unreadable report, or an unwritable --out

import { writeFileSync } from 'node:fs';
import path from 'node:path';

import { parseBridgeArgs, readJson, usage } from './bridge-io.mjs';
import { importFromSrc } from './package-root.mjs';

const { checkCheckout, findMarkedComment, findPullRequest, publishComment, renderComment,
  resolveVenue, viewerLogin } = await importFromSrc('publish.mjs');

const USAGE = 'Usage: publish.mjs --report <report.json> --repo <dir> [--iteration <n>]'
  + ' [--publish] [--out <body.md>]';

const { values } = parseBridgeArgs({
  prefix: 'publish',
  usage: USAGE,
  options: {
    report:    { type: 'string' },
    repo:      { type: 'string' },
    iteration: { type: 'string' },
    publish:   { type: 'boolean' },
    out:       { type: 'string' },
  },
  strict: true,
});

if (!values.report || !values.repo) usage(USAGE);

// A pass number of 1 or more, or nothing. Same rule as `synthesize --iteration`:
// the number comes from the ledger's own counter, and a zero or a word in the
// body would read as a claim about which pass produced it.
let iteration = null;
if (values.iteration !== undefined) {
  iteration = Number(values.iteration);
  if (!Number.isInteger(iteration) || iteration < 1) {
    usage(`publish: --iteration must be a pass number of 1 or more, got:`
      + ` ${values.iteration}\n${USAGE}`);
  }
}

const repo = path.resolve(values.repo);

// Exit 2, before anything else: a run that cannot read the checkout never got
// as far as establishing where its report belongs. Checked here rather than
// left to `resolveVenue`, whose "nowhere to publish" answer is a legitimate
// state and must not be reachable by a typo in `--repo`.
const broken = checkCheckout({ cwd: repo });
if (broken) {
  process.stderr.write(`publish: ${broken}\n`);
  process.exit(2);
}

const report = readJson(values.report, 'publish');

// Resolved before the body is rendered. A refused venue is the one answer worth
// having early: rendering first would print a report beside a refusal and
// invite the operator to paste it somewhere by hand, which is the whole failure
// this bridge exists to make unnecessary.
const venue = resolveVenue({ cwd: repo });

if (venue.status === 'refused') {
  process.stderr.write(`publish: refusing to publish — ${venue.why}\n`);
  process.exit(1);
}

// `head` and `base` come off the report itself, never off this process's view
// of the checkout. The report knows which tree it reviewed; the working
// directory has moved on by the time a fix batch has landed, and stamping the
// comment with today's HEAD would date the review to a commit it never read.
let body;
try {
  body = renderComment(report, {
    branch: venue.branch ?? '(no branch)',
    head: report.head ?? null,
    base: report.base ?? null,
    iteration,
  });
} catch (e) {
  // Exit 1, not 2: the file was read. What failed is the report's own fitness
  // to be published — a report.json missing its skipped-lane accounting would
  // publish a run that looks more thorough than it was.
  process.stderr.write(`publish: ${values.report}: ${e.message}\n`);
  process.exit(1);
}

if (values.out) {
  try {
    writeFileSync(values.out, `${body}\n`, 'utf-8');
  } catch (e) {
    process.stderr.write(`publish: ${values.out}: cannot be written (${e.message.trim()})\n`);
    process.exit(2);
  }
}

// Nowhere to publish, which is not a failure. Reviewing uncommitted changes on
// a branch with no pull request is a first-class use of this tool, and the body
// is still printed so the operator can read what would have been posted.
if (venue.status !== 'ok') {
  process.stdout.write(`publish: nothing to publish to — ${venue.why}\n`);
  process.stdout.write(`${body}\n`);
  process.exit(0);
}

// Exit 1 whether or not --publish was asked for. A dry run's contract is to
// print the exact body it WOULD post and say where; a lookup that failed cannot
// answer the second half, and reporting that as success would tell the operator
// the publish is ready when nothing has been checked. `gh` not being installed
// arrives here.
const { error: prError, pr } = findPullRequest(venue, { cwd: repo });
if (prError) {
  process.stderr.write(`publish: ${venue.target}: ${prError}\n`);
  process.exit(1);
}

if (pr === null) {
  process.stdout.write(`publish: ${venue.target} has no open pull request for`
    + ` ${venue.branch} — nothing to comment on\n`);
  process.stdout.write(`${body}\n`);
  process.exit(0);
}

const where = `${venue.target}#${pr.number}`;

if (!values.publish) {
  process.stdout.write(`publish: DRY RUN. Would comment on ${where}`
    + `${pr.url ? ` (${pr.url})` : ''}.\n`
    + '  Re-run with --publish to post it. The body follows:\n\n'
    + `${body}\n`);
  process.exit(0);
}

// Who this run is authenticated as. Required, not cosmetic: the marker alone
// cannot distinguish this run's own previous comment from anybody else's
// comment that happens to contain the marker text, and a token with write
// access to the repository can edit other people's comments — so without the
// login there is no safe answer to "is this mine to rewrite".
const { error: loginError, login } = viewerLogin({ cwd: repo });
if (loginError) {
  process.stderr.write(`publish: ${loginError}\n`
    + '    without the authenticated login this cannot tell its own previous comment from\n'
    + "    somebody else's, so it will not rewrite one. Check `gh auth status`.\n");
  process.exit(1);
}

const { error: findError, comment } = findMarkedComment(
  { ...venue, number: pr.number, login }, { cwd: repo });
if (findError) {
  // Refuse rather than post. Posting here would be the duplicate-per-pass
  // failure the marker exists to prevent, and a stack of stale reports is
  // worse than no report: an early one goes on saying a finding is open long
  // after a later pass closed it.
  process.stderr.write(`publish: ${where}: ${findError}\n`
    + '    refusing to post, because a comment posted without checking for the previous\n'
    + '    one is the stacked-stale-reports failure this rewrites to avoid.\n');
  process.exit(1);
}

const { error: postError, url } = publishComment(
  { target: venue.target, number: pr.number, body, commentId: comment?.id ?? null },
  { cwd: repo });
if (postError) {
  process.stderr.write(`publish: ${where}: ${postError}\n`);
  process.exit(1);
}

process.stdout.write(`publish: ${comment ? 'rewrote' : 'posted'} the report on ${where}`
  + `${url ? ` — ${url}` : ''}\n`);
