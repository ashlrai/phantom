import { execFile } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { FleetStandbyExec } from '../src/cli/fleet-standby.js';
import type { ApiModule } from '../src/core/verse/api-modules.js';
import { createFleetStandbyApi } from '../src/core/verse/fleet-standby-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const SCRIPT = fileURLToPath(new URL('../scripts/mac-bridge/standby_readiness.py', import.meta.url));
const execFileAsync = promisify(execFile);
let dir: string;
let config: Record<string, unknown>;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'standby-real-probe-'));
  config = { v: 1, db: join(dir, 'missing-lease.sqlite'), snapshotStore: join(dir, 'missing-snapshots'),
    primary: 'primary-fake', role: 'worker-fake', host: 'standby-fake' };
  await writeFile(join(dir, 'standby.json'), JSON.stringify(config));
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

async function get(api: ApiModule) {
  let status = 0, text = '';
  const res = { writeHead(code: number) { status = code; return this; }, end(value: string) { text = value; } } as unknown as ServerResponse;
  expect(await api({} as VerseApiContext, {} as IncomingMessage, res, '/api/verse/fleet/standby', 'GET')).toBe(true);
  return { status, text, body: JSON.parse(text) };
}

it('runs the real readiness script and projects its blocker', async () => {
  const calls: string[][] = [];
  const exec: FleetStandbyExec = async (file, argv, options) => {
    calls.push([...argv]);
    return execFileAsync(file, argv, options);
  };
  const before = readdirSync(dir).sort();
  const { status, text, body } = await get(createFleetStandbyApi({ runsDir: dir, exec, locateScript: () => SCRIPT }));
  expect(status).toBe(200);
  expect(body).toMatchObject({ configured: true, available: true, ready: false, blocker: 'no-lease-db' });
  expect(calls).toHaveLength(1);
  expect(calls[0]![0]).toBe('-B');
  expect(calls[0]).not.toContain('--json');
  expect(calls[0]).not.toContain('-I');
  expect(existsSync(config.db as string)).toBe(false);
  expect(existsSync(config.snapshotStore as string)).toBe(false);
  expect(readdirSync(dir).sort()).toEqual(before);
  expect(text).not.toContain(dir);
  expect(text).not.toMatch(/stderr|Traceback/);
});

it('reports unavailable without leaking diagnostics when launch fails', async () => {
  const exec: FleetStandbyExec = async () => { throw Object.assign(new Error(`spawn python3 ENOENT ${dir}`), { code: 'ENOENT', stderr: 'private diagnostic' }); };
  const { status, text, body } = await get(createFleetStandbyApi({ runsDir: dir, exec, locateScript: () => SCRIPT }));
  expect(status).toBe(200);
  expect(body).toMatchObject({ configured: true, available: false });
  expect(text).not.toContain(dir);
  expect(text).not.toContain('private diagnostic');
});
