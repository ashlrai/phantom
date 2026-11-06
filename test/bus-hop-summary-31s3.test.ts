import { describe, expect, it, vi } from 'vitest';
import { summarizeBusHops } from '../src/core/fleet/bus-hop-summary.js';

const tokens = (total: number | null, knownSamples: number, unknownSamples: number, overflow = false) =>
  ({ total, overflow, knownSamples, unknownSamples });

describe('summarizeBusHops', () => {
  it('counts each valid hop and separates known usage from missing directions', () => {
    const rows = Object.freeze([
      Object.freeze({ id: 'same', from: 'z', to: 'B', inputTokens: 5, outputTokens: null }),
      Object.freeze({ id: 'same', from: 'a', to: 'B', inputTokens: 0, outputTokens: 7 }),
      Object.freeze({ id: 'third', from: 'z', to: 'A', outputTokens: 0 }),
      Object.freeze({ id: 'bad', from: 'a', to: 'B', inputTokens: -1 }),
      null,
    ]);
    expect(summarizeBusHops(rows)).toEqual({
      hopCount: 3, invalidHopCount: 2,
      input: tokens(5, 2, 1), output: tokens(7, 2, 1),
      bySender: [
        { id: 'a', hopCount: 1, input: tokens(0, 1, 0), output: tokens(7, 1, 0) },
        { id: 'z', hopCount: 2, input: tokens(5, 1, 1), output: tokens(0, 1, 1) },
      ],
      byRecipient: [
        { id: 'A', hopCount: 1, input: tokens(0, 0, 1), output: tokens(0, 1, 0) },
        { id: 'B', hopCount: 2, input: tokens(5, 2, 0), output: tokens(7, 1, 1) },
      ],
    });
    expect(summarizeBusHops([...rows].reverse())).toEqual(summarizeBusHops(rows));
    expect(rows[0]).toEqual({ id: 'same', from: 'z', to: 'B', inputTokens: 5, outputTokens: null });
  });

  it('returns empty subtotals and no groups for empty input', () => {
    expect(summarizeBusHops(Object.freeze([]))).toEqual({
      hopCount: 0, invalidHopCount: 0, input: tokens(0, 0, 0), output: tokens(0, 0, 0),
      bySender: [], byRecipient: [],
    });
  });

  it('marks only overflowing totals as null globally and within each group', () => {
    const max = Number.MAX_SAFE_INTEGER;
    const rows = [
      { id: '1', from: 'a', to: 'x', inputTokens: max, outputTokens: max },
      { id: '2', from: 'a', to: 'y', inputTokens: 1, outputTokens: 0 },
      { id: '3', from: 'b', to: 'x', inputTokens: 0, outputTokens: 1 },
      { id: '4', from: 'b', to: 'y' },
    ];
    const result = summarizeBusHops(rows);
    expect(result.input).toEqual(tokens(null, 3, 1, true));
    expect(result.output).toEqual(tokens(null, 3, 1, true));
    expect(result.bySender).toEqual([
      { id: 'a', hopCount: 2, input: tokens(null, 2, 0, true), output: tokens(max, 2, 0) },
      { id: 'b', hopCount: 2, input: tokens(0, 1, 1), output: tokens(1, 1, 1) },
    ]);
    expect(result.byRecipient).toEqual([
      { id: 'x', hopCount: 2, input: tokens(max, 2, 0), output: tokens(null, 2, 0, true) },
      { id: 'y', hopCount: 2, input: tokens(1, 1, 1), output: tokens(0, 1, 1) },
    ]);
    expect(summarizeBusHops([...rows].reverse())).toEqual(result);
  });

  it('rejects invalid metadata and fake secret-shaped identifiers without accessing extra fields', () => {
    const trap = vi.fn(() => { throw new Error('must not be read'); });
    const fake = ['gh', 'p_', 'FAKE', 'x'.repeat(40)].join('');
    const base = { id: 'valid', from: 'sender', to: 'recipient' };
    const rows = [
      { ...base, get body() { return trap(); }, get prompt() { return trap(); } },
      ...['id', 'from', 'to'].map(key => ({ ...base, [key]: fake })),
      { ...base, id: 'has space' },
      { ...base, inputTokens: Number.MAX_SAFE_INTEGER + 1 },
      { ...base, outputTokens: 0.5 },
      { ...base, get inputTokens() { return trap(); } },
      new Proxy(base, { getOwnPropertyDescriptor: trap, get: trap }),
      Object.create(base) as unknown,
    ];
    const result = summarizeBusHops(rows);
    expect(result.hopCount).toBe(1);
    expect(result.invalidHopCount).toBe(9);
    expect(result.input).toEqual(tokens(0, 0, 1));
    expect(result.output).toEqual(tokens(0, 0, 1));
    expect(JSON.stringify(result)).not.toContain(fake);
    expect(trap).not.toHaveBeenCalled();
  });
});
