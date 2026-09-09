// Rendering agent-written text into Markdown without letting it become
// Markdown. Split out of synthesis.mjs (issue #78) for the reason taxonomy.mjs
// was split out of prompts.mjs: a second renderer needs these and nothing else
// from that file, and a renderer reaching into 1,400 lines of synthesis logic
// for two escapers is how the escapers end up copied instead of shared.
//
// The rule below was written for a report read in the session that produced it.
// src/publish.mjs now renders the same fields into a pull-request comment, which
// is public, durable, and read by people who were not in that session — so the
// distinction between a value and a sentence stops being one renderer's habit
// and becomes a property both of them import.

import { refuseDirectRun } from './entryGuard.mjs';

refuseDirectRun(import.meta.url);

// Every string these renderers touch arrives in agent-written JSON, and they
// draw one line through them rather than escaping whatever the last incident
// named:
//
//   NAMES A THING -> verbatim. A persona, an agent, a verdict, a finding or
//   group id, a `file`, a `line`, a `counterpart`, a ruling, an off-vocabulary
//   `kind`, and the one-line `summary` the tool signs. None of these has any
//   legitimate markup in it, and the summary is the position where the tool
//   wraps its OWN sentence around payload data, so a construct that renders
//   differently than it was recorded is a lie about the run. `verbatim` below
//   is the whole rule.
//
//   IS PROSE -> rendered as Markdown, on purpose. A finding's `title` and
//   `detail`, a `fix`, a validation, challenge or ruling `reason`, a skip
//   reason, and `round2Skipped`. The prompts ask for sentences in these fields
//   and reviewers legitimately write code spans, lists and emphasis inside
//   them; code-spanning a six-sentence `detail` would cost the report its
//   readability to buy nothing an operator cares about. They are TRUSTED, not
//   overlooked: a reviewer who writes `~~` into a title gets strikethrough,
//   which is a formatting choice inside a block that is already labeled as
//   that reviewer's words. It is not a claim the tool is making.
//
//   That last clause is a CONDITION, not an observation, and `quoted` below is
//   what makes it hold. A prose field rendered after a one-line `> ` prefix is
//   labeled only until its first newline, at which point the rest of it is
//   document body — where a reviewer's sentences are indistinguishable from
//   the tool's. Prose rendered into a container has to be rendered into the
//   whole container.
//
// The HTML renderer (src/html.mjs) makes no such distinction — `esc` runs on
// everything, prose included — because there the alternative is live markup in
// a browser rather than emphasis in a text file.

// Newlines collapsed to spaces, every other whitespace run left alone.
//
// Its own function, and exported, because two callers need it for opposite
// reasons. `verbatim` flattens so a line break cannot break out of a code
// span; a list renderer flattens a title it deliberately does NOT escape, so
// the bullet does not end mid-sentence with the remainder rendering as
// document body.
export function flatten(text) {
  return String(text ?? '').replace(/\s+/g, (run) => (/[\r\n]/.test(run) ? ' ' : run));
}

// A payload-supplied value rendered so GFM interprets none of it.
//
// Neutralization here is a CODE SPAN rather than a list of escaped characters,
// because the list does not close. The verdict cell escaped `|`, collapsed
// newlines, and did nothing else, so a regression payload whose `commit` was
// `abc~~-not-really~~` reached the report through the bridge's own
// `regression pass on ${commits}` sentence and rendered as `abc-not-really`
// struck through: the commit an operator READS differs from the commit the
// tool RECORDED, inside the sentence the tool signs as its own conclusion.
// `www.host/p` in the same position rendered as a live attacker-chosen link.
// Those are two members of a set that also holds `_`, `*`, backticks,
// `[label](url)`, `<img …>`, `#`, and whatever GFM's next extension adds; a
// validator that enumerates them is a fix for the two we thought of. Inside a
// code span GFM parses none of it — the autolink extension included — so the
// construct nobody has thought of yet is covered too.
//
// The fence is CommonMark's rule rather than one fixed backtick: a run one
// longer than the longest run in the text, padded with a space when the text
// starts or ends with a backtick (a reader strips exactly one). The locators
// below WERE wrapped in a bare single backtick, which is a code span a `file`
// of ``a`b`` walks straight out of.
//
// Newlines collapse rather than escape, because there is no spelling of a line
// break that survives a table row, and a value spanning lines in any other
// position is prose this function's callers have already decided it is not.
//
// The collapse is stated as "a whitespace run containing a newline becomes one
// space" rather than as `/\s*[\r\n]+\s*/`, and that is a fix, not a rewording.
// The old shape is two quantifiers over the same class with the second able to
// fail: on a whitespace run holding no newline, `\s*` matched the whole run,
// `[\r\n]+` failed, and the engine backtracked the run away one character at a
// time, from every starting position. Quadratic, and the input is payload-
// supplied — a `file` or a `summary` of 64,000 spaces took 6.5 SECONDS, 256,000
// took 103. The same class this branch already fixed once in src/scope.mjs.
// One greedy quantifier over one class with nothing after it to fail cannot
// backtrack: 2,000,000 spaces now take 1.9 ms, and the output is byte-identical
// on all thirteen cases the two forms were compared over.
//
// The pad also covers a leading or trailing SPACE, not only a backtick.
// CommonMark strips one space from each end of a code span when both ends have
// one, so ` x ` used to render as `x` — the value an operator reads differing
// from the value recorded, which is the whole thing this function exists to
// prevent. Padding makes both ends spaces, which guarantees the strip takes the
// padding rather than the content.
export function verbatim(text) {
  const flat = flatten(text);
  if (flat === '') return '';
  const longest = (flat.match(/`+/g) ?? []).reduce((n, run) => Math.max(n, run.length), 0);
  const fence = '`'.repeat(longest + 1);
  const pad = /^[\s`]|[\s`]$/.test(flat) ? ' ' : '';
  return `${fence}${pad}${flat}${pad}${fence}`;
}

// The same, for a table cell. A `|` splits a GFM row before any inline parser
// runs, code span or not, so it still needs the backslash — which the table
// reader consumes, leaving the literal character inside the span.
export function verbatimCell(text) {
  return verbatim(String(text ?? '').replaceAll('|', '\\|'));
}

// A fenced block for text no renderer wrote and none can flatten: a probe's
// captured output is the stdout of code from the diff under review, which is
// as untrusted as input gets in this flow, and it is kept multi-line on
// purpose because reading it is the whole point of storing it.
//
// The fence is sized to the content the way `verbatim` sizes its code span —
// CommonMark closes a fenced block only on a run of at least as many backticks
// as opened it, so an output containing ``` cannot break out of a four-backtick
// fence. `info` is the language tag, and never comes from a payload.
export function fenced(text, info = '') {
  const body = String(text ?? '');
  const longest = (body.match(/`+/g) ?? []).reduce((n, run) => Math.max(n, run.length), 0);
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return [`${fence}${info}`, body, fence];
}

// Prose rendered inside a blockquote, with the quote carried across every line.
//
// The header's prose exemption is justified by containment — markup is a
// reviewer's formatting choice "inside a block that is already labeled as that
// reviewer's words". A blockquote ends at the first line that does not continue
// it, so a `> ` prefix on the first line alone claimed that containment
// without delivering it.
//
// Measured, on the real `synthesize`/`renderMarkdown`: an HONEST multi-line
// validator reason — a sentence, three bullets, and "I would have rated this
// `critical`" — rendered four of its lines at document level under the
// finding's own header, so a `warning` finding appeared to carry a reviewer's
// `critical` as the report's own text. A crafted one produced an entire extra
// `### [CRITICAL·defect]` section with a fabricated `_Reported by: … ·
// confidence: demonstrated_` line: the tool's own sentences, written by a lane.
// The prompts now ask this field for a multi-clause load story, which is what
// turned a latent shape into the ordinary case.
//
// `>` alone on a blank line rather than `> `: a trailing space is what a
// formatter strips, and a stripped `> ` breaks the quote back open.
export function quoted(text) {
  return String(text ?? '')
    .split('\n')
    .map((line) => (line === '' ? '>' : `> ${line}`))
    .join('\n');
}
