import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import type { AshlrConfig } from '../src/core/types.js';
import { createFleetRunsApi } from '../src/core/verse/fleet-runs-api.js';
import { cmdMetricsLoop } from '../src/cli/metrics-loop.js';
import { readLoopReleases, readLoopReleasesCached, type LoopReaders } from '../src/core/metrics/loop-collect.js';

const NOW = Date.parse('2026-11-18T12:00:00Z');
const at = (minutes: number) => new Date(NOW - 10 * 3_600_000 + minutes * 60_000).toISOString();
const url = 'https://github.com/ashlrai/phantom/pull/5';
const row = (job: string, event: string, m: number, extra: object = {}) => JSON.stringify({ event, job, ts: at(m), ...extra });
/** One job finished 10 hours ago, merged at minute 55. Another finished 3 days ago (inside 7d, outside 24h). */
const ledger = [
  row('RQ-NEW', 'enqueue', 0), row('RQ-NEW', 'launch', 40), row('RQ-NEW', 'finish', 50), row('RQ-NEW', 'publish', 52, { url }), row('RQ-NEW', 'outcome', 55, { state: 'MERGED', url }),
  row('RQ-OLD', 'enqueue', -3 * 1440), row('RQ-OLD', 'launch', -3 * 1440 + 10), row('RQ-OLD', 'finish', -3 * 1440 + 20),
].join('\n');
const releasesJson = JSON.stringify([{ tag_name: 'v1', created_at: at(100) }, { tag_name: 'v0', created_at: at(-5 * 1440) }]);
const gh = async (args: string[]) => args[0] === 'api' ? releasesJson : null;

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'loop-stages-api-'));
  mkdirSync(join(dir, 'metrics'), { recursive: true });
  writeFileSync(join(dir, 'metrics', 'jobs.jsonl'), `${ledger}\n`);
  return dir;
}

async function getMetrics(query: string, loopReleases?: () => Promise<{ releases: null | { tag: string; createdAt: number }[]; reason: string | null }>) {
  const path = '/api/verse/fleet/runs/metrics';
  const api = createFleetRunsApi({ now: () => NOW, runsDir: root(), loopReleases } as never);
  const req = Readable.from([]) as unknown as IncomingMessage;
  req.url = `${path}${query}`; req.method = 'GET'; req.headers = { 'x-ashlr-token': 'test' };
  let status = 0; let wire: Record<string, any> | null = null;
  const res = { headersSent: false, writeHead(code: number) { status = code; this.headersSent = true; }, end(text: string) { try { wire = JSON.parse(text); } catch { wire = null; } } } as unknown as ServerResponse;
  await api({ cfg: {} as AshlrConfig, token: 'test', allowDispatch: true } as VerseApiContext, req, res, path, 'GET');
  return { status, wire: wire as Record<string, any> | null };
}

describe('loop stages from the metrics route', () => {
  it('returns the same metrics.loop-stages.v1 numbers as phm metrics loop for one fixture', async () => {
    const readers = { runsDir: '/nowhere', now: () => NOW, readText: async (p: string) => p.endsWith('jobs.jsonl') ? { text: ledger, truncated: false } : null, gh,
      installed: async () => null, nodes: () => null, peerTasks: async () => null, ncpu: () => 4 } as unknown as LoopReaders;
    const out: string[] = [];
    expect(await cmdMetricsLoop(['--dry-run', '--json'], { out: l => out.push(l), err: () => {}, readers })).toBe(0);
    const api = await getMetrics('', () => readLoopReleases(gh));
    expect(api.status).toBe(200);
    expect(api.wire!.loopStages).toEqual(JSON.parse(out.join('\n')).stages);
    expect(api.wire!.loopStages.stages.find((s: { stage: string }) => s.stage === 'merged_to_released')).toMatchObject({ p50_minutes: 45, known: 1 });
  });

  it('says unknown with a plain reason when releases cannot be read', async () => {
    const api = await getMetrics('', () => readLoopReleases(async () => null));
    expect(api.wire!.loopStages).toMatchObject({ releases: 'unavailable', releases_reason: expect.stringContaining('could not be read') });
    expect(api.wire!.loopStages.stages.find((s: { stage: string }) => s.stage === 'merged_to_released').p50_minutes).toBeNull();
  });

  it('widens the window with ?since=7d and rejects a bad one', async () => {
    const day = await getMetrics('', () => readLoopReleases(gh));
    const week = await getMetrics('?since=7d', () => readLoopReleases(gh));
    expect([day.wire!.loopStages.jobs, week.wire!.loopStages.jobs]).toEqual([1, 2]);
    expect((await getMetrics('?since=99y')).status).toBe(400);
  });
});

describe('readLoopReleasesCached', () => {
  it('reads once for ten minutes, then again; a failure is retried after one minute', async () => {
    let calls = 0;
    const counting = async (args: string[]) => { calls++; return gh(args); };
    await readLoopReleasesCached(counting, NOW); await readLoopReleasesCached(counting, NOW + 9 * 60_000);
    expect(calls).toBe(1);
    await readLoopReleasesCached(counting, NOW + 11 * 60_000);
    expect(calls).toBe(2);
    let fails = 0;
    const failing = async () => { fails++; return null; };
    await readLoopReleasesCached(failing, NOW); await readLoopReleasesCached(failing, NOW + 30_000);
    expect(fails).toBe(1);
    await readLoopReleasesCached(failing, NOW + 61_000);
    expect(fails).toBe(2);
  });
});
