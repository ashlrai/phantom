import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import { cmdFleetStagingInventoryRetry } from '../src/cli/fleet-staging-inventory-retry.js';
import { inventoryStaging } from '../src/core/fleet/staging-inventory.js';
import { readStagingBatch } from '../src/mcp/fleet-staging-inventory-batch.js';

type Report = Awaited<ReturnType<typeof inventoryStaging>>;
const roots = ['one', 'two', 'three'].map(name => join(tmpdir(), 'fake-staging-retry', name));
const report = (root: string): Report => ({
  schema: 'fleet.staging-inventory.v1', root, complete: true, source: 'ok',
  generatedAt: '2026-11-05T00:00:00.000Z', evidence: 'preserve me',
} as unknown as Report);
const stream = (value: unknown) => (async function* () { yield JSON.stringify(value); })();
const capture = () => {
  const lines: string[] = [];
  return { lines, output: { log: (line: string) => lines.push(line), error: (_line: string) => {} } };
};

async function cancelledBatch(beforeFirst = false) {
  const controller = new AbortController();
  if (beforeFirst) controller.abort();
  const scan = vi.fn(async (root: string) => { controller.abort(); return report(root); });
  const batch = await readStagingBatch(roots, scan, controller.signal) as { reports: Report[]; completed: number };
  expect(scan).toHaveBeenCalledTimes(beforeFirst ? 0 : 1);
  return batch;
}

it('retries only unattempted roots in order and retains completed evidence', async () => {
  const batch = await cancelledBatch();
  const scan = vi.fn(async (root: string) => report(root));
  const out = capture();
  expect(await cmdFleetStagingInventoryRetry(['--stdin', '--json'], { input: stream(batch), scanner: scan, output: out.output })).toBe(0);
  expect(scan.mock.calls.map(([root]) => root)).toEqual(roots.slice(1));
  const result = JSON.parse(out.lines[0]!);
  expect(result.reports[0]).toEqual(batch.reports[0]);
  expect(result.reports.map((item: Report) => item.root)).toEqual(roots);
  expect(result).toMatchObject({ requested: 3, completed: 3 });
  expect(result).not.toHaveProperty('cancelled');
});

it('continues sequentially after a retry failure and exits unsuccessfully', async () => {
  const batch = await cancelledBatch();
  const scan = vi.fn(async (root: string) => { if (root === roots[1]) throw new Error('fake failure'); return report(root); });
  const out = capture();
  expect(await cmdFleetStagingInventoryRetry(['--stdin', '--json'], { input: stream(batch), scanner: scan, output: out.output })).toBe(1);
  expect(scan.mock.calls.map(([root]) => root)).toEqual(roots.slice(1));
  const result = JSON.parse(out.lines[0]!);
  expect(result.completed).toBe(2);
  expect(result.reports[0]).toEqual(batch.reports[0]);
  expect(result.reports.map((item: Report) => item.root)).toEqual(roots);
  expect(result.reports[1]).toMatchObject({ complete: false, source: 'failed' });
});

it('retries every root when cancellation occurs before the first scan', async () => {
  const batch = await cancelledBatch(true);
  const scan = vi.fn(async (root: string) => report(root));
  const out = capture();
  expect(await cmdFleetStagingInventoryRetry(['--stdin', '--json'], { input: stream(batch), scanner: scan, output: out.output })).toBe(0);
  expect(scan.mock.calls.map(([root]) => root)).toEqual(roots);
});

it('rejects forged sentinels and mismatched counts without scanning', async () => {
  const batch = await cancelledBatch();
  const scan = vi.fn(async (root: string) => report(root));
  const bad = [
    { ...batch, reports: batch.reports.map((item, i) => i === 1 ? { ...item, complete: true } : item) },
    { ...batch, completed: 2 },
    { ...batch, requested: 4 },
    { ...batch, cancelled: false },
    { ...batch, complete: true },
  ];
  for (const input of bad) {
    const out = capture();
    expect(await cmdFleetStagingInventoryRetry(['--stdin', '--json'], { input: stream(input), scanner: scan, output: out.output })).toBe(2);
    expect(out.lines).toEqual([]);
  }
  expect(scan).not.toHaveBeenCalled();
});
