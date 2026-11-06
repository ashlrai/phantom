import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const script = new URL('./metrics-outcomes.sh', import.meta.url);
const repos = ['phantom', 'phantom-secrets', 'locus', 'lexicon', 'ashlr-md', 'ashlr-stack', 'ashlr-plugin'];
function run(args = [], mode = '') {
  const home = mkdtempSync(join(tmpdir(), 'merge-metrics-'));
  try {
    writeFileSync(join(home, 'gh'), `#!/bin/bash
printf '%s\\n' "$*" >> "$HOME/calls"
case "$*" in
  *ashlrai/lexicon*)
    case "$MODE" in
      failure) echo private-error >&2; exit 1;;
      capped) echo 1000; exit;;
      invalid) echo null; exit;;
      zero) echo 0; exit;;
    esac;;
esac
echo 2
`, { mode: 0o700 });
    const result = spawnSync('bash', [script.pathname, ...args], {
      encoding: 'utf8', env: { PATH: `${home}:/usr/bin:/bin`, HOME: home, MODE: mode },
    });
    let calls = '';
    try { calls = readFileSync(join(home, 'calls'), 'utf8'); } catch { /* No search on invalid arguments. */ }
    return { ...result, calls };
  } finally { rmSync(home, { recursive: true, force: true }); }
}
test('counts merge-time searches across exactly the seven repositories', () => {
  const result = run(['2026-10-26']);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'repo\tmerged_since_2026-10-26\n'
    + repos.map(repo => `ashlrai/${repo}\t2\n`).join('') + 'total\t14\n');
  assert.deepEqual(result.calls.trim().split('\n'), repos.map(repo =>
    `search prs --repo ashlrai/${repo} --merged >=2026-10-26 --limit 1000 --json number --jq length`));
});
test('uses a UTC date by default and accepts a genuine zero count', () => {
  const result = run([], 'zero');
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^repo\tmerged_since_\d{4}-\d{2}-\d{2}\n/);
  assert.match(result.stdout, /ashlrai\/lexicon\t0\n/);
  assert.match(result.stdout, /total\t12\n$/);
});
for (const mode of ['failure', 'capped', 'invalid']) {
  test(`fails without publishing partial totals on ${mode}`, () => {
    const result = run(['2026-10-26'], mode);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /ashlrai\/lexicon/);
    assert.doesNotMatch(result.stderr, /private-error/);
  });
}
test('rejects malformed dates and extra arguments before searching', () => {
  for (const args of [['bad'], ['2026-10-26', 'extra']]) {
    const result = run(args);
    assert.equal(result.status, 2);
    assert.equal(result.calls, '');
  }
});
