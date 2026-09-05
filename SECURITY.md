# Security

## Reporting

Report a vulnerability privately through GitHub's
[Report a vulnerability](https://github.com/kfox/adverse/security/advisories/new)
form. Please do not open a public issue for one.

## Threat model

This tool exists to be pointed at code, so it is worth being explicit about what
it does and does not trust.

**Untrusted input.** Three things are read as data, never as instructions:

- **The diff under review.** It is source code someone wrote, quoted into a
  prompt. A diff that contains text addressed to the reviewing model is a
  prompt-injection attempt, and the persona prompts say so.
- **Model output.** Every round's JSON is schema-validated before anything
  reads a field, and free-text fields are clipped and stripped of control bytes
  before they reach another prompt or the terminal.
- **The ledger and the report on disk.** Both are read back on the next
  iteration. The ledger is bound to the repository by resolving its recorded
  commits, because a commit cannot be forged across repositories; report strings
  rendered to stdout are flattened to one line so they cannot forge a line that
  looks like the tool speaking.

**What this tool does not defend against.** It runs `git` in a repository you
name and writes files to paths you give it, with your privileges. Running it
against a repository you do not trust is running that repository's `.git`
configuration, which is out of scope here — clone it somewhere disposable
first.

**No network calls of its own.** The Node code spawns `git` and reads and writes
files. Reaching a model is the calling agent's job, not this tool's.
