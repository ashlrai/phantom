/**
 * onboard-detect.test.ts - RQ-ONB-2 DETECT. Covers the read-only probes in
 * src/core/readiness.ts, detectOnboardResources + persistOnboardPlanTier in
 * src/core/onboard.ts, and the /api/onboard/{status,plan-tier} routes:
 * installed is the `which` answer, loginState comes ONLY from the CLI's own
 * status command (token files are never read), picks validate + persist to
 * cfg.onboard.planTiers, the POST is dispatch-gated, and no credential
 * material leaves the response. Hermetic: tmp HOME; PATH is restricted to a
 * fakebin dir + system dirs so ambient CLIs are invisible and never probed.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { makeFixture, makeCfg, type H1Fixture } from './helpers/h1-fixture.js';
import { readAuthHeaders, startServer } from './helpers/authenticated-web-server.js';
import {
  detectOnboardResources,
  listOnboardScheduledAgents,
  persistOnboardPlanTier,
  summarizeOnboardBalance,
} from '../src/core/onboard.js';
import { RESOURCE_CATALOG } from '../src/core/onboard/catalog.js';
import { envKeyPresent, probeCliLogin, probeLoopbackEndpoint, resolveCliOnPath } from '../src/core/readiness.js';
import { saveAutomation } from '../src/core/automations/index.js';
import { loadConfig } from '../src/core/config.js';
import type { WebServerOptions } from '../src/core/types.js';

let fx: H1Fixture;
let prevPath: string | undefined;
let openHandles: Array<{ close(): Promise<void> }> = [];

const cfg = (o?: Parameters<typeof makeCfg>[0]) => makeCfg(o);
const byId = <T extends { id: string }>(rows: T[], id: string): T => rows.find((r) => r.id === id)!;

/** PATH := fakebin + system dirs: ambient CLIs vanish; `which`/`sh` still work. */
function useFakeBin(): string {
  const dir = join(fx.home, 'fakebin');
  mkdirSync(dir, { recursive: true });
  process.env.PATH = `${dir}:/usr/bin:/bin`;
  return dir;
}
const fakeCli = (dir: string, name: string, script: string) => {
  const file = join(dir, name);
  writeFileSync(file, `#!/bin/sh\n${script}\n`);
  chmodSync(file, 0o755);
};

beforeEach(() => {
  fx = makeFixture();
  prevPath = process.env.PATH;
  openHandles = [];
});
afterEach(async () => {
  process.env.PATH = prevPath;
  for (const h of openHandles) await h.close().catch(() => undefined);
  fx.cleanup();
});

describe('detectOnboardResources', () => {
  it('reports spec-shaped rows; binaries resolve via `which`, verdicts via status command', async () => {
    const bin = useFakeBin();
    const empty = await detectOnboardResources(cfg());
    expect(empty.map((r) => r.id)).toEqual(RESOURCE_CATALOG.map((r) => r.id));
    for (const row of empty) {
      expect(row).toMatchObject({
        installed: false, binaryPath: null, loginState: null, selectedPlanTier: null,
      });
    }
    // keyEnvName rows report presence-only booleans; loopback endpoints probe.
    for (const row of empty) {
      const entry = RESOURCE_CATALOG.find((r) => r.id === row.id)!;
      if (entry.keyEnvName) expect(typeof row.keyPresent).toBe('boolean');
      else expect(row.keyPresent).toBeNull();
      if (entry.validateEndpoint?.startsWith('http://127.0.0.1')) expect(typeof row.endpointUp).toBe('boolean');
      else expect(row.endpointUp).toBeNull();
    }

    fakeCli(bin, 'codex', 'echo "Logged in using ChatGPT"');
    fakeCli(bin, 'claude', 'echo "Not logged in"; exit 1');
    const rows = await detectOnboardResources(
      cfg({ onboard: { planTiers: { codex: 'Pro', 'claude-code': 'Stale' } } }));
    expect(byId(rows, 'codex')).toMatchObject({
      installed: true, binaryPath: join(bin, 'codex'), loginState: 'logged-in',
      loginCommand: 'codex login', selectedPlanTier: 'Pro',
    });
    expect(byId(rows, 'claude-code')).toMatchObject({ loginState: 'logged-out', selectedPlanTier: null });
    expect(byId(rows, 'devin').installed).toBe(false);
  });
});

describe('readiness probes', () => {
  it('resolveCliOnPath sanitizes names; probeCliLogin reads only status output', async () => {
    const bin = useFakeBin();
    fakeCli(bin, 'codex', 'exit 0');
    expect(resolveCliOnPath('codex')).toMatch(/codex$/);
    expect(resolveCliOnPath('definitely-not-a-real-binary-xyz')).toBeNull();
    expect(resolveCliOnPath('../escape')).toBeNull();
    expect(resolveCliOnPath('codex; rm -rf ~')).toBeNull();

    fakeCli(bin, 'fakecli', 'echo "Logged in using ChatGPT"');
    expect(await probeCliLogin('fakecli login status')).toBe('logged-in');
    fakeCli(bin, 'fakecli', 'echo "Not logged in"; exit 1');
    expect(await probeCliLogin('fakecli login status')).toBe('logged-out');
    fakeCli(bin, 'fakecli', 'echo "{\\"loggedIn\\":false}"');
    expect(await probeCliLogin('fakecli auth status')).toBe('logged-out');
    fakeCli(bin, 'fakecli', 'echo "error"; exit 1');
    expect(await probeCliLogin('fakecli login status')).toBe('unknown');
    expect(await probeCliLogin('definitely-not-a-real-binary-xyz status')).toBe('unknown');
  });

  it('envKeyPresent is presence-only and probeLoopbackEndpoint refuses non-loopback urls', async () => {
    const name = 'ASHLR_ONB7_TEST_KEY';
    delete process.env[name];
    expect(envKeyPresent(name)).toBe(false);
    process.env[name] = 'onb7-sentinel-not-a-real-key';
    expect(envKeyPresent(name)).toBe(true);
    delete process.env[name];
    // Outbound apikey validate endpoints are never dialed by the connect probe.
    for (const entry of RESOURCE_CATALOG.filter((r) => r.kind === 'apikey')) {
      expect(entry.validateEndpoint?.startsWith('https://')).toBe(true);
      expect(await probeLoopbackEndpoint(entry.validateEndpoint!)).toBeNull();
    }
    // A loopback url probes (nothing serves the port here -> false, still real).
    expect(await probeLoopbackEndpoint('http://127.0.0.1:9/unreachable')).toBe(false);
  });
});

describe('persistOnboardPlanTier', () => {
  it('persists valid picks, clears on null, and rejects off-catalog input', () => {
    expect(persistOnboardPlanTier({ resourceId: 'codex', planTier: 'Pro' }))
      .toEqual({ ok: true, resourceId: 'codex', planTier: 'Pro' });
    expect(loadConfig().onboard?.planTiers?.codex).toBe('Pro');
    persistOnboardPlanTier({ resourceId: 'codex', planTier: null });
    expect(loadConfig().onboard?.planTiers?.codex).toBeUndefined();
    for (const bad of [
      { resourceId: 'nope', planTier: 'Pro' },
      { resourceId: 'this-computer', planTier: 'Pro' },
      { resourceId: 'codex', planTier: 'Diamond' },
      'codex',
    ]) expect(persistOnboardPlanTier(bad).ok).toBe(false);
  });
});

// ── Route-level checks through the real server pipeline ─────────────────────

async function request(
  method: string, url: string, headers: Record<string, string> = {}, body?: string,
) {
  const res = await fetch(url, { method, headers, body });
  return { statusCode: res.status, body: await res.text() };
}

const makeOpts = (overrides: Partial<WebServerOptions> = {}): WebServerOptions =>
  ({ port: 0, open: false, allowDispatch: false, ...overrides });
const JSON_HEADERS = { 'Content-Type': 'application/json' };

describe('scheduled agents + balance', () => {
  const seedAgents = async () => {
    await saveAutomation({
      name: 'Nightly flaky test hunt', enabled: true,
      trigger: { kind: 'schedule', rrule: 'freq=daily;byhour=2' },
      lane: 'fleet', repos: ['*'],
    });
    await saveAutomation({
      name: 'Issue watcher', enabled: true,
      trigger: { kind: 'github-issues', labels: ['ashlr'], query: null, includePrs: false, pollMinutes: 15 },
      lane: 'fleet', repos: ['*'],
    });
  };

  it('listOnboardScheduledAgents reports schedule-triggered automations only', async () => {
    expect((await listOnboardScheduledAgents()).agents).toEqual([]);
    await seedAgents();
    const report = await listOnboardScheduledAgents();
    // The scheduler refuses to tick inside a test process - reported honestly.
    expect(report.schedulerRunning).toBe(false);
    expect(report.agents).toHaveLength(1);
    expect(report.agents[0]).toMatchObject({
      name: 'Nightly flaky test hunt', enabled: true, rrule: 'FREQ=DAILY;BYHOUR=2',
    });
    expect(report.agents[0]!.id).toMatch(/^au_/);
    expect(report.agents[0]!.nextRunAt).toBeNull();
  });

  it('summarizeOnboardBalance marks real evidence and never invents usage', async () => {
    useFakeBin();
    const prevKey = process.env.XAI_API_KEY;
    process.env.XAI_API_KEY = 'onb7-sentinel-not-a-real-key';
    await seedAgents();
    const resources = await detectOnboardResources(cfg());
    const agents = await listOnboardScheduledAgents();
    const balance = await summarizeOnboardBalance(cfg(), resources, agents);
    if (prevKey === undefined) delete process.env.XAI_API_KEY;
    else process.env.XAI_API_KEY = prevKey;

    const grok = byId(balance.resources, 'grok');
    expect(grok).toMatchObject({ connected: true, evidence: 'key-present', usage: null });
    expect(byId(balance.resources, 'this-computer')).toMatchObject({ connected: true, evidence: 'self' });
    expect(byId(balance.resources, 'proactive-agents')).toMatchObject({ connected: true, evidence: 'scheduled-agents' });
    // codex/claude-code rows carry the real local ledger count even signed out.
    expect(byId(balance.resources, 'codex').usage).toMatchObject({ callsToday: expect.any(Number) });
    expect(byId(balance.resources, 'openai').usage).toBeNull();
    expect(byId(balance.resources, 'openai').planTiers).toEqual(['API']);
    expect(balance.connected).toEqual(expect.arrayContaining(['grok', 'this-computer', 'proactive-agents']));
    expect(balance.scheduledAgents).toEqual({ total: 1, enabled: 1 });
    expect(JSON.stringify(balance)).not.toContain('onb7-sentinel');
  });
});

describe('GET /api/onboard/status', () => {
  it('answers one detected row per catalog entry with no credential material', async () => {
    useFakeBin();
    process.env.ASHLR_TEST_SENTINEL = 's3ntinel-value';
    const h = await startServer(cfg(), makeOpts());
    openHandles.push(h);
    const res = await request('GET', `http://127.0.0.1:${h.port}/api/onboard/status`,
      readAuthHeaders(h.port));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      dispatchEnabled: boolean;
      resources: Array<{ id: string; installed: boolean; loginCommand: string | null }>;
      agents: { schedulerRunning: boolean; agents: unknown[] };
      balance: { connected: string[]; scheduledAgents: { total: number; enabled: number }; resources: unknown[] };
    };
    expect(body.dispatchEnabled).toBe(false);
    expect(body.resources.map((r) => r.id)).toEqual(RESOURCE_CATALOG.map((r) => r.id));
    expect(byId(body.resources, 'codex').loginCommand).toBe('codex login');
    expect(body.agents.agents).toEqual([]);
    expect(body.balance.resources).toHaveLength(RESOURCE_CATALOG.length);
    expect(body.balance.connected).toContain('this-computer');
    expect(res.body).not.toContain('s3ntinel-value');
    delete process.env.ASHLR_TEST_SENTINEL;
  });

  it('lists scheduled agents and the existing verse route toggles them', async () => {
    useFakeBin();
    const { automation } = await saveAutomation({
      name: 'Nightly flaky test hunt', enabled: true,
      trigger: { kind: 'schedule', rrule: 'freq=daily;byhour=2' },
      lane: 'fleet', repos: ['*'],
    });
    const h = await startServer(cfg(), makeOpts({ allowDispatch: true }));
    openHandles.push(h);
    const get = () => request('GET', `http://127.0.0.1:${h.port}/api/onboard/status`, readAuthHeaders(h.port));
    const body = JSON.parse((await get()).body) as {
      agents: { agents: Array<{ id: string; enabled: boolean; rrule: string }> };
      balance: { scheduledAgents: { total: number; enabled: number } };
    };
    expect(body.agents.agents).toEqual([
      expect.objectContaining({ id: automation.id, enabled: true, rrule: 'FREQ=DAILY;BYHOUR=2' }),
    ]);
    expect(body.balance.scheduledAgents).toEqual({ total: 1, enabled: 1 });

    const off = await request('POST', `http://127.0.0.1:${h.port}/api/verse/automations/${automation.id}/disable`,
      { ...JSON_HEADERS, 'x-ashlr-token': h.token }, '{}');
    expect(off.statusCode).toBe(200);
    const after = JSON.parse((await get()).body) as { agents: { agents: Array<{ enabled: boolean }> } };
    expect(after.agents.agents[0]!.enabled).toBe(false);
  });
});

describe('POST /api/onboard/plan-tier', () => {
  const post = (port: number, headers: Record<string, string>, body: string) =>
    request('POST', `http://127.0.0.1:${port}/api/onboard/plan-tier`, headers, body);

  it('404s without --allow-dispatch; requires token + JSON otherwise', async () => {
    const h = await startServer(cfg(), makeOpts());
    openHandles.push(h);
    expect((await post(h.port, { ...JSON_HEADERS, 'x-ashlr-token': h.token },
      JSON.stringify({ resourceId: 'codex', planTier: 'Pro' }))).statusCode).toBe(404);

    const d = await startServer(cfg(), makeOpts({ allowDispatch: true }));
    openHandles.push(d);
    expect((await post(d.port, { ...JSON_HEADERS, 'x-ashlr-token': 'bad' }, '{}')).statusCode).toBe(401);
    expect((await post(d.port, { 'x-ashlr-token': d.token }, '{}')).statusCode).toBe(415);
    expect((await post(d.port, { ...JSON_HEADERS, 'x-ashlr-token': d.token }, 'not-json')).statusCode).toBe(400);
  });

  it('persists a valid pick and validates the rest', async () => {
    const h = await startServer(cfg(), makeOpts({ allowDispatch: true }));
    openHandles.push(h);
    const auth = { ...JSON_HEADERS, 'x-ashlr-token': h.token };
    const ok = await post(h.port, auth, JSON.stringify({ resourceId: 'codex', planTier: 'Pro' }));
    expect(ok.statusCode).toBe(200);
    expect(JSON.parse(ok.body)).toEqual({ ok: true, resourceId: 'codex', planTier: 'Pro' });
    expect(loadConfig().onboard?.planTiers?.codex).toBe('Pro');
    expect((await post(h.port, auth, JSON.stringify({ resourceId: 'codex', planTier: 'Diamond' }))).statusCode).toBe(400);
    expect((await post(h.port, auth, JSON.stringify({ resourceId: 'devin', planTier: 'Nope' }))).statusCode).toBe(400);
  });
});
