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
  const api = createFleetRunsApi({ now: () => Date.parse('2026-10-31T12:00:00Z'), readHostLoad: () => null, readRunsDir: fail, listWorkers: fail, readInbox: fail, codexPersonal: fail, mergedLastHour });
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

  it('counts only verified in-window merges and excludes invalid durations', async () => {
    const base = { repository_url: 'https://api.github.com/repos/ashlrai/phantom', number: 42, title: 'Fix' };
    gh.stdout = JSON.stringify({ total_count: 5, incomplete_results: false, items: [
      { ...base, created_at: item.openedAt, pull_request: { merged_at: item.mergedAt } },
      { ...base, number: 43, created_at: item.openedAt, closed_at: '2026-10-31T11:10:00Z', pull_request: { merged_at: null } },
      { ...base, number: 44, created_at: 'invalid', pull_request: { merged_at: item.mergedAt } },
      { ...base, number: 45, created_at: '2026-10-31T11:50:00Z', pull_request: { merged_at: item.mergedAt } },
      { ...base, number: 46, created_at: item.openedAt, pull_request: { merged_at: '2026-10-31T10:30:00Z' } },
    ] });
    const result = await snapshot();
    expect(result.sources.merges).toBe('healthy');
    expect(result.mergesLastHour).toEqual({ complete: true, count: 3, perHour: 3, medianOpenToMergeMs: 30 * minute, items: [
      item,
      { ...item, number: 44, openedAt: null, openToMergeMs: null },
      { ...item, number: 45, openedAt: '2026-10-31T11:50:00Z', openToMergeMs: null },
    ] });
  });

  it('leaves unverified search totals unknown for malformed merge timestamps', async () => {
    gh.stdout = JSON.stringify({ total_count: 1, incomplete_results: false, items: [{ repository_url: 'https://api.github.com/repos/ashlrai/phantom', number: 1, title: 'Fix', pull_request: { merged_at: 'invalid' } }] });
    const result = await snapshot();
    expect(result.sources.merges).toBe('degraded');
    expect(result.mergesLastHour).toEqual({ count: null, items: [] });
  });

  it('excludes a GitHub item outside the allowed organization', async () => {
    gh.stdout = JSON.stringify({ total_count: 1, incomplete_results: false, items: [{ repository_url: 'https://api.github.com/repos/other/phantom', number: 1, title: 'Fix' }] });
    const result = await snapshot();
    expect(result.sources.merges).toBe('healthy');
    expect(result.mergesLastHour).toEqual({ complete: true, count: 0, perHour: 0, medianOpenToMergeMs: null, items: [] });
  });
});
