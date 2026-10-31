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
import { detectOnboardResources, persistOnboardPlanTier } from '../src/core/onboard.js';
import { RESOURCE_CATALOG } from '../src/core/onboard/catalog.js';
import { probeCliLogin, resolveCliOnPath } from '../src/core/readiness.js';
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
    };
    expect(body.dispatchEnabled).toBe(false);
    expect(body.resources.map((r) => r.id)).toEqual(RESOURCE_CATALOG.map((r) => r.id));
    expect(byId(body.resources, 'codex').loginCommand).toBe('codex login');
    expect(res.body).not.toContain('s3ntinel-value');
    delete process.env.ASHLR_TEST_SENTINEL;
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
