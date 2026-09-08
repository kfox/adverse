// Tests for skills/adverse-review/scripts/publish.mjs — the Phase 10 bridge.
//
// The predicates are proven in-process in tests/publish.test.mjs and are not
// repeated here. What only exists at the process boundary is the part below:
// the exit-code contract, that a refused venue posts NOTHING rather than
// posting a warning, that there is no argument anywhere that can name a target
// repository, that a dry run is the default and reaches no write endpoint, and
// that a second pass rewrites the comment the first pass left instead of
// stacking a second one.
//
// `gh` is a fake on PATH that logs every invocation, so the writes are asserted
// by their absence as much as by their presence.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLISH = path.join(here, '..', 'skills', 'adverse-review', 'scripts', 'publish.mjs');

const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };

// A `gh` that answers from its environment and records what it was asked. The
// scenario is set per test; anything unset answers empty, which is what a
// repository with no pull request and no comments looks like.
const FAKE_GH = `#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
const argv = process.argv.slice(2);
appendFileSync(process.env.GH_LOG, argv.join(' ') + '\\n');
const fails = (process.env.GH_FAIL ?? '').split(',');
const die = (m) => { process.stderr.write(m + '\\n'); process.exit(1); };

if (argv[0] === 'pr' && argv[1] === 'list') {
  if (fails.includes('pr')) die('gh: could not resolve to a Repository');
  process.stdout.write(process.env.GH_PRS ?? '[]');
} else if (argv[0] === 'api' && argv[1] === 'user') {
  if (fails.includes('user')) die('gh: not logged in');
  process.stdout.write((process.env.GH_LOGIN ?? 'runner') + '\\n');
} else if (argv[0] === 'api' && argv.includes('--paginate')) {
  if (fails.includes('comments')) die('gh: HTTP 404');
  process.stdout.write(process.env.GH_COMMENTS ?? '[]');
} else if (argv[0] === 'api' && argv.includes('--input')) {
  if (fails.includes('write')) die('gh: HTTP 422 Unprocessable Entity');
  const body = JSON.parse(readFileSync(0, 'utf-8')).body;
  appendFileSync(process.env.GH_LOG, 'BODY ' + JSON.stringify(body) + '\\n');
  process.stdout.write(JSON.stringify({ html_url: 'https://example.invalid/c/1' }));
} else {
  die('gh: unexpected invocation: ' + argv.join(' '));
}
`;

const REPORT = {
  consensus_label: 'HOLD — split decision (2/4 ship, 2/4 block)',
  verdicts: { auditor: 'conditional', adversary: 'reject' },
  summaries: {},
  degraded: [],
  skipped: [{ persona: 'pragmatist', reason: 'small diff; design findings are advisory' }],
  round2_skipped: null,
  depth: 'standard',
  head: 'abcdef1234567890',
  base: '0987654321fedcba',
  open_blocking: ['a defect'],
  root_causes: [],
  findings: [{
    severity: 'critical', kind: 'defect', title: 'a defect', detail: 'd',
    file: 'src/a.mjs', line: 4, counterpart: null, fix: null,
    reporters: ['auditor'], validators: [], challengers: [],
    confidence: 'cross-validated', group: null, probe: null,
    provenance: 'review', blocking: true, cross_examined: false,
  }],
};

// A checkout on branch `topic`, plus a bin directory holding the fake `gh`.
function fixture({ origin = 'git@github.com:kfox/adverse.git', pushRemote = 'origin',
  upstream = null, remotes = {}, report = REPORT } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'adverse-publish-'));
  const repo = path.join(root, 'repo');
  const bin = path.join(root, 'bin');
  execFileSync('mkdir', ['-p', repo, bin]);

  const git = (...args) => execFileSync('git', args, {
    cwd: repo, env: { ...process.env, ...GIT_ENV }, encoding: 'utf-8',
  });
  git('init', '-q', '-b', 'topic');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  git('add', '.');
  git('commit', '-qm', 'one');

  if (origin) git('remote', 'add', 'origin', origin);
  if (upstream) git('remote', 'add', 'upstream', upstream);
  for (const [name, url] of Object.entries(remotes)) git('remote', 'add', name, url);
  if (pushRemote) git('config', 'branch.topic.pushRemote', pushRemote);

  const gh = path.join(bin, 'gh');
  writeFileSync(gh, FAKE_GH);
  chmodSync(gh, 0o755);

  const reportPath = path.join(root, 'report.json');
  writeFileSync(reportPath, JSON.stringify(report));

  return { root, repo, bin, report: reportPath, log: path.join(root, 'gh.log') };
}

function run(fx, args, env = {}) {
  const r = spawnSync(process.execPath, [PUBLISH, ...args], {
    cwd: fx.repo,
    encoding: 'utf-8',
    env: {
      ...process.env, ...GIT_ENV,
      PATH: `${fx.bin}${path.delimiter}${process.env.PATH}`,
      GH_LOG: fx.log,
      ...env,
    },
  });
  return { ...r, gh: existsSync(fx.log) ? readFileSync(fx.log, 'utf-8').trim().split('\n') : [] };
}

const onePr = JSON.stringify([{ number: 7, url: 'https://github.com/kfox/adverse/pull/7' }]);
const marker = '<!-- adverse:run branch=topic -->';

// ---------- usage ------------------------------------------------------------

test('publish refuses to run without a report and a checkout', () => {
  const fx = fixture();
  for (const args of [[], ['--report', fx.report], ['--repo', fx.repo]]) {
    const r = run(fx, args);
    assert.equal(r.status, 2, args.join(' '));
    assert.match(r.stderr, /Usage: publish\.mjs/);
  }
});

// The load-bearing absence. Every other bridge here takes `--repo <dir>`, and
// this one must never grow a sibling that names a repository on GitHub: that
// argument is what an agent acting alone would fill in wrongly.
test('there is no argument anywhere that can name a target repository', () => {
  const fx = fixture();
  for (const flag of ['--target', '--owner', '--pr', '--base', '--upstream', '--remote']) {
    const r = run(fx, ['--report', fx.report, '--repo', fx.repo, flag, 'addyosmani/adverse']);
    assert.equal(r.status, 2, flag);
    assert.deepEqual(r.gh, [], `${flag} must not reach gh`);
  }
  // `--repo` itself is a directory, so a repository name given to it resolves
  // as a path and finds no checkout. That is exit 2 and it says so — NOT a
  // quiet "nothing to publish", which would read as a successful run that
  // simply had nowhere to go.
  const r = run(fx, ['--report', fx.report, '--repo', 'addyosmani/adverse']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /cannot be read \(ENOENT\)/);
  assert.deepEqual(r.gh, []);
});

// The two ways `--repo` can be wrong have different remedies, so they get
// different sentences rather than one that covers both: spawnSync reports a
// missing CWD and a missing `git` as the same ENOENT.
test('a directory that is not a checkout says so, rather than blaming git', () => {
  const fx = fixture();
  const r = run(fx, ['--report', fx.report, '--repo', fx.root]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /is not a git checkout/);
  assert.deepEqual(r.gh, []);
});

test('--iteration must be a pass number', () => {
  const fx = fixture();
  for (const bad of ['0', 'two', '1.5']) {
    const r = run(fx, ['--report', fx.report, '--repo', fx.repo, '--iteration', bad]);
    assert.equal(r.status, 2, bad);
    assert.match(r.stderr, /pass number of 1 or more/, bad);
  }
  // A negative value never reaches the check: parseArgs refuses a string
  // option whose value looks like an option. Same exit code, different
  // sentence, and the usage text follows either way.
  const negative = run(fx, ['--report', fx.report, '--repo', fx.repo, '--iteration', '-1']);
  assert.equal(negative.status, 2);
  assert.match(negative.stderr, /Usage: publish\.mjs/);
});

test('--help answers at exit 0 and touches nothing', () => {
  const fx = fixture();
  const r = run(fx, ['--help']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Usage: publish\.mjs/);
  assert.deepEqual(r.gh, []);
});

// ---------- the report -------------------------------------------------------

test('an unreadable report is exit 2 — nothing was established', () => {
  const fx = fixture();
  const r = run(fx, ['--report', path.join(fx.root, 'nope.json'), '--repo', fx.repo]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /nope\.json/);
  assert.deepEqual(r.gh, []);
});

// Exit 1, not 2: the file was read fine. What failed is its fitness to be
// published, and publishing it would put a run that looks more thorough than it
// was somewhere permanent and public.
test('a report that cannot account for its own run is exit 1, and posts nothing', () => {
  const { skipped, ...noAccounting } = REPORT;
  const fx = fixture({ report: noAccounting });
  const r = run(fx, ['--report', fx.report, '--repo', fx.repo, '--publish'],
    { GH_PRS: onePr });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /missing skipped/);
  assert.deepEqual(r.gh, []);
});

// ---------- refusals ---------------------------------------------------------

test('a branch that pushes somewhere other than origin is refused, and gh never runs', () => {
  const fx = fixture({ pushRemote: 'fork', remotes: { fork: 'git@github.com:someone/adverse.git' } });
  const r = run(fx, ['--report', fx.report, '--repo', fx.repo, '--publish'], { GH_PRS: onePr });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /pushes to `fork`, not `origin`/);
  assert.deepEqual(r.gh, [], 'a refusal must not reach the network at all');
});

test('an origin that has become its own upstream is refused, and gh never runs', () => {
  const fx = fixture({
    origin: 'git@github.com:addyosmani/adverse.git',
    upstream: 'https://github.com/addyosmani/adverse',
  });
  const r = run(fx, ['--report', fx.report, '--repo', fx.repo, '--publish'], { GH_PRS: onePr });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /both resolve to addyosmani\/adverse/);
  assert.deepEqual(r.gh, []);
});

// ---------- nowhere to publish ----------------------------------------------

// Reviewing uncommitted changes on a branch with no pull request is a
// first-class use of this tool, not a degraded one. It exits 0 and still shows
// the body, so the run is not silently worthless.
test('a branch that has never been pushed exits 0 and prints the body', () => {
  const fx = fixture({ pushRemote: null });
  const r = run(fx, ['--report', fx.report, '--repo', fx.repo]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /no push remote/);
  assert.ok(r.stdout.includes(marker));
  assert.deepEqual(r.gh, []);
});

test('a repository with no open pull request for the branch exits 0', () => {
  const fx = fixture();
  const r = run(fx, ['--report', fx.report, '--repo', fx.repo, '--publish'], { GH_PRS: '[]' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /has no open pull request for topic/);
  assert.ok(r.gh.every((l) => !l.includes('--input')), 'nothing may be written');
});

// ---------- the dry run ------------------------------------------------------

test('the default is a dry run: it prints the exact body and reaches no write endpoint', () => {
  const fx = fixture();
  const r = run(fx, ['--report', fx.report, '--repo', fx.repo, '--iteration', '2'],
    { GH_PRS: onePr });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /DRY RUN\. Would comment on kfox\/adverse#7/);
  assert.match(r.stdout, /Re-run with --publish/);
  assert.ok(r.stdout.includes(marker));
  assert.match(r.stdout, /pass 2/);
  assert.equal(r.gh.length, 1, `only the PR lookup should have run: ${r.gh.join(' | ')}`);
  assert.match(r.gh[0], /^pr list --repo kfox\/adverse --head topic/);
});

test('--repo is passed to gh explicitly, so gh repo set-default cannot decide the target', () => {
  const fx = fixture();
  const r = run(fx, ['--report', fx.report, '--repo', fx.repo], { GH_PRS: onePr });
  assert.match(r.gh[0], /--repo kfox\/adverse/);
});

test('--out writes the body to disk, and an unwritable --out is exit 2', () => {
  const fx = fixture();
  const out = path.join(fx.root, 'body.md');
  const ok = run(fx, ['--report', fx.report, '--repo', fx.repo, '--out', out], { GH_PRS: onePr });
  assert.equal(ok.status, 0);
  assert.ok(readFileSync(out, 'utf-8').startsWith(marker));

  const bad = run(fx, ['--report', fx.report, '--repo', fx.repo,
    '--out', path.join(fx.root, 'no', 'such', 'dir', 'body.md')], { GH_PRS: onePr });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /cannot be written/);
});

// ---------- publishing -------------------------------------------------------

test('--publish posts the report when the pull request has no previous comment', () => {
  const fx = fixture();
  const r = run(fx, ['--report', fx.report, '--repo', fx.repo, '--publish'],
    { GH_PRS: onePr, GH_COMMENTS: '[]' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /posted the report on kfox\/adverse#7/);
  const write = r.gh.find((l) => l.includes('--input'));
  assert.match(write, /^api repos\/kfox\/adverse\/issues\/7\/comments --method POST/);
  const body = JSON.parse(r.gh.find((l) => l.startsWith('BODY ')).slice(5));
  assert.ok(body.startsWith(marker), 'the fingerprint must be in what is actually posted');
  assert.match(body, /a defect/);
  assert.match(body, /\*\*Lane not run\.\*\* `pragmatist`/);
});

// One comment per branch, rewritten. Without this a five-iteration loop leaves
// five stacked reports, four of them stale — and a stale one goes on saying a
// finding is open long after a later pass closed it.
test('a second pass rewrites the comment the first pass left, and posts nothing new', () => {
  const fx = fixture();
  const r = run(fx, ['--report', fx.report, '--repo', fx.repo, '--publish', '--iteration', '2'], {
    GH_PRS: onePr,
    GH_LOGIN: 'runner',
    GH_COMMENTS: JSON.stringify([
      { id: 11, body: 'a human comment', user: { login: 'reviewer' }, html_url: 'u/11' },
      { id: 22, body: `${marker}\npass 1`, user: { login: 'runner' }, html_url: 'u/22' },
    ]),
  });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /rewrote the report on kfox\/adverse#7/);
  const write = r.gh.find((l) => l.includes('--input'));
  assert.match(write, /^api repos\/kfox\/adverse\/issues\/comments\/22 --method PATCH/);
  assert.ok(!r.gh.some((l) => l.includes('--method POST')), 'no second comment');
});

// The marker is public text anyone with comment access can paste. Adopting it
// on the author's word alone would let a stranger's comment be overwritten —
// and a token with repository write access CAN edit other people's comments.
test('a marker in somebody else\'s comment is not adopted; a new comment is posted', () => {
  const fx = fixture();
  const r = run(fx, ['--report', fx.report, '--repo', fx.repo, '--publish'], {
    GH_PRS: onePr,
    GH_LOGIN: 'runner',
    GH_COMMENTS: JSON.stringify([
      { id: 33, body: `${marker}\nnice try`, user: { login: 'stranger' }, html_url: 'u/33' },
    ]),
  });
  assert.equal(r.status, 0);
  assert.ok(!r.gh.some((l) => l.includes('PATCH')), 'must not rewrite a comment it does not own');
  assert.ok(r.gh.some((l) => l.includes('POST')));
});

// Without the login there is no safe answer to "is this comment mine", so the
// only options are to overwrite a stranger's comment or to stack a duplicate.
// It does neither.
test('an unreadable authenticated login refuses the publish rather than guessing', () => {
  const fx = fixture();
  const r = run(fx, ['--report', fx.report, '--repo', fx.repo, '--publish'],
    { GH_PRS: onePr, GH_FAIL: 'user' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /gh auth status/);
  assert.ok(!r.gh.some((l) => l.includes('--input')));
});

test('a comment listing that could not be read refuses rather than posting a duplicate', () => {
  const fx = fixture();
  const r = run(fx, ['--report', fx.report, '--repo', fx.repo, '--publish'],
    { GH_PRS: onePr, GH_FAIL: 'comments' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /refusing to post/);
  assert.ok(!r.gh.some((l) => l.includes('--input')));
});

test('a failed post is exit 1, not a claimed success', () => {
  const fx = fixture();
  const r = run(fx, ['--report', fx.report, '--repo', fx.repo, '--publish'],
    { GH_PRS: onePr, GH_COMMENTS: '[]', GH_FAIL: 'write' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /422/);
  assert.doesNotMatch(r.stdout, /posted/);
});

// A dry run's contract is to say WHERE it would post. A lookup that failed
// cannot answer that, and exiting 0 would report the publish as ready when
// nothing had been checked. `gh` not being installed arrives here too.
test('a PR lookup that failed is exit 1 in a dry run as well as a publish', () => {
  const fx = fixture();
  for (const args of [[], ['--publish']]) {
    const r = run(fx, ['--report', fx.report, '--repo', fx.repo, ...args], { GH_FAIL: 'pr' });
    assert.equal(r.status, 1, args.join(' '));
    assert.match(r.stderr, /could not resolve to a Repository/);
  }
});

// `gh` missing while git works: the venue resolves, the lookup cannot happen,
// and that is exit 1 with a sentence rather than a stack trace.
test('no gh on PATH is exit 1 with the reason, not a stack trace', () => {
  const fx = fixture();
  const onlyGit = path.join(fx.root, 'gitonly');
  execFileSync('mkdir', ['-p', onlyGit]);
  execFileSync('ln', ['-s', execFileSync('which', ['git'], { encoding: 'utf-8' }).trim(),
    path.join(onlyGit, 'git')]);
  const r = spawnSync(process.execPath, [PUBLISH, '--report', fx.report, '--repo', fx.repo], {
    cwd: fx.repo,
    encoding: 'utf-8',
    env: { ...process.env, ...GIT_ENV, PATH: onlyGit, GH_LOG: fx.log },
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /publish: kfox\/adverse: .*ENOENT/s);
  assert.doesNotMatch(r.stderr, /^\s+at /m, 'no stack trace');
});

// An environment where git itself cannot run must not be reported as "this
// branch has no pull request". Those are the same sentence and only one of them
// means the operator can stop worrying.
test('git that cannot run is exit 2, never a quiet `nothing to publish`', () => {
  const fx = fixture();
  const r = spawnSync(process.execPath, [PUBLISH, '--report', fx.report, '--repo', fx.repo], {
    cwd: fx.repo,
    encoding: 'utf-8',
    env: { ...process.env, ...GIT_ENV, PATH: '/nonexistent', GH_LOG: fx.log },
  });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /git could not be run/);
  assert.doesNotMatch(r.stdout, /nothing to publish/);
});
