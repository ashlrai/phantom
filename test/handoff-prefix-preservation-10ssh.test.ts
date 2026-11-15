import { describe, expect, it } from 'vitest';
import { appendFinding, HANDOFF_MAX_CHARS, renderHandoff, validateHandoff, type WorkerHandoff } from '../src/core/verse/handoff.js';

const handoff: WorkerHandoff = {
  id: 'worker-synthetic',
  task: 'Preserve the checkout calculation across the migration.',
  files: [
    { path: 'src/cart.ts', lines: { from: 12, to: 24 }, why: 'calculation' },
    { path: 'test/cart.test.ts', lines: { from: 30, to: 48 }, why: 'regression' },
  ],
  constraints: [
    { rule: 'Keep the signature', reason: 'external callers depend on it' },
    { rule: 'Retain rounding', reason: 'receipts must reconcile' },
  ],
  check: 'Run the cart suite and verify a discounted receipt totals correctly.',
};

describe('multi-turn handoff preservation', () => {
  it('retains the complete prompt and finding order without mutating earlier inputs', () => {
    const original = structuredClone(handoff);
    const findings = ['The caller passes cents.', 'The receipt rounds after discount.', 'The fixture covers zero.'];
    let current = handoff;
    let rendered = renderHandoff(current);
    expect(validateHandoff(current)).toEqual([]);
    for (const [index, finding] of findings.entries()) {
      const snapshot = structuredClone(current);
      const next = appendFinding(current, finding);
      const nextRendered = renderHandoff(next);
      expect(nextRendered.startsWith(rendered)).toBe(true);
      expect(current).toEqual(snapshot);
      expect(next.findings).toEqual(findings.slice(0, index + 1));
      expect(validateHandoff(next)).toEqual([]);
      for (const text of [handoff.task, handoff.check, 'src/cart.ts:12-24', 'test/cart.test.ts:30-48', ...handoff.constraints.flatMap((c) => [c.rule, c.reason]), ...findings.slice(0, index + 1)]) {
        expect(nextRendered).toContain(text);
      }
      current = next;
      rendered = nextRendered;
    }
    expect(handoff).toEqual(original);
  });

  it('reports the rendered budget boundary without truncating prior context', () => {
    const first = appendFinding(handoff, 'Initial observation.');
    const padding = 'x'.repeat(HANDOFF_MAX_CHARS - renderHandoff(first).length - 3);
    const atLimit = appendFinding(first, padding);
    expect(renderHandoff(atLimit)).toHaveLength(HANDOFF_MAX_CHARS);
    expect(validateHandoff(atLimit)).toEqual([]);
    const over = appendFinding(atLimit, 'One more observation.');
    expect(renderHandoff(over).startsWith(renderHandoff(atLimit))).toBe(true);
    expect(over.task).toBe(handoff.task);
    expect(over.constraints).toEqual(handoff.constraints);
    expect(over.findings).toEqual(['Initial observation.', padding, 'One more observation.']);
    expect(validateHandoff(over)).toEqual([expect.objectContaining({ field: 'handoff', detail: expect.stringContaining('budget') })]);
  });
});
