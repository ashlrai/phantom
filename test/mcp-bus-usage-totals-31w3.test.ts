import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { busHoplogPath } from '../src/core/fleet/bus-hoplog.js';
import { readFleetBusHops } from '../src/mcp/fleet.js';

let root: string;
const tokens = (total: number | null, knownSamples: number, unknownSamples: number, overflow = false) =>
  ({ total, overflow, knownSamples, unknownSamples });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mcp-bus-usage-'));
  vi.stubEnv('ASHLR_HOME', root);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

function writeLog(rows: unknown[]): string {
  const path = busHoplogPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const contents = rows.map(row => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : '');
  writeFileSync(path, contents, { mode: 0o600 });
  return contents;
}

describe('fleet bus returned-tail usage subtotals', () => {
  it('summarizes only returned attempts, including repeated IDs and unknown and zero samples', async () => {
    const contents = writeLog([
      { id: 'older', from: 'a', to: 'x', inputTokens: 100, outputTokens: 100 },
      { id: 'repeat', from: 'b', to: 'x', inputTokens: 5, outputTokens: null, body: 'private-body' },
      { id: 'invalid', from: 'b', to: 'x', inputTokens: -1 },
      { id: 'repeat', from: 'a', to: 'x', inputTokens: 0, outputTokens: 7 },
      { id: 'last', from: 'b', to: 'y', outputTokens: 0, extra: 'private-extra' },
    ]);
    const result = await readFleetBusHops(3);
    expect(result).toMatchObject({ sourceState: 'ok', returnedHops: 3, skippedRows: 1, truncated: true, limit: 3 });
    expect(result.hops).toEqual([
      { id: 'repeat', from: 'b', to: 'x', inputTokens: 5, outputTokens: null },
      { id: 'repeat', from: 'a', to: 'x', inputTokens: 0, outputTokens: 7 },
      { id: 'last', from: 'b', to: 'y', inputTokens: null, outputTokens: 0 },
    ]);
    expect(result.usageSummary).toEqual({
      hopCount: 3, invalidHopCount: 0,
      input: tokens(5, 2, 1), output: tokens(7, 2, 1),
      bySender: [
        { id: 'a', hopCount: 1, input: tokens(0, 1, 0), output: tokens(7, 1, 0) },
        { id: 'b', hopCount: 2, input: tokens(5, 1, 1), output: tokens(0, 1, 1) },
      ],
      byRecipient: [
        { id: 'x', hopCount: 2, input: tokens(5, 2, 0), output: tokens(7, 1, 1) },
        { id: 'y', hopCount: 1, input: tokens(0, 0, 1), output: tokens(0, 1, 0) },
      ],
    });
    expect(JSON.stringify(result)).not.toContain('private-body');
    expect(JSON.stringify(result)).not.toContain('private-extra');
    expect(readFileSync(busHoplogPath(), 'utf8')).toBe(contents);
  });

  it('distinguishes missing and unreadable sources from a readable empty log', async () => {
    expect(await readFleetBusHops()).toMatchObject({ sourceState: 'missing', hops: null, usageSummary: null });
    mkdirSync(busHoplogPath(), { recursive: true, mode: 0o700 });
    expect(await readFleetBusHops()).toMatchObject({ sourceState: 'unreadable', hops: null, usageSummary: null });
    rmSync(busHoplogPath(), { recursive: true });
    writeLog([]);
    expect(await readFleetBusHops()).toMatchObject({
      sourceState: 'ok', hops: [], returnedHops: 0, skippedRows: 0, truncated: false,
      usageSummary: { hopCount: 0, input: tokens(0, 0, 0), output: tokens(0, 0, 0), bySender: [], byRecipient: [] },
    });
  });

  it('preserves overflow globally and in the affected sender and recipient groups', async () => {
    writeLog([
      { id: 'same', from: 'a', to: 'x', inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 0 },
      { id: 'same', from: 'a', to: 'x', inputTokens: 1, outputTokens: null },
    ]);
    const result = await readFleetBusHops(2);
    const summary = result.usageSummary;
    expect(summary).toMatchObject({
      hopCount: 2, input: tokens(null, 2, 0, true), output: tokens(0, 1, 1),
      bySender: [{ id: 'a', hopCount: 2, input: tokens(null, 2, 0, true), output: tokens(0, 1, 1) }],
      byRecipient: [{ id: 'x', hopCount: 2, input: tokens(null, 2, 0, true), output: tokens(0, 1, 1) }],
    });
  });
});
