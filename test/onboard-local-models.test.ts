/** RQ-ONB-4 LOCAL MODELS opt-in: hardware detection, readiness loopback gate,
 * opt-in probes, persistence, POST /api/onboard/local-models. Hermetic: tmp
 * HOME; PATH restricted; fetch stubbed so no probe leaves the process. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { makeFixture, makeCfg, type H1Fixture } from './helpers/h1-fixture.js';
import { startServer } from './helpers/authenticated-web-server.js';
import {
  buildOnboardStatusReport,
  detectOnboardResources,
  persistOnboardLocalModels,
} from '../src/core/onboard.js';
import { buildReadiness, detectHardware } from '../src/core/readiness.js';
import { loadConfig } from '../src/core/config.js';
import type { WebServerOptions } from '../src/core/types.js';

let fx: H1Fixture;
let prevPath: string | undefined;
let openHandles: Array<{ close(): Promise<void> }> = [];

const cfg = (o?: Parameters<typeof makeCfg>[0]) => makeCfg(o);
const byId = <T extends { id: string }>(rows: T[], id: string): T => rows.find((r) => r.id === id)!;
const LOCAL = { enabled: true } as const;
const MODELS_BODY = JSON.stringify({ data: [{ id: 'm1' }, { id: 'm2' }], models: [{ name: 'm1' }, { name: 'm2' }] });

/** Record every requested URL and answer a 2-model list; proves loopback-only. */
function stubFetch() {
  const seen: string[] = [];
  vi.stubGlobal('fetch', async (u: unknown) => {
    seen.push(String(u));
    return new Response(MODELS_BODY, { status: 200 });
  });
  return seen;
}

beforeEach(() => {
  fx = makeFixture();
  prevPath = process.env.PATH;
  openHandles = [];
  mkdirSync(join(fx.home, 'fakebin'), { recursive: true });
  process.env.PATH = `${join(fx.home, 'fakebin')}:/usr/bin:/bin`;
});
afterEach(async () => {
  process.env.PATH = prevPath;
  vi.unstubAllGlobals();
  for (const h of openHandles) await h.close().catch(() => undefined);
  fx.cleanup();
});

it('persistOnboardLocalModels requires a boolean, then writes per-user config', () => {
  for (const bad of [{}, { enabled: 'yes' }, { enabled: 1 }, null]) {
    expect(persistOnboardLocalModels(bad).ok).toBe(false);
  }
  expect(persistOnboardLocalModels({ enabled: true })).toEqual({ ok: true, enabled: true });
  expect(loadConfig().onboard?.localModels?.enabled).toBe(true);
  expect(persistOnboardLocalModels({ enabled: false })).toEqual({ ok: true, enabled: false });
  expect(loadConfig().onboard?.localModels?.enabled).toBe(false);
});

describe('detectOnboardResources local probes', () => {
  it('probes run only on opt-in, only against loopback URLs; failures report unreachable', async () => {
    const seen = stubFetch();
    let rows = await detectOnboardResources(cfg()); // default: opt-in off
    expect(seen).toEqual([]);
    for (const id of ['omlx', 'lm-studio', 'ollama']) {
      expect(byId(rows, id)).toMatchObject({ reachable: null, modelCount: null });
    }
    rows = await detectOnboardResources(cfg({ onboard: { localModels: LOCAL } }));
    expect(seen).toHaveLength(3);
    for (const url of seen) expect(url).toMatch(/^http:\/\/(127\.0\.0\.1|\[::1\])/);
    for (const id of ['omlx', 'lm-studio', 'ollama']) {
      expect(byId(rows, id)).toMatchObject({ reachable: true, modelCount: 2 });
    }
    expect(byId(rows, 'codex').reachable).toBeNull();
    vi.stubGlobal('fetch', async () => { throw new Error('ECONNREFUSED detail'); });
    rows = await detectOnboardResources(cfg({ onboard: { localModels: LOCAL } }));
    expect(byId(rows, 'omlx')).toMatchObject({ reachable: false, modelCount: null });
  });
});

it('detectHardware reports chip/RAM/GPU/ANE; hardware reaches the report only when opted in', async () => {
  const hw = detectHardware(() => { throw new Error('no profiler'); });
  expect(hw).toMatchObject({ platform: process.platform, arch: process.arch });
  expect(hw.memoryBytes).toBeGreaterThan(0);
  if (process.platform === 'darwin' && process.arch === 'arm64') {
    expect(hw).toMatchObject({ ane: true, gpu: hw.chip });
    expect(detectHardware(() => '  Chipset Model: Fake GPU 9000\n').gpu).toBe('Fake GPU 9000');
  }
  const off = await buildOnboardStatusReport(cfg(), false);
  expect(off).toMatchObject({ dispatchEnabled: false, localModels: { enabled: false }, hardware: null });
  const on = await buildOnboardStatusReport(cfg({ onboard: { localModels: LOCAL } }), true);
  expect(on.localModels.enabled).toBe(true);
  expect(on.hardware?.memoryBytes).toBeGreaterThan(0);
});

it('buildReadiness refuses a remote cfg.models endpoint and never fetches it', async () => {
  const seen = stubFetch();
  const report = await buildReadiness(cfg({ models: { lmstudio: '', ollama: 'http://10.9.9.9:11434', providerChain: [] } } as never));
  const model = [...report.warnings, ...report.info].find((f) => f.id === 'model');
  expect(model?.detail).toContain('remote-not-allowed');
  expect(seen.every((u) => /^http:\/\/(127\.0\.0\.1|\[::1\])/.test(u))).toBe(true);
});

describe('POST /api/onboard/local-models', () => {
  const request = async (method: string, url: string, headers: Record<string, string>, body?: string) => {
    const res = await fetch(url, { method, headers, body });
    return { statusCode: res.status, body: await res.text() };
  };
  const makeOpts = (o: Partial<WebServerOptions> = {}): WebServerOptions =>
    ({ port: 0, open: false, allowDispatch: false, ...o });
  const AUTH = { 'Content-Type': 'application/json' };
  const post = (h: { port: number; token: string }, body: string) =>
    request('POST', `http://127.0.0.1:${h.port}/api/onboard/local-models`, { ...AUTH, 'x-ashlr-token': h.token }, body);

  it('404s without dispatch; requires token + JSON; persists the opt-in', async () => {
    const h = await startServer(cfg(), makeOpts());
    openHandles.push(h);
    expect((await post(h, JSON.stringify({ enabled: true }))).statusCode).toBe(404);
    const d = await startServer(cfg(), makeOpts({ allowDispatch: true }));
    openHandles.push(d);
    expect((await request('POST', `http://127.0.0.1:${d.port}/api/onboard/local-models`,
      { ...AUTH, 'x-ashlr-token': 'bad' }, '{}')).statusCode).toBe(401);
    expect((await request('POST', `http://127.0.0.1:${d.port}/api/onboard/local-models`,
      { 'x-ashlr-token': d.token }, '{}')).statusCode).toBe(415);
    expect((await post(d, '{}')).statusCode).toBe(400);

    const ok = await post(d, JSON.stringify({ enabled: true }));
    expect(ok.statusCode).toBe(200);
    expect(JSON.parse(ok.body)).toEqual({ ok: true, enabled: true });
    expect(loadConfig().onboard?.localModels?.enabled).toBe(true);
  });
});
