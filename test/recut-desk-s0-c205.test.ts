/**
 * RQ-PHX-RECUTDESKS0C205 — regression for the hand-reapplied dispatcher wiring
 * of /api/ui-settings. src/core/web/api.ts was the only file that conflicted
 * on this recut (master had added the leader-thread import at the same line);
 * this proves the route still answers through the real handleApi dispatcher
 * and that PUT stays behind --allow-dispatch on current master.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AshlrConfig } from '../src/core/types.js';
import { handleApi } from '../src/core/web/api.js';

let home: string;
let realHome: string | undefined;
let server: Server | undefined;

beforeEach(() => {
  realHome = process.env['HOME'];
  home = mkdtempSync(join(tmpdir(), 'recut-desk-s0-c205-'));
  process.env['HOME'] = home;
});
afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
  if (realHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = realHome;
  rmSync(home, { recursive: true, force: true });
});

const start = async (allowDispatch: boolean) => {
  server = createServer((req, res) => {
    void handleApi(req, res, {} as AshlrConfig, { token: 'tok', allowDispatch });
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
};

describe('/api/ui-settings dispatcher wiring (recut s0-c205)', () => {
  it('answers GET through handleApi and keeps PUT behind --allow-dispatch', async () => {
    const base = await start(false);

    const getRes = await fetch(`${base}/api/ui-settings`);
    expect(getRes.status).toBe(200);
    const body = await getRes.json();
    expect(body).toMatchObject({ exists: false, path: '~/.ashlr/ui.json' });
    expect(body.settings.appearance).toHaveProperty('theme');
    expect(body.settings.layout).toHaveProperty('sidebarWidth');

    const putRes = await fetch(`${base}/api/ui-settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-ashlr-token': 'tok' },
      body: JSON.stringify({ appearance: { theme: 'dark' } }),
    });
    expect(putRes.status).toBe(404);
  });
});
