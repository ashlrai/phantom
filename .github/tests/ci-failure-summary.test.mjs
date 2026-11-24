import test from 'node:test';
import assert from 'node:assert/strict';
import { annotationFor, pickFailureLines, summarizeFailure } from '../scripts/ci-failure-summary.mjs';

test('tsc diagnostics become file annotations and lead the summary', () => {
  const text = [
    'noise before the diagnostic',
    'src/core/foo.ts(41,9): error TS2322: Type string is not assignable',
    'src/web-ui/a.tsx(8,2): error TS7006: Parameter x implicitly has an any type',
    'leaks found: 1',
  ].join('\n');
  const result = summarizeFailure({ title: 'Typecheck', text });
  assert.equal(annotationFor(result.lines[0]), '::error file=src/core/foo.ts,line=41,col=9::error TS2322: Type string is not assignable');
  assert.equal(result.lines.length, 4);
  assert.match(result.summary, /^### Typecheck\n- src\/core\/foo.ts/);
  assert.ok(result.lines.at(-1).startsWith('leaks found'));
});

test('the secret-shape trailer is the annotation when it is the only line', () => {
  assert.deepEqual(pickFailureLines('2 allowed=0\n'), ['2 allowed=0']);
  assert.equal(annotationFor('2 allowed=0'), '::error::2 allowed=0');
});

test('a long gitleaks log keeps the finding ahead of the trailer and stops at five lines', () => {
  const body = Array.from({ length: 40 }, (_, i) => `Finding ${i}: token in src/a.ts`).join('\n');
  const lines = pickFailureLines(`${body}\nleaks found: 1\n`);
  assert.equal(lines.length, 5);
  assert.equal(lines[0], 'Finding 0: token in src/a.ts');
  assert.ok(!lines.includes('leaks found: 1'));
});
