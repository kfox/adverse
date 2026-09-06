# Working in this repository

## This is a fork. Never send anything to upstream.

`kfox/adverse` is an experimental fork of
[`addyosmani/adverse`](https://github.com/addyosmani/adverse). It has diverged
substantially and its review findings are about *this* code, not Addy's.

**Every issue and every pull request goes to `kfox/adverse`.** Do not open,
comment on, or otherwise write to `addyosmani/adverse` unless the user asks for
it in that message, naming upstream explicitly. A finding that also reproduces
upstream is still filed here. The README says the same thing under Credits;
this file repeats it because that is not where anyone looks before running a
command.

This is not a style preference. Upstream is another person's project, and an
experimental fork's output arriving there is noise they did not ask for and
nobody can fully undo: GitHub supports deleting issues (admin only), but has
**no deletion for pull requests at all**. A PR opened by mistake is permanent
and public, and closing it is the most that can ever be done.

### How this has gone wrong

Twice, in one week, each time an agent acting alone:

- Three findings filed as issues on `addyosmani/adverse` with an explicit
  `--repo addyosmani/adverse`, while reading findings that cite file paths
  shared with upstream. Closed as not-planned; they were already tracked here.
- A 60-file pull request opened against `addyosmani/adverse`. Withdrawn after
  16 seconds. It cannot be removed and is still there.

### What to do instead

`gh repo set-default` is set to `kfox/adverse`. Per `gh`'s own documentation
that default governs "viewing and creating pull requests" and "viewing and
creating issues", so the safe habit is to **omit `--repo` and let the default
resolve** — or pass `--repo kfox/adverse` explicitly.

Never pass an `addyosmani/adverse` value to `--repo`, to `--base`, or in a
`gh api` path. Before any `gh` command that writes, read the target back and
confirm it is this fork. `git remote -v` is the ground truth: `origin` is the
fork, `upstream` is Addy's.
