import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const guide = readFileSync(new URL('../CONTRIBUTING.md', import.meta.url), 'utf8');

function section(start: string, end: string): string {
  const first = guide.indexOf(start);
  const last = guide.indexOf(end, first + start.length);
  expect(first).toBeGreaterThanOrEqual(0);
  expect(last).toBeGreaterThan(first);
  return guide.slice(first, last);
}

const everyday = section('## Everyday commands', '### Focused iteration');
const tests = section('### Running tests hermetically on the local host', '## Conventions');
const hosted = section('### What Merge Gate requires', '### Updating a pull request');

describe('original contributor CI guidance', () => {
  it('keeps the verifier table local and distinguishes the hosted gate', () => {
    const row = everyday.split('\n').find((line) => line.startsWith('| `node scripts/verify-changed.mjs`'));
    expect(row).toBeDefined();
    expect(row).toMatch(/files changed against origin\/master/);
    expect(row).toMatch(/fast local gate/);
    expect(row).toMatch(/Local checks do not replace `Merge Gate`/);
    expect(row).not.toMatch(/Merge Gate`? still runs the full check/i);
  });

  it('explains that local verification and hosted PR checks cover different work', () => {
    const paragraph = everyday.split('\n\n').find((part) => part.startsWith('Use `node scripts/verify-changed.mjs`'));
    expect(paragraph).toBeDefined();
    expect(paragraph).toMatch(/does not run the affected test suites; run those separately/);
    expect(paragraph).toMatch(/does not replace `Merge Gate`/);
    expect(paragraph).toMatch(/on a pull request.*secret scans.*generated-files check.*fast gate/);
    expect(paragraph).not.toMatch(/full CI check remains the merge gate/i);
    expect(hosted).toMatch(/Pull requests and merge-queue batches run the fast gate/);
    expect(hosted).toMatch(/typecheck \+ affected tests/i);
  });

  it('separates PR coverage from scheduled and manual full lanes', () => {
    expect(tests).toMatch(/None of these lanes runs\s+on a pull request, in the merge queue or on a `master` push/);
    expect(tests).toMatch(/full\s+Ubuntu, Windows and Mac lanes run on the six-hour scheduled `master` run and\s+on manual dispatch/);
    expect(tests).toMatch(/scheduled run rotates the exhaustive Mac work over\s+seven daily slices/);
    expect(tests).not.toMatch(/partitions run on master pushes and on pull requests labelled `ci:full-mac`/);
  });
});
