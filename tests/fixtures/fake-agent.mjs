#!/usr/bin/env node
// Fake coding-agent CLI for end-to-end testing. Reads prompt from stdin,
// detects which persona is being asked (by scanning for "You are the
// **<Title>**") and which round (Round 1 vs Round 2 in the prompt), then
// emits a plausibly-shaped JSON response.

let prompt = '';
process.stdin.on('data', (b) => prompt += b);
process.stdin.on('end', () => {
  const persona = detectPersona(prompt);
  const round = detectRound(prompt);
  const table = round === 'round1' ? ROUND1 : ROUND2;
  process.stdout.write(JSON.stringify(table[persona] ?? { error: `unknown persona: ${persona}` }));
});

function detectPersona(p) {
  if (p.includes('You are the **Auditor**'))    return 'auditor';
  if (p.includes('You are the **Adversary**'))  return 'adversary';
  if (p.includes('You are the **Pragmatist**')) return 'pragmatist';
  return 'unknown';
}

function detectRound(p) {
  if (p.includes('Round 2: Cross-Review')) return 'round2';
  return 'round1';
}

const ROUND1 = {
  auditor: {
    persona: 'auditor', verdict: 'conditional',
    summary: 'One off-by-one and a NaN edge case.',
    findings: [
      { severity: 'critical', file: 'foo.py', line: 10,
        title: 'Off-by-one in the loop bound',
        detail: 'Loop iterates one too many times when input is empty.',
        fix: 'Change <= to <' },
      { severity: 'warning', file: 'stats.py', line: 33,
        title: 'Mean returns NaN for empty input',
        detail: 'sum/len divides by zero.',
        fix: 'Guard with len > 0 check' },
    ],
  },
  adversary: {
    persona: 'adversary', verdict: 'reject',
    summary: 'Unparameterized SQL.',
    findings: [
      { severity: 'critical', file: 'db.py', line: 22,
        title: 'SQL injection via string concatenation',
        detail: 'User input concatenated into the query.',
        fix: 'Use parameterized queries' },
    ],
  },
  pragmatist: {
    persona: 'pragmatist', verdict: 'approve',
    summary: 'Maintainability is fine; one missing test file.',
    findings: [
      { severity: 'warning', file: 'foo.py', line: null,
        title: 'No tests for foo module',
        detail: 'Public API has no test coverage.',
        fix: 'Add tests/test_foo.py' },
    ],
  },
};

const ROUND2 = {
  auditor: {
    persona: 'auditor',
    validate: [{ from: 'adversary', title: 'SQL injection via string concatenation',
                 reason: 'Confirmed — db.py:22 builds the WHERE clause with %s.' }],
    challenge: [],
    added: [],
  },
  adversary: {
    persona: 'adversary',
    validate: [],
    challenge: [{ from: 'auditor', title: 'Off-by-one in the loop bound',
                  reason: 'The bound is correct on this loop — the slice already excludes the final element.' }],
    added: [{ severity: 'warning', file: 'auth.py', line: 88,
              title: 'Token compared with == (timing leak)',
              detail: 'Use crypto.timingSafeEqual.',
              fix: 'Switch to constant-time compare' }],
  },
  pragmatist: {
    persona: 'pragmatist',
    validate: [{ from: 'auditor', title: 'Off-by-one in the loop bound',
                 reason: 'Spotted it independently on the same line.' }],
    challenge: [],
    added: [],
  },
};
