import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createFleetStandbyApi } from '../src/core/verse/fleet-standby-api.js';
import type { ApiModule } from '../src/core/verse/api-modules.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const execFileAsync = promisify(execFile);
const REPO = process.cwd();
const bridgeSource = join(REPO, 'scripts', 'mac-bridge');
const scriptPath = join(bridgeSource, 'standby_readiness.py');

let runsDir: string;
const clockMs = 1_700_000_000_000;
const primary = 'primary-fake';
const role = 'leader';
const standby = 'standby-fake';

beforeEach(async () => {
  runsDir = await mkdtemp(join(tmpdir(), 'standby-real-'));
});

afterEach(async () => {
  await rm(runsDir, { recursive: true, force: true });
});

/**
 * Core regression: fleet-standby-api calls the Python readiness script with
 * a bounded explicit argv ([-B, script, ...]) that permits the intended
 * sibling modules to be imported.  No shell, no PYTHONPATH, no --json.
 *
 * Per acceptance: real python3 invocation without exec mock proves the
 * argv/import fix works.  With a valid lease + empty snapshot store,
 * the Python script returns 'no-snapshot' blocker \u2192 configured:true,
 * available:false with the genuine blocker, rather than unavailable.
 */
it('real python3 argv/import fix: fake lease + no snapshot', async () => {
  // Create a lease DB.
  const sqlite = await import('node:sqlite');
  const dbPath = join(runsDir, 'lease.sqlite');
  const db = new sqlite.DatabaseSync(dbPath);
  db.exec(`CREATE TABLE leases (
    role TEXT PRIMARY KEY, holder TEXT, fencing INTEGER NOT NULL DEFAULT 0,
    expires REAL, primary_host TEXT, updated REAL NOT NULL
  )`);
  const nowSec = clockMs / 1000;
  db.exec(`INSERT INTO leases (role, holder, fencing, expires, primary_host, updated)
           VALUES ('${role}', '${primary}', 1, ${nowSec + 30}, '${primary}', ${nowSec})`);
  db.close();

  // Empty snapshot store.
  const storeDir = join(runsDir, 'snapshots');
  await mkdir(storeDir, { recursive: true });

  // Write a valid standby.json.
  const config = JSON.stringify({
    v: 1, db: dbPath, snapshotStore: storeDir, primary, role, host: standby, maxAgeSec: 300,
  });
  await writeFile(join(runsDir, 'standby.json'), config);

  // Real python3 invocation: NO exec mock \u2014 proves argv/import fix.
  const api = createFleetStandbyApi({
    runsDir, exec: (file, argv, options) => execFileAsync(file, argv, options),
    locateScript: () => scriptPath, now: () => clockMs,
  });

  const { body } = await testCall(api);
  expect(body).toBeDefined();
  expect(body.configured).toBe(true);
  expect(body.available).toBe(false);
  expect(body.blocker).toBe('no-snapshot');
  const bodyStr = JSON.stringify(body);
  expect(bodyStr).not.toContain('lease.sqlite');
  expect(bodyStr).not.toContain('snapshots');
});

/**
 * Prove unavailable when lease db is missing (Python returns no-lease-db).
 */
it('real python3 returns blocker no-lease-db when DB is absent', async () => {
  const storeDir = join(runsDir, 'snapshots');
  await mkdir(storeDir, { recursive: true });

  const config = JSON.stringify({
    v: 1, db: '/no/such/db.sqlite', snapshotStore: storeDir, primary, role, host: standby,
  });
  await writeFile(join(runsDir, 'standby.json'), config);

  const api = createFleetStandbyApi({
    runsDir, exec: (file, argv, options) => execFileAsync(file, argv, options),
    locateScript: () => scriptPath, now: () => clockMs,
  });

  const { body } = await testCall(api);
  expect(body.configured).toBe(true);
  expect(body.available).toBe(false);
  expect(body.blocker).toBe('no-lease-db');
  expect(JSON.stringify(body)).not.toContain('/no/such/db');
});

/**
 * Cache coalescing: multiple concurrent API calls coalesce to one Python invocation.
 */
it('cache coalescing works with real python3 invocation', async () => {
  const sqlite = await import('node:sqlite');
  const dbPath = join(runsDir, 'lease.sqlite');
  const db = new sqlite.DatabaseSync(dbPath);
  db.exec(`CREATE TABLE leases (
    role TEXT PRIMARY KEY, holder TEXT, fencing INTEGER NOT NULL DEFAULT 0,
    expires REAL, primary_host TEXT, updated REAL NOT NULL
  )`);
  const nowSec = clockMs / 1000;
  db.exec(`INSERT INTO leases (role, holder, fencing, expires, primary_host, updated)
           VALUES ('${role}', '${primary}', 1, ${nowSec + 30}, '${primary}', ${nowSec})`);
  db.close();

  const storeDir = join(runsDir, 'snapshots');
  await mkdir(storeDir, { recursive: true });

  const config = JSON.stringify({
    v: 1, db: dbPath, snapshotStore: storeDir, primary, role, host: standby, maxAgeSec: 300,
  });
  await writeFile(join(runsDir, 'standby.json'), config);

  // Count real Python invocations using a wrapper.
  let invocationCount = 0;
  const wrappedExec = (file: string, argv: readonly string[], options: any) =>
    execFileAsync(file, argv, options).then(r => {
      invocationCount++;
      return r;
    });

  const api = createFleetStandbyApi({
    runsDir, exec: wrappedExec, locateScript: () => scriptPath,
    now: () => clockMs,
  });

  // Call the API twice quickly (within the 30s cache window).
  const [first, second] = await Promise.all([testCall(api), testCall(api)]);

  expect(first.body).toEqual(second.body);
  expect(invocationCount).toBe(1);  // Coalesced to one Python invocation.
  expect(first.body.available).toBe(false);
  expect(first.body.blocker).toBe('no-snapshot');
});

function testCall(api: ApiModule): Promise<{ body: unknown; status: number }> {
  return new Promise((resolve) => {
    let status = 0;
    let text = '';
    const res = {
      writeHead(code: number) { status = code; return this; },
      end(value: string) { text = value; },
    } as unknown as import('node:http').ServerResponse;
    void api(
      {} as VerseApiContext,
      {} as import('node:http').IncomingMessage,
      res,
      '/api/verse/fleet/standby',
      'GET',
    ).then(() => {
      resolve({ body: text ? JSON.parse(text) : null, status });
    });
  });
}
