import { describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createFleetRunsApi, mergeSpeedFacts } from '../src/core/verse/fleet-runs-api.js';
import { VERSE_FLEET_RUNS_PATH } from '../src/core/verse/fleet-runs-types.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const gh = vi.hoisted(() => ({ stdout: '' }));
vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  execFile: Object.assign(() => {}, {
    [Symbol.for('nodejs.util.promisify.custom')]: async () => ({ stdout: gh.stdout, stderr: '' }),
  }),
}));

async function snapshot(mergedLastHour?: () => Promise<unknown>) {
  const fail = async () => { throw new Error('unavailable'); };
  const api = createFleetRunsApi({ readHostLoad: () => null, readRunsDir: fail, listWorkers: fail, readInbox: fail, codexPersonal: fail, mergedLastHour });
  let body = '';
  const res = { writeHead() {}, end(text: string) { body = text; } } as unknown as ServerResponse;
  await api({} as VerseApiContext, {} as IncomingMessage, res, VERSE_FLEET_RUNS_PATH, 'GET');
  return JSON.parse(body) as { sources: { merges: string }; mergesLastHour: unknown };
}

const minute = 60_000;
const item = { repo: 'ashlrai/phantom', number: 42, title: 'Fix', openedAt: '2026-10-31T11:00:00Z', mergedAt: '2026-10-31T11:30:00Z', openToMergeMs: 30 * minute };

describe('merge speed facts', () => {
  it('reports unknown facts when there are no durations or count', () => {
    expect(mergeSpeedFacts([], null)).toEqual({ perHour: null, medianOpenToMergeMs: null });
    expect(mergeSpeedFacts([{ openToMergeMs: null }], 0)).toEqual({ perHour: 0, medianOpenToMergeMs: null });
  });

  it('uses the sorted middle duration and the full hourly count', () => {
    const items = [50, 10, 30].map(n => ({ openToMergeMs: n * minute }));
    expect(mergeSpeedFacts(items, 7)).toEqual({ perHour: 7, medianOpenToMergeMs: 30 * minute });
    expect(items.map(entry => entry.openToMergeMs)).toEqual([50 * minute, 10 * minute, 30 * minute]);
  });

  it('averages the two middle non-null durations for an even sample', () => {
    const items = [50, 10, null, 30, 20].map(n => ({ openToMergeMs: n === null ? null : n * minute }));
    expect(mergeSpeedFacts(items, 4)).toEqual({ perHour: 4, medianOpenToMergeMs: 25 * minute });
  });

  it('projects the speed fields and strips undeclared fields', async () => {
    const merges = { count: 7, perHour: 7, medianOpenToMergeMs: 30 * minute, items: [{ ...item, extra: 'private' }], extra: 'private' };
    const result = await snapshot(async () => merges);
    expect(result.sources.merges).toBe('healthy');
    expect(result.mergesLastHour).toEqual({ count: 7, perHour: 7, medianOpenToMergeMs: 30 * minute, items: [item] });
  });

  it('accepts readers that omit the new fields', async () => {
    const result = await snapshot(async () => ({ count: 1, items: [{ repo: item.repo, number: item.number, title: item.title }] }));
    expect(result.sources.merges).toBe('healthy');
    expect(result.mergesLastHour).toEqual({ count: 1, perHour: null, medianOpenToMergeMs: null, items: [{ repo: item.repo, number: item.number, title: item.title, openedAt: null, mergedAt: null, openToMergeMs: null }] });
  });

  it('maps GitHub timestamps, falls back to closed_at, and excludes invalid durations', async () => {
    const base = { repository_url: 'https://api.github.com/repos/ashlrai/phantom', number: 42, title: 'Fix' };
    gh.stdout = JSON.stringify({ total_count: 7, items: [
      { ...base, created_at: item.openedAt, closed_at: '2026-10-31T12:00:00Z', pull_request: { merged_at: item.mergedAt } },
      { ...base, number: 43, created_at: item.openedAt, closed_at: '2026-10-31T11:10:00Z', pull_request: { merged_at: null } },
      { ...base, number: 44, created_at: 'invalid', closed_at: item.mergedAt },
      { ...base, number: 45, created_at: item.mergedAt, closed_at: item.openedAt },
      { ...base, number: 46, created_at: 123, closed_at: null },
    ] });
    const result = await snapshot();
    expect(result.sources.merges).toBe('healthy');
    expect(result.mergesLastHour).toEqual({ count: 7, perHour: 7, medianOpenToMergeMs: 20 * minute, items: [
      item,
      { ...item, number: 43, mergedAt: '2026-10-31T11:10:00Z', openToMergeMs: 10 * minute },
      { ...item, number: 44, openedAt: 'invalid', openToMergeMs: null },
      { ...item, number: 45, openedAt: item.mergedAt, mergedAt: item.openedAt, openToMergeMs: null },
      { ...item, number: 46, openedAt: null, mergedAt: null, openToMergeMs: null },
    ] });
  });

  it('still rejects a GitHub item outside the allowed organization', async () => {
    gh.stdout = JSON.stringify({ total_count: 1, items: [{ repository_url: 'https://api.github.com/repos/other/phantom', number: 1, title: 'Fix' }] });
    const result = await snapshot();
    expect(result.sources.merges).toBe('degraded');
    expect(result.mergesLastHour).toEqual({ count: null, items: [] });
  });
});
