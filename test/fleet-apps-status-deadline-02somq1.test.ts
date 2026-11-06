import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFleetAppsApi, FLEET_APPS } from '../src/core/verse/fleet-apps-api.js';

const GET = '/api/verse/fleet/apps';
const BUDGET_MS = 20_000;
const reply = (running: boolean) => ({ stdout: JSON.stringify({ ok: true, running }), stderr: '' });
type Row = { app: string; running: boolean | null };

async function get(api: ReturnType<typeof createFleetAppsApi>) {
  let status = 0, text = '';
  const res = { writeHead(code: number) { status = code; return this; }, end(value: string) { text = value; } } as unknown as ServerResponse;
  await api({ allowDispatch: false, token: 't' } as never, { headers: {}, socket: {} } as IncomingMessage, res, GET, 'GET');
  return { status, body: JSON.parse(text) as { available: boolean; apps: Row[] } };
}
const appOf = (argv: string[]) => argv[3]!;

describe('fleet apps snapshot shared deadline', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('answers by the shared deadline when one probe never settles, keeping other rows', async () => {
    const seen: string[] = [];
    const timeouts: unknown[] = [];
    const exec = vi.fn((_f: string, argv: string[], options: { timeout?: number }) => {
      seen.push(appOf(argv)); timeouts.push(options.timeout);
      return appOf(argv) === 'Codex' ? new Promise<never>(() => {}) : Promise.resolve(reply(appOf(argv) === 'Cursor'));
    });
    const api = createFleetAppsApi({ exec: exec as never, locateScript: () => '/fake/script', runsDir: '/fake/runs' });
    const start = Date.now();
    const pending = get(api);
    await vi.advanceTimersByTimeAsync(BUDGET_MS);
    const { status, body } = await pending;
    expect(Date.now() - start).toBeLessThanOrEqual(BUDGET_MS);
    expect(status).toBe(200);
    expect(body.available).toBe(true);
    expect(body.apps).toHaveLength(FLEET_APPS.length);
    const byApp = Object.fromEntries(body.apps.map(r => [r.app, r.running]));
    expect(byApp.Codex).toBeNull();
    expect(byApp.Cursor).toBe(true);
    expect(byApp.Claude).toBe(false);
    // The surviving worker kept going through every remaining app; no more than one call per app.
    expect(exec).toHaveBeenCalledTimes(FLEET_APPS.length);
    expect(timeouts.every(t => typeof t === 'number' && t > 0 && t <= BUDGET_MS)).toBe(true);
  });

  it('issues no probes after expiry when both workers hang', async () => {
    const exec = vi.fn(() => new Promise<never>(() => {}));
    const api = createFleetAppsApi({ exec: exec as never, locateScript: () => '/fake/script', runsDir: '/fake/runs' });
    const start = Date.now();
    const pending = get(api);
    await vi.advanceTimersByTimeAsync(BUDGET_MS);
    const { status, body } = await pending;
    expect(Date.now() - start).toBe(BUDGET_MS);
    expect(status).toBe(200);
    expect(body.apps.every(r => r.running === null)).toBe(true);
    expect(exec).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(BUDGET_MS);
    expect(exec).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('handles a late rejection after expiry without an unhandled rejection', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      let reject!: (reason: unknown) => void;
      const exec = vi.fn((_f: string, argv: string[]) =>
        appOf(argv) === 'Phantom' ? new Promise<never>((_, no) => { reject = no; }) : new Promise<never>(() => {}));
      const api = createFleetAppsApi({ exec: exec as never, locateScript: () => '/fake/script', runsDir: '/fake/runs' });
      const pending = get(api);
      await vi.advanceTimersByTimeAsync(BUDGET_MS);
      expect((await pending).body.apps[0]).toMatchObject({ app: 'Phantom', running: null });
      reject(new Error('late failure'));
      await vi.advanceTimersByTimeAsync(10);
      await Promise.resolve();
      expect(unhandled).not.toHaveBeenCalled();
    } finally { process.off('unhandledRejection', unhandled); }
  });

  it('does not poison the cache: a later refresh returns fresh statuses', async () => {
    let healthy = false;
    const exec = vi.fn((_f: string, argv: string[]) =>
      healthy ? Promise.resolve(reply(appOf(argv) === 'Safari')) : new Promise<never>(() => {}));
    const api = createFleetAppsApi({ exec: exec as never, locateScript: () => '/fake/script', runsDir: '/fake/runs' });
    const first = get(api);
    await vi.advanceTimersByTimeAsync(BUDGET_MS);
    expect((await first).body.apps.every(r => r.running === null)).toBe(true);
    // Within the 30 s TTL the expired view is reused without new probes.
    await vi.advanceTimersByTimeAsync(5_000);
    await get(api);
    expect(exec).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10_000);
    healthy = true;
    const second = await get(api);
    expect(second.status).toBe(200);
    expect(second.body.apps.find(r => r.app === 'Safari')?.running).toBe(true);
    expect(second.body.apps.find(r => r.app === 'Codex')?.running).toBe(false);
    expect(exec).toHaveBeenCalledTimes(2 + FLEET_APPS.length);
  });
});
