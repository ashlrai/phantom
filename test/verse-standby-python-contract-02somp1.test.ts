import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { createFleetStandbyApi } from '../src/core/verse/fleet-standby-api.js';
import type { ApiModule } from '../src/core/verse/api-modules.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const bridge = fileURLToPath(new URL('../scripts/mac-bridge/', import.meta.url));
let root: string;
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

async function call(api: ApiModule) {
  let status = 0, text = '';
  const res = { writeHead(code: number) { status = code; return this; }, end(value: string) { text = value; } } as unknown as ServerResponse;
  expect(await api({} as VerseApiContext, {} as IncomingMessage, res, '/api/verse/fleet/standby', 'GET')).toBe(true);
  expect(status).toBe(200);
  expect(text).not.toContain(root);
  return JSON.parse(text);
}

async function setup() {
  root = await mkdtemp(join(tmpdir(), 'standby-python-contract-'));
  const db = join(root, 'private-lease.sqlite');
  const snapshotStore = join(root, 'private-snapshots');
  execFileSync('python3', ['-B', join(bridge, 'host_lease.py'), '--db', db,
    'acquire', 'leader', '--host', 'primary', '--primary', 'primary', '--ttl', '30', '--grace', '0'], { timeout: 30_000 });
  await writeFile(join(root, 'standby.json'), JSON.stringify({ v: 1, db, snapshotStore,
    primary: 'primary', role: 'leader', host: 'standby', maxAgeSec: 300 }));
}

it('projects a real not-ready Python report without exposing paths', async () => {
  await setup();
  const body = await call(createFleetStandbyApi({ runsDir: root }));
  expect(body).toMatchObject({ configured: true, available: true, ready: false,
    blocker: 'no-snapshot', leaseHolder: 'primary', snapshotAgeSec: null });
});

it('sanitizes a real child execution failure', async () => {
  await setup();
  const body = await call(createFleetStandbyApi({ runsDir: root, locateScript: () => join(root, 'private-missing-script.py') }));
  expect(body).toEqual({ v: 1, generatedAt: expect.any(String), configured: true, available: false });
});
