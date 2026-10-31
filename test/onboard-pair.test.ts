/**
 * onboard-pair.test.ts - RQ-ONB-5 PAIR-COMPUTER. Covers the "This computer"
 * pairing on the Connect surface: detectComputerPairing joins the persisted
 * record with live service/daemon/enrollment state (last-seen is the fresher
 * of the pair heartbeat and the daemon's lastTickAt), pairThisComputer reuses
 * stepDaemonService + stepEnroll and persists only when the service step is
 * in place, unpairThisComputer clears just the record, and the routes keep
 * the mutation posture (404 without dispatch, token + JSON required).
 * Hermetic: tmp HOME, disposable repos, injected step runners, empty fakebin.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { makeFixture, makeCfg, type H1Fixture } from './helpers/h1-fixture.js';
import { readAuthHeaders, startServer } from './helpers/authenticated-web-server.js';
import { detectComputerPairing, pairThisComputer, unpairThisComputer } from '../src/core/onboard.js';
import { loadConfig, saveConfig } from '../src/core/config.js';
import { saveDaemonState } from '../src/core/daemon/state.js';
import type { AshlrConfig, DaemonState, OnboardStep, WebServerOptions } from '../src/core/types.js';

let fx: H1Fixture;
let prevPath: string | undefined;
let openHandles: Array<{ close(): Promise<void> }> = [];

const cfg = (o?: Parameters<typeof makeCfg>[0]) => makeCfg(o);
const PAIRED = { pairedAt: '2026-09-01T00:00:00.000Z', lastSeenAt: '2026-09-02T00:00:00.000Z' };
const step = (name: string, status: OnboardStep['status']): OnboardStep => ({ name, status, detail: name });
const computer = (o?: Parameters<typeof makeCfg>[0]) =>
  cfg({ onboard: { computer: PAIRED, ...o?.onboard } });

beforeEach(() => {
  fx = makeFixture();
  prevPath = process.env.PATH;
  const bin = join(fx.home, 'fakebin'); // PATH := empty fakebin + system dirs: ambient CLIs are never probed.
  mkdirSync(bin, { recursive: true });
  process.env.PATH = `${bin}:/usr/bin:/bin`;
  openHandles = [];
});
afterEach(async () => {
  process.env.PATH = prevPath;
  for (const h of openHandles) await h.close().catch(() => undefined);
  vi.restoreAllMocks();
  fx.cleanup();
});

describe('detectComputerPairing', () => {
  it('joins the persisted record with live facets', () => {
    expect(detectComputerPairing(cfg())).toMatchObject({ paired: false, pairedAt: null, serviceInstalled: false, enrolledRepos: 0 });
    const repo = fx.makeRepo();
    repo.enroll();
    expect(detectComputerPairing(computer())).toMatchObject({ paired: true, pairedAt: PAIRED.pairedAt, lastSeenAt: PAIRED.lastSeenAt, enrolledRepos: 1 });
  });

  it('prefers a fresher daemon lastTickAt for last-seen', () => {
    const writeDaemon = (lastTickAt: string) => saveDaemonState({
      running: false, pid: null, startedAt: null, lastTickAt,
      todayDate: null, todaySpentUsd: 0, itemsProcessed: 0, ticks: [],
    } as DaemonState);
    writeDaemon('2026-10-05T00:00:00.000Z');
    expect(detectComputerPairing(computer()).lastSeenAt).toBe('2026-10-05T00:00:00.000Z');
    writeDaemon('2026-09-01T12:00:00.000Z');
    expect(detectComputerPairing(computer()).lastSeenAt).toBe(PAIRED.lastSeenAt);
  });
});

describe('pairThisComputer / unpairThisComputer', () => {
  it('persists the record only when the service step is in place', async () => {
    const denied = await pairThisComputer(cfg(), { daemonService: async () => step('daemon-service', 'manual') });
    expect(denied.ok).toBe(false);
    expect(denied.computer.paired).toBe(false);
    expect(loadConfig().onboard?.computer).toBeUndefined();

    const paired = await pairThisComputer(cfg(), { daemonService: async () => step('daemon-service', 'ok') });
    expect(paired.ok).toBe(true);
    expect(loadConfig().onboard?.computer).toMatchObject({ pairedAt: expect.any(String), lastSeenAt: expect.any(String) });
    expect(paired.computer.paired).toBe(true);
  });

  it('keeps pairedAt across re-pairs and runs enroll with --yes', async () => {
    saveConfig(computer());
    const enroll = vi.fn(async (_cfg: AshlrConfig, opts: { yes: boolean }) => step('enroll', opts.yes ? 'ok' : 'detected'));
    const result = await pairThisComputer(cfg(), { daemonService: async () => step('daemon-service', 'ok'), enroll });
    expect(result.ok).toBe(true);
    expect(enroll).toHaveBeenCalledWith(expect.anything(), { yes: true });
    expect(loadConfig().onboard?.computer?.pairedAt).toBe(PAIRED.pairedAt);
    expect(loadConfig().onboard?.computer?.lastSeenAt).not.toBe(PAIRED.lastSeenAt);
  });

  it('unpair clears only the pairing record, not plan picks or enrollment', () => {
    const repo = fx.makeRepo();
    repo.enroll();
    saveConfig({ ...computer(), onboard: { planTiers: { codex: 'Pro' }, computer: PAIRED } });
    const out = unpairThisComputer();
    expect(out.ok).toBe(true);
    expect(out.computer).toMatchObject({ paired: false, enrolledRepos: 1 });
    expect(loadConfig().onboard).toMatchObject({ planTiers: { codex: 'Pro' } });
    expect(loadConfig().onboard?.computer).toBeUndefined();
    expect(unpairThisComputer().computer.paired).toBe(false);
  });
});

// ── Route-level checks through the real server pipeline ─────────────────────

const makeOpts = (o?: Partial<WebServerOptions>): WebServerOptions => ({ port: 0, open: false, allowDispatch: false, ...o });
const JSON_HEADERS = { 'Content-Type': 'application/json' };
const request = async (method: string, url: string, headers: Record<string, string> = {}, body?: string) => {
  const res = await fetch(url, { method, headers, body });
  return { statusCode: res.status, body: await res.text() };
};

describe('pairing routes', () => {
  it('GET /api/onboard/status carries the computer section', async () => {
    const h = await startServer(cfg(), makeOpts());
    openHandles.push(h);
    const res = await request('GET', `http://127.0.0.1:${h.port}/api/onboard/status`, readAuthHeaders(h.port));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { computer: { paired: boolean } };
    expect(body.computer).toMatchObject({ paired: false, serviceInstalled: false, enrolledRepos: 0 });
  });

  it('POST pair/unpair are dispatch-gated and token-gated', async () => {
    const post = (port: number, route: string, headers: Record<string, string>) =>
      request('POST', `http://127.0.0.1:${port}${route}`, headers, '{}');
    const h = await startServer(cfg(), makeOpts());
    openHandles.push(h);
    expect((await post(h.port, '/api/onboard/pair', { ...JSON_HEADERS, 'x-ashlr-token': h.token })).statusCode).toBe(404);
    expect((await post(h.port, '/api/onboard/unpair', { ...JSON_HEADERS, 'x-ashlr-token': h.token })).statusCode).toBe(404);

    const d = await startServer(cfg(), makeOpts({ allowDispatch: true }));
    openHandles.push(d);
    expect((await post(d.port, '/api/onboard/pair', { ...JSON_HEADERS, 'x-ashlr-token': 'bad' })).statusCode).toBe(401);
    expect((await post(d.port, '/api/onboard/pair', { 'x-ashlr-token': d.token })).statusCode).toBe(415);
  });

  it('unpair clears a seeded record through the route', async () => {
    const seeded = computer();
    saveConfig(seeded);
    const d = await startServer(seeded, makeOpts({ allowDispatch: true }));
    openHandles.push(d);
    const status = await request('GET', `http://127.0.0.1:${d.port}/api/onboard/status`, readAuthHeaders(d.port));
    expect((JSON.parse(status.body) as { computer: { paired: boolean } }).computer.paired).toBe(true);
    const res = await request('POST', `http://127.0.0.1:${d.port}/api/onboard/unpair`, { ...JSON_HEADERS, 'x-ashlr-token': d.token }, '{}');
    expect(res.statusCode).toBe(200);
    expect((JSON.parse(res.body) as { computer: { paired: boolean } }).computer.paired).toBe(false);
    expect(loadConfig().onboard?.computer).toBeUndefined();
  });
});
