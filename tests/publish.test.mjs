// Tests for src/publish.mjs — resolving where a report may be published, and
// rendering the body that goes there.
//
// Two properties carry most of the weight here and most of the tests:
//
//   1. The target comes from `origin` and nothing else, and a target that is
//      not this branch's push destination is REFUSED rather than redirected.
//      This is the capability that has already sent this fork's output to
//      somebody else's project twice, so the refusals are pinned individually
//      and the divergence from telemetry's lookalike parser is pinned too.
//   2. The body is a projection of report.json that cannot be rendered without
//      the run's own accounting. A report missing its skipped-lane list would
//      publish a run that looks more thorough than it was, permanently and in
//      public.
//
// Everything talks to git and gh through an injected `run`, so nothing in this
// file spawns a process or reaches the network.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { repoFromRemote } from '../src/telemetry.mjs';
import {
  MAX_COMMENT_CHARS, checkCheckout, findMarkedComment, findPullRequest, hasMarker,
  markerFor, parseGitHubRemote, publishComment, renderComment, resolveVenue, viewerLogin,
} from '../src/publish.mjs';

// ---------- a fake `run` ------------------------------------------------------

// Answers by the joined command line, so a test states what git or gh said and
// nothing else. An unlisted command reports itself as unrunnable, which is what
// `resolveVenue` reads as "this configuration does not exist".
function faker(answers) {
  const calls = [];
  const run = (cmd, args, opts = {}) => {
    calls.push({ cmd, args, opts, line: [cmd, ...args].join(' ') });
    const answer = answers[[cmd, ...args].join(' ')];
    if (answer === undefined) return { status: 1, stdout: '', stderr: 'not configured' };
    if (typeof answer === 'string') return { status: 0, stdout: answer, stderr: '' };
    return { status: 0, stdout: '', stderr: '', ...answer };
  };
  return { run, calls };
}

const BRANCH = 'feat/venue';
const gitAnswers = (over = {}) => ({
  'git symbolic-ref --quiet --short HEAD': BRANCH,
  'git remote get-url origin': 'git@github.com:kfox/adverse.git\n',
  [`git for-each-ref --format=%(push:remotename) refs/heads/${BRANCH}`]: 'origin\n',
  ...over,
});

// ---------- parseGitHubRemote -------------------------------------------------

test('parseGitHubRemote reads owner/name from every spelling of a GitHub remote', () => {
  for (const url of [
    'git@github.com:kfox/adverse.git',
    'git@github.com:kfox/adverse',
    'ssh://git@github.com/kfox/adverse.git',
    'https://github.com/kfox/adverse',
    'https://github.com/kfox/adverse.git',
    'https://GitHub.com/kfox/adverse',
    '  https://github.com/kfox/adverse  ',
  ]) {
    assert.equal(parseGitHubRemote(url), 'kfox/adverse', url);
  }
});

// Some CI checkouts leave a token in the origin URL. The host is still GitHub,
// so the venue is still resolvable — and the credential must not leak into the
// value, which is interpolated into a `gh api` path and printed to stdout.
test('parseGitHubRemote drops a credential netloc and keeps the repository', () => {
  assert.equal(
    parseGitHubRemote('https://x-access-token:ghs_secret@github.com/kfox/adverse.git'),
    'kfox/adverse');
});

// The whole reason this function exists rather than reusing telemetry's.
test('parseGitHubRemote refuses a non-GitHub host that telemetry would happily label', () => {
  const impostor = 'git@evil.example:kfox/adverse.git';
  assert.equal(parseGitHubRemote(impostor), null);
  // Pinned deliberately: telemetry answers this one, correctly, for its own
  // purpose. If someone later "de-duplicates" the two parsers, this fails and
  // says why they are separate.
  assert.equal(repoFromRemote(impostor), 'kfox/adverse');
});

test('parseGitHubRemote refuses anything that is not exactly one repository', () => {
  for (const url of [
    '',
    null,
    undefined,
    'not a url',
    '/srv/git/adverse.git',
    './adverse',
    'file:///srv/git/adverse',
    'https://github.com/kfox',
    'https://github.com/kfox/adverse/pulls/1',
    'https://github.com/kfox/../addyosmani/adverse',
    'https://github.com/-leading/adverse',
    'https://gitlab.com/kfox/adverse',
    'https://github.example.com/kfox/adverse',
  ]) {
    assert.equal(parseGitHubRemote(url), null, JSON.stringify(url));
  }
});

// ---------- the fingerprint --------------------------------------------------

test('markerFor round-trips through hasMarker and does not match another branch', () => {
  const body = `${markerFor('feat/x')}\nreport`;
  assert.equal(hasMarker(body, 'feat/x'), true);
  assert.equal(hasMarker(body, 'feat/y'), false);
  assert.equal(hasMarker(null, 'feat/x'), false);
  assert.equal(hasMarker(undefined, 'feat/x'), false);
});

// git permits `>` in a refname, so `a-->b` would close the HTML comment from
// inside the value and render the remainder of the marker as visible body text
// — which also means the marker a later pass looks for would never match.
test('a branch name cannot terminate the marker it is inside', () => {
  const m = markerFor('wip/a-->b');
  assert.equal(m.indexOf('-->'), m.length - 3);
  assert.equal(hasMarker(`${m}\nx`, 'wip/a-->b'), true);
});

test('a marker value is flattened, so a newline cannot split it', () => {
  assert.match(markerFor('a\nb'), /^<!-- adverse:run branch=a%20b -->$/);
});

// ---------- resolveVenue -----------------------------------------------------

test('resolveVenue resolves the target from origin when the branch pushes there', () => {
  const { run } = faker(gitAnswers());
  const v = resolveVenue({ cwd: '/repo', run });
  assert.equal(v.status, 'ok');
  assert.equal(v.target, 'kfox/adverse');
  assert.equal(v.branch, BRANCH);
  assert.equal(v.pushRemote, 'origin');
  assert.equal(v.why, '');
});

test('resolveVenue asks git for the push remote rather than reading the config itself', () => {
  const { run, calls } = faker(gitAnswers());
  resolveVenue({ cwd: '/repo', run });
  assert.ok(calls.some((c) => c.line.includes('%(push:remotename)')),
    'git composes push.default / pushRemote / branch.<n>.remote; this must not re-derive it');
  assert.ok(calls.every((c) => c.opts.cwd === '/repo'));
});

// Each of these is "there is nowhere to publish", which is a NORMAL state:
// reviewing uncommitted changes on a branch with no pull request is a
// first-class use of this tool. Reporting them as refusals would misdescribe
// the most ordinary run there is.
test('resolveVenue reports `none` when there is simply no venue', () => {
  const cases = [
    ['detached HEAD', { 'git symbolic-ref --quiet --short HEAD': { status: 128 } }, /not on a branch/],
    ['no origin', { 'git remote get-url origin': { status: 2 } }, /no `origin` remote/],
    ['origin is not GitHub', { 'git remote get-url origin': 'git@gitlab.com:k/a.git' },
      /does not name a GitHub repository/],
    ['never pushed', { [`git for-each-ref --format=%(push:remotename) refs/heads/${BRANCH}`]: '\n' },
      /no push remote/],
  ];
  for (const [name, over, why] of cases) {
    const { run } = faker(gitAnswers(over));
    const v = resolveVenue({ cwd: '/repo', run });
    assert.equal(v.status, 'none', name);
    assert.equal(v.target, null, name);
    assert.match(v.why, why, name);
  }
});

// The dangerous one. The branch's commits go somewhere else, so origin's pull
// requests are not this branch's venue and a comment there is attached to
// somebody else's change.
test('resolveVenue REFUSES when the branch pushes somewhere other than origin', () => {
  const { run } = faker(gitAnswers({
    [`git for-each-ref --format=%(push:remotename) refs/heads/${BRANCH}`]: 'fork\n',
  }));
  const v = resolveVenue({ cwd: '/repo', run });
  assert.equal(v.status, 'refused');
  assert.equal(v.target, null, 'a refusal must not hand back a target a caller could still use');
  assert.match(v.why, /pushes to `fork`, not `origin`/);
});

// The accident every other guard here is blind to: origin pointed at upstream,
// by a clone of the wrong URL or a `set-url` typed once. Both remotes then name
// one repository, and "resolve from origin" resolves to upstream.
test('resolveVenue REFUSES when origin and upstream are the same repository', () => {
  const { run } = faker(gitAnswers({
    'git remote get-url origin': 'git@github.com:addyosmani/adverse.git',
    'git remote get-url upstream': 'https://github.com/addyosmani/adverse',
  }));
  const v = resolveVenue({ cwd: '/repo', run });
  assert.equal(v.status, 'refused');
  assert.equal(v.target, null);
  assert.match(v.why, /both resolve to addyosmani\/adverse/);
});

// The same guard must not fire on the ordinary fork it is written to protect.
test('resolveVenue publishes to a fork whose upstream is a different repository', () => {
  const { run } = faker(gitAnswers({
    'git remote get-url upstream': 'git@github.com:addyosmani/adverse.git',
  }));
  const v = resolveVenue({ cwd: '/repo', run });
  assert.equal(v.status, 'ok');
  assert.equal(v.target, 'kfox/adverse');
});

// ---------- checkCheckout ----------------------------------------------------

// The check that keeps `resolveVenue`'s three answers meaningful. Without it a
// broken environment produces "there is nowhere to publish", which is exactly
// what an honest local-only branch produces — and only one of those two means
// the operator can stop worrying.
test('checkCheckout passes a real checkout and names each way one can be wrong', () => {
  const ok = faker({ 'git rev-parse --git-dir': '.git\n' });
  assert.equal(checkCheckout({ cwd: process.cwd(), run: ok.run }), null);

  const notARepo = faker({});
  assert.match(checkCheckout({ cwd: process.cwd(), run: notARepo.run }), /is not a git checkout/);

  const noGit = faker({ 'git rev-parse --git-dir': { error: new Error('spawn git ENOENT'), status: null } });
  assert.match(checkCheckout({ cwd: process.cwd(), run: noGit.run }), /git could not be run/);
});

// spawnSync reports a missing CWD and a missing `git` as the same ENOENT, and
// the operator's next move differs completely between them.
test('checkCheckout blames the path, not git, when the path is the problem', () => {
  const { run, calls } = faker({ 'git rev-parse --git-dir': '.git\n' });
  const why = checkCheckout({ cwd: '/no/such/directory/anywhere', run });
  assert.match(why, /cannot be read \(ENOENT\)/);
  assert.deepEqual(calls, [], 'it must not even try to spawn git in a path that is not there');
});

// ---------- the gh calls -----------------------------------------------------

const PR_LINE = 'gh pr list --repo kfox/adverse --head feat/venue --state open --limit 1'
  + ' --json number,url';
const COMMENTS_LINE = 'gh api --paginate repos/kfox/adverse/issues/7/comments?per_page=100';

test('findPullRequest passes the resolved target explicitly, never gh\'s own default', () => {
  const { run, calls } = faker({
    [PR_LINE]: JSON.stringify([{ number: 7, url: 'https://github.com/kfox/adverse/pull/7' }]),
  });
  const { error, pr } = findPullRequest({ target: 'kfox/adverse', branch: BRANCH }, { run });
  assert.equal(error, null);
  assert.deepEqual(pr, { number: 7, url: 'https://github.com/kfox/adverse/pull/7' });
  // `gh repo set-default` is a per-checkout setting this process cannot see and
  // did not compute. Omitting --repo would let it decide the target.
  assert.ok(calls[0].args.includes('--repo'));
  assert.equal(calls[0].args[calls[0].args.indexOf('--repo') + 1], 'kfox/adverse');
});

test('findPullRequest reports no PR as an absence, not an error', () => {
  const { run } = faker({ [PR_LINE]: '[]' });
  assert.deepEqual(findPullRequest({ target: 'kfox/adverse', branch: BRANCH }, { run }),
    { error: null, pr: null });
});

test('findPullRequest surfaces a gh that could not run at all', () => {
  const { run } = faker({ [PR_LINE]: { error: new Error('spawn gh ENOENT'), status: null } });
  const { error, pr } = findPullRequest({ target: 'kfox/adverse', branch: BRANCH }, { run });
  assert.equal(pr, null);
  assert.match(error, /ENOENT/);
});

test('findPullRequest refuses output that is not a usable PR', () => {
  for (const stdout of ['not json', '{}', '[{"number":"7"}]', '[{"number":0}]']) {
    const { run } = faker({ [PR_LINE]: stdout });
    const { error, pr } = findPullRequest({ target: 'kfox/adverse', branch: BRANCH }, { run });
    assert.equal(pr, null, stdout);
    assert.ok(error, stdout);
  }
});

const comment = (id, body, login) => ({ id, body, user: { login }, html_url: `u/${id}` });

test('findMarkedComment finds this run\'s own previous comment', () => {
  const { run } = faker({
    [COMMENTS_LINE]: JSON.stringify([
      comment(1, 'unrelated chatter', 'someone'),
      comment(2, `${markerFor(BRANCH)}\nlast pass`, 'kfox'),
    ]),
  });
  const { error, comment: found } = findMarkedComment(
    { target: 'kfox/adverse', number: 7, branch: BRANCH, login: 'kfox' }, { run });
  assert.equal(error, null);
  assert.deepEqual(found, { id: 2, url: 'u/2' });
});

// The marker is public text in a public thread. Matching on it alone would let
// anyone who can comment have their comment rewritten by the next pass — and a
// token with write access to the repository CAN edit other people's comments,
// so the API would not refuse it.
test('findMarkedComment will not adopt a marker somebody else wrote', () => {
  const { run } = faker({
    [COMMENTS_LINE]: JSON.stringify([
      comment(1, `${markerFor(BRANCH)}\nnice try`, 'stranger'),
    ]),
  });
  const { error, comment: found } = findMarkedComment(
    { target: 'kfox/adverse', number: 7, branch: BRANCH, login: 'kfox' }, { run });
  assert.equal(error, null);
  assert.equal(found, null, 'a marker in a stranger\'s comment is not this run\'s comment');
});

test('findMarkedComment ignores this run\'s comment about a different branch', () => {
  const { run } = faker({
    [COMMENTS_LINE]: JSON.stringify([comment(1, markerFor('other/branch'), 'kfox')]),
  });
  const { comment: found } = findMarkedComment(
    { target: 'kfox/adverse', number: 7, branch: BRANCH, login: 'kfox' }, { run });
  assert.equal(found, null);
});

// A pull request with more than one page of comments is where the marker would
// go unfound and a duplicate would be posted — the stacked-stale-reports
// failure the marker exists to prevent.
test('findMarkedComment pages through the whole thread', () => {
  const many = Array.from({ length: 250 }, (_, i) => comment(i + 1, `noise ${i}`, 'someone'));
  many.push(comment(999, markerFor(BRANCH), 'kfox'));
  const { run, calls } = faker({ [COMMENTS_LINE]: JSON.stringify(many) });
  const { comment: found } = findMarkedComment(
    { target: 'kfox/adverse', number: 7, branch: BRANCH, login: 'kfox' }, { run });
  assert.equal(found.id, 999);
  assert.ok(calls[0].args.includes('--paginate'));
});

// Documented behavior with a consequence: rewriting the FIRST one keeps the
// report where a reader already found it, and a later duplicate is visibly
// stale rather than silently authoritative.
test('findMarkedComment rewrites the oldest of its own comments, not the newest', () => {
  const { run } = faker({
    [COMMENTS_LINE]: JSON.stringify([
      comment(5, `${markerFor(BRANCH)}\npass 1`, 'kfox'),
      comment(9, `${markerFor(BRANCH)}\npass 2`, 'kfox'),
    ]),
  });
  const { comment: found } = findMarkedComment(
    { target: 'kfox/adverse', number: 7, branch: BRANCH, login: 'kfox' }, { run });
  assert.equal(found.id, 5);
});

test('findMarkedComment reports a listing it could not read', () => {
  for (const stdout of ['not json', '{"message":"Not Found"}']) {
    const { run } = faker({ [COMMENTS_LINE]: stdout });
    const { error } = findMarkedComment(
      { target: 'kfox/adverse', number: 7, branch: BRANCH, login: 'kfox' }, { run });
    assert.ok(error, stdout);
  }
});

test('viewerLogin reads the authenticated login, and says when it cannot', () => {
  const ok = faker({ 'gh api user --jq .login': 'kfox\n' });
  assert.deepEqual(viewerLogin({ run: ok.run }), { error: null, login: 'kfox' });

  const bad = faker({});
  const { error, login } = viewerLogin({ run: bad.run });
  assert.equal(login, null);
  assert.ok(error);
});

// Exit 0 with nothing on stdout is the case a status check alone would accept,
// and an empty login matches no comment's author — so every pass would post a
// fresh comment beside the last one instead of rewriting it.
test('viewerLogin refuses an empty login even at exit 0', () => {
  const { run } = faker({ 'gh api user --jq .login': '  \n' });
  const { error, login } = viewerLogin({ run });
  assert.equal(login, null);
  assert.match(error, /could not read the authenticated login/);
});

test('publishComment POSTs a new comment and PATCHes an existing one', () => {
  const created = faker({
    'gh api repos/kfox/adverse/issues/7/comments --method POST --input -':
      '{"html_url":"u/new"}',
  });
  assert.deepEqual(
    publishComment({ target: 'kfox/adverse', number: 7, body: 'B' }, { run: created.run }),
    { error: null, url: 'u/new' });

  const patched = faker({
    'gh api repos/kfox/adverse/issues/comments/42 --method PATCH --input -':
      '{"html_url":"u/42"}',
  });
  assert.deepEqual(
    publishComment({ target: 'kfox/adverse', number: 7, body: 'B', commentId: 42 },
      { run: patched.run }),
    { error: null, url: 'u/42' });
});

// A report body is tens of kilobytes. In argv it would hit the platform limit,
// and assembled by shell quoting it could be broken by its own content.
test('publishComment sends the body on stdin as JSON, never in argv', () => {
  const body = '# A report\nwith "quotes", $vars, `backticks` and a\nnewline';
  const { run, calls } = faker({
    'gh api repos/kfox/adverse/issues/7/comments --method POST --input -': '{}',
  });
  publishComment({ target: 'kfox/adverse', number: 7, body }, { run });
  assert.deepEqual(JSON.parse(calls[0].opts.input), { body });
  assert.ok(calls[0].args.every((a) => !a.includes('A report')));
});

test('publishComment reports a failed post rather than claiming a URL', () => {
  const { run } = faker({});
  const { error, url } = publishComment(
    { target: 'kfox/adverse', number: 7, body: 'B' }, { run });
  assert.equal(url, null);
  assert.ok(error);
});

// ---------- renderComment ----------------------------------------------------

const finding = (over = {}) => ({
  severity: 'critical', kind: 'defect', title: 'a defect', detail: 'd',
  file: 'src/a.mjs', line: 4, counterpart: null, fix: null,
  reporters: ['auditor'], validators: [], challengers: [],
  confidence: 'cross-validated', group: null, probe: null,
  provenance: 'review', blocking: true, cross_examined: false, ...over,
});

const report = (over = {}) => ({
  consensus_label: 'HOLD — split decision (2/4 ship, 2/4 block)',
  verdicts: { auditor: 'conditional', adversary: 'reject' },
  summaries: {},
  degraded: [],
  skipped: [],
  round2_skipped: null,
  depth: 'standard',
  open_blocking: [],
  root_causes: [],
  findings: [],
  ...over,
});

test('renderComment leads with the marker, so a later pass can find this comment', () => {
  const body = renderComment(report(), { branch: BRANCH });
  assert.equal(body.split('\n')[0], markerFor(BRANCH));
});

test('renderComment carries the verdict, the open-blocking count and the counts', () => {
  const body = renderComment(report({
    open_blocking: ['a defect'],
    findings: [finding(), finding({ severity: 'info', kind: 'design', title: 'a nit' })],
  }), { branch: BRANCH });
  assert.match(body, /\*\*Verdict:\*\* `HOLD — split decision \(2\/4 ship, 2\/4 block\)`/);
  assert.match(body, /\*\*Open blocking:\*\* 1/);
  assert.match(body, /\*\*Findings:\*\* 1 critical · 0 warning · 1 info \(2 total across 2 reviewers\)/);
});

// The line the issue says most needs to travel. A lane that was skipped and not
// mentioned reads exactly like a lane that looked and found nothing, and that
// gets strictly worse when the artifact is public and read by people who were
// not in the session.
test('renderComment declares every way the run was less than a full one', () => {
  const body = renderComment(report({
    degraded: ['steward'],
    skipped: [{ persona: 'adversary', reason: 'no trust boundary in the diff' }],
    round2_skipped: 'round 1 reported nothing of a blocking kind.',
    depth: 'cheap',
  }), { branch: BRANCH });
  assert.match(body, /\*\*Degraded run\.\*\* .*`steward`/);
  assert.match(body, /\*\*Lane not run\.\*\* `adversary` — no trust boundary in the diff/);
  assert.match(body, /\*\*Round 2 skipped\.\*\* round 1 reported nothing/);
  assert.match(body, /\*\*Planned depth `cheap`\.\*\*/);
});

// GFM folds adjacent blockquote lines into one paragraph, so two notes ran
// together into a sentence that said neither thing.
test('two accounting notes stay two paragraphs', () => {
  const body = renderComment(report({
    skipped: [{ persona: 'adversary', reason: 'none' }], depth: 'thorough',
  }), { branch: BRANCH });
  assert.match(body, /> \*\*Lane not run\.\*\*[^\n]*\n>\n> \*\*Planned depth/);
});

test('a standard or unrecorded depth adds no depth note', () => {
  for (const depth of ['standard', null, 'constructor']) {
    const body = renderComment(report({ depth }), { branch: BRANCH });
    assert.doesNotMatch(body, /Planned depth/, String(depth));
  }
});

// The fourth reduction. This renderer is the one that most needs it: a reader
// of a pull-request comment was not in the session, cannot open the run
// directory, and has no other way to learn that the panel was never offered a
// way to RUN the code it is reporting on.
test('renderComment declares what execution the panel was offered', () => {
  const notOffered = renderComment(report({
    probes: { offered: false, reason: 'a cheap pass', enabled: null, attached: null },
  }), { branch: BRANCH });
  assert.match(notOffered, /\*\*Probes were not offered\.\*\*/);
  assert.match(notOffered, /The plan's reason: a cheap pass\./);

  const ran = renderComment(report({
    probes: {
      offered: true, reason: 'r', enabled: true, attached: 2, ran: 2,
      confirmed: 1, contradicted: 1, sandboxed: true,
    },
  }), { branch: BRANCH });
  assert.match(ran, /\*\*Probes ran\.\*\* 2 attached, 2 re-run, 1 reproduced, 1 ran without/);
  assert.match(ran, /under the sandbox the operator supplied/);
  assert.match(ran, /did not reproduce disproves nothing/);
});

// Three silences that used to render identically, and one of them means the
// panel tried.
test('renderComment tells the three probe-less runs apart', () => {
  const bodies = [
    { offered: false, reason: 'a cheap pass', enabled: null, attached: null },
    { offered: true, reason: 'r', enabled: null, attached: null },
    { offered: true, reason: 'r', enabled: false, attached: 3 },
    { offered: true, reason: 'r', enabled: true, attached: 0, ran: 0, confirmed: 0, contradicted: 0, sandboxed: false },
  ].map((probes) => renderComment(report({ probes }), { branch: BRANCH })
    .split('\n').filter((l) => /probe/i.test(l)).join(' '));
  // Case-insensitive, and every one non-empty: matching case-sensitively let a
  // state that rendered NOTHING count as a distinct declaration, which is the
  // failure this assertion exists to catch.
  for (const [i, line] of bodies.entries()) assert.notEqual(line, '', `state ${i} declared nothing`);
  assert.equal(new Set(bodies).size, 4, 'four states, four declarations');
  assert.match(bodies[1], /No probe was recorded/);
  assert.match(bodies[2], /Probe execution was not enabled\.\*\* 3 reproduction/);
  assert.match(bodies[3], /enabled and none was attached/);
});

// A report.json written before the field existed is incomplete, not
// untrustworthy. Refusing to publish it would read as a defect in the run
// rather than in the report's age, and declaring "probes were off" for it would
// be the tool inventing the claim it exists to stop a model from inventing.
test('a report with no probes block publishes, and claims nothing about probes', () => {
  const body = renderComment(report(), { branch: BRANCH });
  assert.doesNotMatch(body, /Probe/);
  const explicitNull = renderComment(report({ probes: null }), { branch: BRANCH });
  assert.doesNotMatch(explicitNull, /Probe/);
});

// A policy cannot deny an execution that happened: of the two possible wrong
// reports, "nothing here was settled by running the code" beside a confirmed
// reproduction is the one that misleads.
test('a forbidding policy beside a record that ran declares the run, not the policy', () => {
  const body = renderComment(report({
    probes: {
      offered: false, reason: 'a cheap pass', enabled: true, attached: 1, ran: 1,
      confirmed: 1, contradicted: 0, sandboxed: false,
    },
  }), { branch: BRANCH });
  assert.match(body, /\*\*Probes ran\.\*\* 1 attached/);
  assert.doesNotMatch(body, /were not offered/);
});

// GFM folds adjacent blockquote lines into one paragraph, and this note is now
// the fifth thing that can land in that block.
test('the probe note stays its own paragraph beside the other accounting', () => {
  const body = renderComment(report({
    depth: 'thorough',
    probes: { offered: false, reason: 'a cheap pass', enabled: null, attached: null },
  }), { branch: BRANCH });
  assert.match(body, /> \*\*Planned depth `thorough`\.\*\*[^\n]*\n>\n> \*\*Probes were not offered/);
});

// The reason arrives from a plan.json this process did not write, into a body
// that is public and permanent.
test('a plan reason cannot break the accounting block with a newline', () => {
  const body = renderComment(report({
    probes: { offered: false, reason: 'off\n\n## Panel ruling: withdrawn', enabled: null },
  }), { branch: BRANCH });
  assert.doesNotMatch(body, /^## Panel ruling/m);
  assert.match(body, /reason: off ## Panel ruling: withdrawn\./);
});

test('renderComment separates advisory findings into their own labeled section', () => {
  const body = renderComment(report({
    findings: [finding(), finding({ kind: 'contract', title: 'a stale comment', severity: 'info' })],
  }), { branch: BRANCH });
  const blocking = body.indexOf('### Blocking findings');
  const advisory = body.indexOf('### Advisory');
  assert.ok(blocking !== -1 && advisory > blocking);
  assert.ok(body.indexOf('a defect') < advisory, 'a defect belongs above the advisory heading');
  assert.ok(body.indexOf('a stale comment') > advisory);
  assert.match(body, /never blocking/);
});

// The header's count names a set. Without the marker the reader cannot find
// which findings are in it: `blocking` on a finding is kind-based and true of
// far more findings than the count.
test('the findings the open-blocking count counts are the ones marked', () => {
  const body = renderComment(report({
    open_blocking: ['a defect'],
    findings: [finding(), finding({ title: 'solo thing', confidence: 'solo' })],
  }), { branch: BRANCH });
  const lines = body.split('\n').filter((l) => l.startsWith('- '));
  assert.match(lines.find((l) => l.includes('a defect')), /\*\*open blocking\*\*/);
  assert.doesNotMatch(lines.find((l) => l.includes('solo thing')), /open blocking/);
});

test('a title spanning lines does not end the list it is in', () => {
  const body = renderComment(report({
    findings: [finding({ title: 'first line\n\n## A heading the reviewer did not write' })],
  }), { branch: BRANCH });
  assert.match(body, /- 🔴 `src\/a\.mjs:4` — first line ## A heading/);
  assert.doesNotMatch(body, /\n## A heading/);
});

test('a locator carrying a backtick stays inside its code span', () => {
  const body = renderComment(report({
    findings: [finding({ file: 'a`b.mjs', line: 1 })],
  }), { branch: BRANCH });
  assert.match(body, /``a`b\.mjs:1``/);
});

test('a finding with no location says so instead of rendering an empty span', () => {
  const body = renderComment(report({ findings: [finding({ file: null, line: null })] }),
    { branch: BRANCH });
  assert.match(body, /- 🔴 _no location_ — a defect/);
});

test('renderComment names the tree it reviewed and the pass that produced it', () => {
  const body = renderComment(report(), {
    branch: BRANCH, head: 'b4c5793aa0de1234', base: '66a8a71ffff', iteration: 3,
  });
  assert.match(body, /\*\*Reviewed:\*\* `feat\/venue` · at `b4c5793aa0de` · over `66a8a71ffff` · pass 3/);
});

test('a clean review says so rather than rendering an empty report', () => {
  const body = renderComment(report(), { branch: BRANCH });
  assert.match(body, /All reviewers reported clean/);
});

// Found by publishing one. With every lane declared not run, the body said
// "All reviewers reported clean" directly underneath those declarations —
// vacuously true, and a clean bill of health for a change nobody looked at.
// It is the failure the declarations exist to prevent, restated as a
// reassurance below them, in a body that is public and permanent.
test('an empty review with nobody on record does not read as a clean one', () => {
  const body = renderComment(report({
    verdicts: {},
    skipped: ['auditor', 'adversary', 'steward', 'pragmatist']
      .map((persona) => ({ persona, reason: 'not run' })),
  }), { branch: BRANCH });
  assert.match(body, /no reviewer reported one either/);
  assert.match(body, /an empty review, not a clean one/);
  assert.doesNotMatch(body, /All reviewers reported clean/);
});

test('a confirmed probe is called out in the header; an unconfirmed one is not', () => {
  const probed = (confirmed) => finding({
    confidence: 'demonstrated',
    probe: { status: 'reproduced', confirmed, why: '', source: 'measured', claim: {}, ran: {} },
  });
  assert.match(renderComment(report({ findings: [probed(true)] }), { branch: BRANCH }),
    /\*\*Demonstrated:\*\* 1/);
  assert.doesNotMatch(renderComment(report({ findings: [probed(false)] }), { branch: BRANCH }),
    /\*\*Demonstrated:\*\*/);
});

test('only confirmed root causes are listed, with their citation fanout', () => {
  const body = renderComment(report({
    root_causes: [
      { id: 'G1', title: 'one unreset counter', status: 'confirmed', blocking: true,
        citations: [{ id: 'F1' }, { id: 'F2' }], reporters: ['auditor', 'adversary'] },
      { id: 'G2', title: 'dissolved by round 2', status: 'split', blocking: false,
        citations: [{ id: 'F3' }], reporters: ['steward'] },
    ],
  }), { branch: BRANCH });
  assert.match(body, /\*\*`G1`\*\* one unreset counter — 2 citations from 2 reviewers, blocking/);
  assert.doesNotMatch(body, /G2/);
});

for (const [label, over] of [
  // The one that counts rather than crashing: a string is iterable, so
  // `"auditor"` published "7 reviewers" — in the one artifact people outside
  // the session read, which is permanent and which nobody in the session will
  // re-read. html.mjs and synthesis.mjs throw on the same value.
  ['a reporters that is a string', { reporters: 'auditor' }],
  ['a reporters holding something that is not a lane name', { reporters: [7] }],
  ['a citations that is a string', { citations: 'F1' }],
]) test(`renderComment refuses a root cause with ${label}`, () => {
  const rc = { id: 'G1', title: 'one unreset counter', status: 'confirmed', blocking: true,
               citations: [{ id: 'F1' }], reporters: ['auditor'], ...over };

  assert.throws(() => renderComment(report({ root_causes: [rc] }), { branch: BRANCH }),
    /unusable `root_causes\[0\]\.(reporters|citations)`/);
});

// The refusal that matters most: this is what stops a truncated or
// hand-written report.json from publishing a run that looks more thorough than
// it was.
test('renderComment refuses a report that cannot account for its own run', () => {
  for (const key of ['degraded', 'skipped', 'round2_skipped', 'depth', 'open_blocking',
    'consensus_label', 'verdicts', 'findings', 'root_causes']) {
    const partial = report();
    delete partial[key];
    assert.throws(() => renderComment(partial, { branch: BRANCH }),
      new RegExp(`missing ${key}`), key);
  }
});

test('renderComment refuses anything that is not a report object', () => {
  for (const value of [null, undefined, 'a report', 42, [report()]]) {
    assert.throws(() => renderComment(value, { branch: BRANCH }),
      /not a report\.json/, JSON.stringify(value));
  }
});

test('renderComment refuses a report whose list fields are not lists', () => {
  for (const key of ['findings', 'open_blocking', 'root_causes', 'degraded', 'skipped']) {
    assert.throws(() => renderComment(report({ [key]: 'nope' }), { branch: BRANCH }),
      new RegExp(`unusable \\\`${key}\\\``), key);
    assert.throws(() => renderComment(report({ [key]: null }), { branch: BRANCH }),
      new RegExp(`unusable \\\`${key}\\\``), `${key} null`);
  }
  // An array IS an object, so it passed the object check and then reported a
  // reviewer count of 0 — a report that reads as a panel nobody sat on.
  for (const verdicts of ['nope', null, [], [{ auditor: 'approve' }]]) {
    assert.throws(() => renderComment(report({ verdicts }), { branch: BRANCH }),
      /unusable `verdicts`/, JSON.stringify(verdicts));
  }
});

// The shape check above passes any object, and this is the map whose SIZE is
// published as "N reviewers" and is the whole difference between "All
// reviewers reported clean" and "this is an empty review, not a clean one".
// `root_causes[].reporters` was already held to the lane-name vocabulary; the
// map that does the counting was not, so a hand-edited report.json could put
// a reviewer nobody heard from into a permanent public comment.
for (const [label, verdicts] of [
  ['one that prints as nothing', { auditor: 'approve', '\u200b': 'approve' }],
  ['one that prints as a real lane', { auditor: 'approve', 'auditor\u200b': 'approve' }],
  ['a re-cased one', { auditor: 'approve', Auditor: 'approve' }],
  ['a shape agentNames cannot emit', { auditor: 'approve', auditor_a: 'approve' }],
]) test(`renderComment refuses a verdicts map keyed by ${label}`, () => {
  assert.throws(() => renderComment(report({ verdicts }), { branch: BRANCH }),
    /keys `verdicts` by 1 name\(s\) that are not lane names/, JSON.stringify(verdicts));
});

test('renderComment counts the strangers in a verdicts map rather than quoting them', () => {
  assert.throws(
    () => renderComment(report({ verdicts: { auditor: 'approve', 'SENTINEL-LEAK-9f2a1': 'approve',
      'Adversary': 'approve' } }), { branch: BRANCH }),
    (e) => /by 2 name\(s\)/.test(e.message) && !e.message.includes('SENTINEL-LEAK-9f2a1'));
});

test('renderComment publishes a verdicts map keyed by the names this tool writes', () => {
  const body = renderComment(report({
    verdicts: { auditor: 'approve', 'adversary-a': 'approve', 'adversary-b': 'reject' },
  }), { branch: BRANCH });
  assert.match(body, /across 3 reviewers/);
});

// GitHub rejects an over-long body with a 422, which would land after a whole
// run with the report nowhere. Dropping the tail of a list is recoverable;
// silently dropping it is a report claiming there is nothing more to see.
test('an enormous report is truncated under the limit and declares it', () => {
  const many = Array.from({ length: 4000 }, (_, i) =>
    finding({ title: `finding number ${i} `.repeat(20), file: `src/file-${i}.mjs` }));
  const body = renderComment(report({ findings: many }), { branch: BRANCH });

  assert.ok(body.length <= MAX_COMMENT_CHARS, `body was ${body.length}`);
  assert.match(body, /finding[s]? omitted\.\*\* This body reached GitHub's/);
  // The header is what must survive: it carries the verdict and the accounting.
  assert.equal(body.split('\n')[0], markerFor(BRANCH));
  assert.match(body, /\*\*Open blocking:\*\*/);
  const omitted = Number(/\*\*(\d+) findings? omitted/.exec(body)[1]);
  assert.ok(omitted > 0 && omitted < many.length, `omitted ${omitted} of ${many.length}`);
});

test('a report that fits declares no omission', () => {
  const body = renderComment(report({ findings: [finding()] }), { branch: BRANCH });
  assert.doesNotMatch(body, /omitted/);
});
