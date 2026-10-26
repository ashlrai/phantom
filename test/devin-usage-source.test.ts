import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readDevinResource, sumDevinJobSeconds } from '../src/core/devin/usage-source.js';
import { readDevinBillingUsage } from '../src/core/devin/api-billing.js';

const now = new Date('2026-10-26T12:00:00Z');
const fixture = readFileSync(new URL('./fixtures/devin-usage/jobs.jsonl', import.meta.url), 'utf8');
const env = { DEVIN_API_KEY: 'synthetic-test-credential', DEVIN_ORG_ID: 'org-test' };
const report = { total_acus: 12, consumption_by_date: [{ date: 123, acus: 12, acus_by_product: { devin: 12 } }] };
const options = { now, env, readJobs: async () => fixture };
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('Devin resource.v1', () => {
  it('reads only the sanctioned GET endpoint and emits ACUs with unknown quota', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(report));
    const readJobs = vi.fn(async () => fixture);
    const result = await readDevinResource({ ...options, fetch, readJobs });
    expect(result).toMatchObject({ schema: 'resource.v1', lane: 'devin', source: 'acu', unit: 'acu', used: 12, left: null, reset: null, burnRate: 0.5, status: 'ready' });
    expect(readJobs).not.toHaveBeenCalled();
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe('https://api.devin.ai/v3/organizations/org-test/consumption/daily?time_after=1792929600&time_before=1793016000');
    expect(init).toMatchObject({ method: 'GET', redirect: 'error', headers: { Authorization: `Bearer ${env.DEVIN_API_KEY}` } });
  });

  it('uses fixture wall time without credentials, clips boundaries and deduplicates jobs', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const readJobs = vi.fn(async () => fixture);
    const result = await readDevinResource({ ...options, env: {}, fetch, readJobs });
    expect(readJobs).toHaveBeenCalledWith(join(homedir(), '.ashlr-runs', 'metrics', 'jobs.jsonl'));
    expect(result).toMatchObject({ source: 'walltime', unit: 'seconds', used: 7200, burnRate: 300, left: null, reset: null, status: 'ready' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([401, 403, 404, 429, 500])('falls back for HTTP %s without reflecting response details', async status => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(env.DEVIN_API_KEY, { status }));
    expect(await readDevinResource({ ...options, fetch })).toMatchObject({ source: 'walltime', used: 7200 });
  });

  it.each([{}, { total_acus: -1, consumption_by_date: [] }, { ...report, next_cursor: 'more' }])('falls back on invalid or incomplete API evidence', async body => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(body));
    expect(await readDevinResource({ ...options, fetch })).toMatchObject({ source: 'walltime', used: 7200 });
  });

  it('distinguishes unavailable files from measured zero', async () => {
    expect(await readDevinResource({ ...options, env: {}, readJobs: async () => { throw new Error('absent'); } })).toMatchObject({ status: 'unavailable', used: null, burnRate: null });
    expect(await readDevinResource({ ...options, env: {}, readJobs: async () => '' })).toMatchObject({ status: 'ready', used: 0, burnRate: 0 });
  });

  it('keeps good rows while marking corrupt, unfinished and future rows partial', () => {
    const extra = '\ninvalid\nnull\n' + JSON.stringify({ lane: 'devin', startedAt: now.toISOString(), finishedAt: '2026-10-27T12:00:00Z' });
    expect(sumDevinJobSeconds(fixture + extra, now.getTime() - 86400000, now.getTime())).toEqual({ used: 7200, partial: true });
  });

  it('never emits a key in JSON or any console channel on success or failures', async () => {
    const logs = ['log', 'error', 'warn', 'info', 'debug'] as const;
    const spies = logs.map(method => vi.spyOn(console, method).mockImplementation(() => {}));
    const outputs = [];
    for (const fetch of [
      vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(report)),
      vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error(env.DEVIN_API_KEY)),
      vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(env.DEVIN_API_KEY, { status: 403 })),
      vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(env.DEVIN_API_KEY)),
    ]) outputs.push(await readDevinResource({ ...options, fetch }));
    expect(JSON.stringify(outputs)).not.toContain(env.DEVIN_API_KEY);
    expect(JSON.stringify(spies.map(spy => spy.mock.calls))).not.toContain(env.DEVIN_API_KEY);
    spies.forEach(spy => expect(spy).not.toHaveBeenCalled());
  });

  it('bounds a stalled API read and falls back', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (_url, init) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))));
    const result = readDevinResource({ ...options, fetch });
    await vi.advanceTimersByTimeAsync(5000);
    expect(await result).toMatchObject({ source: 'walltime', used: 7200 });
  });

  it('prints resource JSON through the CLI without initializing the Devin service', async () => {
    const source = await import('../src/core/devin/usage-source.js');
    const value = await readDevinResource({ ...options, env: {} });
    vi.spyOn(source, 'readDevinResource').mockResolvedValue(value);
    const { runDevinCli } = await import('../src/cli/devin.js');
    const out = vi.fn();
    const err = vi.fn();
    expect(await runDevinCli(['usage', '--json'], { out, err })).toBe(0);
    expect(JSON.parse(out.mock.calls[0]![0])).toEqual(value);
    expect(err).not.toHaveBeenCalled();
    expect(await runDevinCli(['usage', '--key', env.DEVIN_API_KEY], { out, err })).toBe(2);
    expect(JSON.stringify([out.mock.calls, err.mock.calls])).not.toContain(env.DEVIN_API_KEY);
  });

  it('rejects oversized bodies and unsafe organizations', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('x'.repeat(1_048_577)));
    expect(await readDevinResource({ ...options, fetch })).toMatchObject({ source: 'walltime' });
    fetch.mockClear();
    expect(await readDevinBillingUsage({ env, orgId: '../other', start: 0, end: 1, fetch })).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
});
