import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NEEDS_YOU_SOURCES } from '../verse/workbench-types.js';

const mocks = vi.hoisted(() => ({
  push: vi.fn(async () => ({ attempted: 1, delivered: 1, retired: 0 })),
  telegram: vi.fn(async (_text: string, _opts?: unknown, _cfg?: unknown): Promise<{ ok: boolean }> => { throw new Error('Telegram unavailable'); }),
  assets: '',
}));
vi.mock('../config.js', async (original) => ({
  ...await original<typeof import('../config.js')>(),
  loadConfigReadOnly: () => ({ comms: { enabled: true, channel: 'telegram', telegram: { chatId: '12345', botToken: 'fake-token-123' } } }),
}));
vi.mock('../integrations/telegram.js', () => ({ sendTelegramMessage: mocks.telegram }));
vi.mock('./server.js', () => ({ assetsDir: () => mocks.assets }));
vi.mock('./remote-device-store.js', () => ({ createRemoteDeviceStore: () => ({}) }));
vi.mock('./remote-pairing.js', () => ({ createRemotePairing: () => ({}) }));
vi.mock('./remote-push-vapid.js', () => ({ loadOrCreateRemoteVapid: () => ({}) }));
vi.mock('./remote-push.js', () => ({ createRemotePush: () => ({ send: mocks.push, close: vi.fn() }) }));
vi.mock('./remote-gateway.js', () => ({ startRemoteReadGateway: async () => ({ close: async () => undefined }) }));
vi.mock('./remote-admin.js', () => ({ startRemoteAdminSocket: async () => ({ close: async () => undefined }) }));

import { startRemoteRuntime } from './remote-runtime.js';

describe('remote runtime Telegram fan-out', () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
  it('delivers a watcher intent to both sinks even when Telegram rejects', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fleet-fanout-'));
    mocks.assets = root;
    mkdirSync(join(root, 'next'));
    writeFileSync(join(root, 'next', 'index.html'), 'phone');
    const path = join(root, 'remote.json');
    writeFileSync(path, JSON.stringify({ gatewayPort: 3201, access: {
      publicOrigin: 'https://phone.example.com', teamDomain: 'https://team.cloudflareaccess.com',
      audience: 'a'.repeat(64), allowedSubjects: ['fake-user-123'],
    } }), { mode: 0o600 });
    let held = false;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url.endsWith('/fleet/runs') ? {
      mergesLastHour: { items: [] }, lanes: [{ lane: 'codex-personal', held, heldReason: held ? 'usage_limit' : null }], claudeLane: 'up',
    } : { cursor: 'c1', needsYou: [], completions: [],
      sources: Object.fromEntries(NEEDS_YOU_SOURCES.map((source) => [source, 'ok'])) })));
    vi.useFakeTimers();
    let runtime: Awaited<ReturnType<typeof startRemoteRuntime>> | undefined;
    try {
      runtime = await startRemoteRuntime(path, { port: 3200, readToken: 'fake-read', token: 'fake-token' });
      await vi.advanceTimersByTimeAsync(0);
      held = true;
      await vi.advanceTimersByTimeAsync(15_000);
      expect(mocks.push).toHaveBeenCalledExactlyOnceWith('fleet-lane-held', { detail: 'codex-personal: usage_limit' });
      expect(mocks.telegram).toHaveBeenCalledOnce();
      expect(mocks.telegram.mock.calls[0]?.[0]).toBe('Fleet: lane codex-personal held — usage_limit');
    } finally {
      await runtime?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
