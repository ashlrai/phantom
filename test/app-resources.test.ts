import { expect, it, vi } from 'vitest';
vi.mock('../src/core/fleet/lane-console.js', () => ({ getFleetLaneSnapshot: vi.fn(async () => ({ lanes: [
  { lane: 'codex-cmp', liveJobs: 2, credit: { state: 'observed', remainingPct: 0, observedAt: '2026-11-02T12:00:00Z', resetAt: '2026-11-02T17:25:00Z' } },
  { lane: 'devin', liveJobs: null, credit: { state: 'unknown' } },
] })) }));
vi.mock('node:fs/promises', () => ({ open: vi.fn(async () => { throw new Error('missing'); }) }));
import { open } from 'node:fs/promises';
import { cmdApp } from '../src/cli/app.js';
import { readAppResources } from '../src/core/resources/app-resources.js';
it('retains observed zero, rejects stale data and never invents unknown percentages', async () => {
  const current = await readAppResources('/fixture', new Date('2026-11-02T12:05:00Z'));
  expect(current.resources[0]).toEqual({ pool: 'codex-cmp', remainingPercent: 0, resetAt: '2026-11-02T17:25:00Z', liveJobs: 2 });
  expect(current.resources.find(row => row.pool === 'devin')?.remainingPercent).toBeNull();
  const stale = await readAppResources('/fixture', new Date('2026-11-02T13:05:00Z'));
  expect(stale.resources.every(row => row.remainingPercent === null)).toBe(true);
});

it('projects only numeric fields from resources, overrides and slots', async () => {
  const files: Record<string, unknown> = {
    'resources.json': { resources: { grok: { remaining_pct: 24, as_of: '2026-11-02T12:00:00Z', reset_at: '2026-11-03T12:00:00Z', token: 'private-sentinel' } } },
    'budget-overrides.json': { 'claude-api': { remainingPercent: 40, observedAt: '2026-11-02T12:00:00Z', resetAt: '2026-11-03T12:00:00Z' } },
    'slots.json': { grok: { running: 3, target: 99, secret: 'private-sentinel' } },
  };
  vi.mocked(open).mockImplementation(async (path) => ({
    stat: async () => ({ isFile: () => true, size: 512 }),
    read: async (buffer: Buffer) => ({ bytesRead: buffer.write(JSON.stringify(files[String(path).split('/').pop()!] ?? {})) }),
    close: async () => {},
  }) as unknown as Awaited<ReturnType<typeof open>>);
  const result = await readAppResources('/fixture', new Date('2026-11-02T12:05:00Z'));
  expect(result.resources.find(row => row.pool === 'grok')).toMatchObject({ remainingPercent: 24, liveJobs: 3 });
  expect(result.resources.find(row => row.pool === 'claude-api')?.remainingPercent).toBe(40);
  expect(JSON.stringify(result)).not.toContain('private-sentinel');
  const future = await readAppResources('/fixture', new Date('2026-11-02T11:59:00Z'));
  expect(future.resources.every(row => row.remainingPercent === null)).toBe(true);
});
it('prints one JSON envelope and rejects relative fixture paths', async () => {
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(await cmdApp(['resources', '--json', '--queue-dir', '/fixture'])).toBe(0);
  expect(JSON.parse(String(output.mock.calls[0]?.[0])).schema).toBe('app.resources.v1');
  expect(await cmdApp(['resources', '--queue-dir', 'relative'])).toBe(2);
  output.mockRestore(); error.mockRestore();
});
