import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { buildHourShipped, readHourShipped } from '../src/core/fleet/shipped-hour.js';
import { readFleetShipped } from '../src/core/fleet/shipped.js';
import { handleShippedApi } from '../src/core/verse/whats-new-api.js';

const now = Date.parse('2026-11-20T12:00:00Z');
type Deps = NonNullable<Parameters<typeof handleShippedApi>[3]>;
async function call(query: string, deps: Deps, method = 'GET') {
  let status = 0, body: unknown;
  const res = { writeHead: (code: number) => { status = code; }, setHeader: () => {}, end: (text: string) => { body = JSON.parse(text); } } as unknown as ServerResponse;
  await handleShippedApi({ url: `/api/verse/shipped${query}` } as IncomingMessage, res, method, deps);
  return { status, body };
}

it('selects the hour reader at the supplied clock and preserves an incomplete report', async () => {
  const report = buildHourShipped([{ repo: 'acme/app', commits: [{ sha: 'a', mergedAt: new Date(now - 1000).toISOString(), subject: 'Fix queue (#7)', paths: [] }] }, null], now);
  const hour = vi.fn(async () => report);
  const fleet = vi.fn(async () => { throw Error('unexpected fleet read'); });
  const source = vi.fn(async () => { throw Error('unexpected days read'); });
  expect(await call('?since=1h', { now: () => now, hour, fleet, source })).toEqual({ status: 200, body: report });
  expect(report).toMatchObject({ complete: false, total: null, items: [{ number: 7 }] });
  expect(hour).toHaveBeenCalledExactlyOnceWith({ now });
  expect(fleet).not.toHaveBeenCalled(); expect(source).not.toHaveBeenCalled();
});

it('keeps 24h and days readers distinct and rejects bad requests without reading', async () => {
  const fleetReport = await readFleetShipped({ now, gh: async () => JSON.stringify({ total_count: 0, incomplete_results: false, items: [] }), read: async () => true });
  const fleet = vi.fn(async () => fleetReport);
  const hour = vi.fn(async () => buildHourShipped([null], now));
  const source = vi.fn(async () => ({ state: 'unknown' as const, note: 'unavailable', changes: [] }));
  const deps = { now: () => now, fleet, hour, source };
  expect(await call('?since=24h', deps)).toEqual({ status: 200, body: fleetReport });
  expect(fleet).toHaveBeenCalledExactlyOnceWith({ now });
  expect((await call('?days=3', deps)).body).toMatchObject({ days: 3, total: null });
  expect(source).toHaveBeenCalledExactlyOnceWith(now - 3 * 86_400_000);
  fleet.mockClear(); source.mockClear();
  for (const query of ['?since=oops', '?since=1h&days=3', '?since=24h&extra=1', '?days=0']) {
    expect((await call(query, deps)).status).toBe(400);
  }
  expect((await call('?since=1h', deps, 'POST')).status).toBe(405);
  expect(hour).not.toHaveBeenCalled(); expect(fleet).not.toHaveBeenCalled(); expect(source).not.toHaveBeenCalled();
});

it('serves the real hour reader from an isolated git repository', async () => {
  const root = mkdtempSync(join(tmpdir(), 'shipped-api-'));
  try {
    const repo = join(root, 'app'); mkdirSync(repo);
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', '-c', 'commit.gpgsign=false', ...args], { stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_DATE: new Date(now - 60_000).toISOString(), GIT_COMMITTER_DATE: new Date(now - 60_000).toISOString() } });
    git('init', '-q', '-b', 'master'); git('remote', 'add', 'origin', 'https://example.com/acme/app.git');
    writeFileSync(join(repo, 'file.txt'), 'fixture\n'); git('add', '.'); git('commit', '-q', '-m', 'Fix queue (#7)');
    git('update-ref', 'refs/remotes/origin/master', 'HEAD');
    const result = await call('?since=1h', { now: () => now, hour: opts => readHourShipped({ ...opts, roots: [root] }) });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ window: '1h', complete: true, total: 1, items: [{ repo: 'acme/app', number: 7, title: 'Fix queue' }] });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
