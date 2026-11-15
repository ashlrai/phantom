// RQ-PHX-STEERSCREENSHOT90: POST /api/verse/fleet/runs/inbox accepts an
// optional base64 screenshot. The server — not the client type — decides the
// format from magic bytes, stores it under <runsDir>/leader/inbound/screens
// (dir 0700, file 0600), and the MASON-INBOX.md line ends with
// ` [image: <absolute path>]` so the next leader pass can open it. Request-id
// and receipt dedupe replay without writing a second file.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import type { AshlrConfig } from '../src/core/types.js';
import { createFleetRunsApi, type FleetRunsApiDeps } from '../src/core/verse/fleet-runs-api.js';
import { VERSE_FLEET_RUNS_INBOX_PATH as INBOX } from '../src/core/verse/fleet-runs-types.js';

const TOKEN = 'interject-image-route-token';
const NOW = Date.parse('2026-11-10T12:00:00Z');
const STAMP = '20261110T120000Z';
const TEXT = 'Fleet page looks wrong here';

// Tiny generated fixtures — magic bytes plus padding, never real screenshots.
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24, 0x42)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(24, 0x43)]);
const GIF = Buffer.from('GIF89a fake screenshot bytes'.split('').map(c => c.charCodeAt(0)));

const dirs: string[] = [];
function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
beforeEach(() => { vi.stubEnv('ASHLR_RUNS_DIR', tmp('interject-image-env-')); });
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function deps(root: string, runsDir: string): FleetRunsApiDeps {
  return {
    runsDir,
    now: () => NOW,
    ownerThread: { runsDir: join(root, 'owner-runs'), configDir: join(root, 'owner-config') },
  };
}

interface Reply { status: number; wire: Record<string, unknown> | null }

async function post(api: ReturnType<typeof createFleetRunsApi>, body: unknown): Promise<Reply> {
  const req = Readable.from([JSON.stringify(body ?? {})]) as unknown as IncomingMessage;
  req.url = INBOX;
  req.method = 'POST';
  req.headers = { 'content-type': 'application/json', 'x-ashlr-token': TOKEN };
  let status = 0;
  let wire: Record<string, unknown> | null = null;
  const res = {
    headersSent: false,
    writeHead(code: number) { status = code; this.headersSent = true; },
    end(text: string) { try { wire = JSON.parse(text); } catch { wire = null; } },
  } as unknown as ServerResponse;
  const ctx = { cfg: {} as AshlrConfig, token: TOKEN, allowDispatch: true } as VerseApiContext;
  await api(ctx, req, res, INBOX, 'POST');
  return { status, wire };
}

const screensDir = (runsDir: string) => join(runsDir, 'leader', 'inbound', 'screens');
const inboxText = (runsDir: string) => readFileSync(join(runsDir, 'leader', 'MASON-INBOX.md'), 'utf8');

describe('interject screenshot upload (RQ-PHX-STEERSCREENSHOT90)', () => {
  it('stores a valid PNG at mode 0600 under leader/inbound/screens and tags the inbox line', async () => {
    const root = tmp('interject-image-root-');
    const runsDir = join(root, 'runs');
    const api = createFleetRunsApi(deps(root, runsDir));
    const reply = await post(api, { text: TEXT, image: PNG.toString('base64'), requestId: `req-${randomUUID()}` });
    expect(reply.status).toBe(201);
    expect(reply.wire).toMatchObject({ ok: true, accepted: true });

    const dir = screensDir(runsDir);
    const sha = createHash('sha256').update(PNG).digest('hex').slice(0, 8);
    const file = join(dir, `${STAMP}-${sha}.png`);
    expect(readdirSync(dir)).toEqual([`${STAMP}-${sha}.png`]);
    expect(readFileSync(file)).toEqual(PNG);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);

    const line = inboxText(runsDir).split('\n').find(row => row.includes('[src:'))!;
    expect(line).toContain(TEXT);
    expect(line.endsWith(` [image: ${file}]`)).toBe(true);
  });

  it('stores a JPEG with the .jpg extension from its own magic bytes', async () => {
    const root = tmp('interject-image-root-');
    const runsDir = join(root, 'runs');
    const api = createFleetRunsApi(deps(root, runsDir));
    const reply = await post(api, { text: TEXT, image: JPEG.toString('base64') });
    expect(reply.status).toBe(201);
    const sha = createHash('sha256').update(JPEG).digest('hex').slice(0, 8);
    expect(readdirSync(screensDir(runsDir))).toEqual([`${STAMP}-${sha}.jpg`]);
  });

  it('replays the same requestId without writing a second file or line', async () => {
    const root = tmp('interject-image-root-');
    const runsDir = join(root, 'runs');
    const api = createFleetRunsApi(deps(root, runsDir));
    const requestId = `req-${randomUUID()}`;
    const body = { text: TEXT, image: PNG.toString('base64'), requestId };
    const first = await post(api, body);
    expect(first.status).toBe(201);

    // The request-id ledger replays the first response verbatim; nothing is
    // appended or stored again.
    const again = await post(api, body);
    expect(again.status).toBe(first.status);
    expect(again.wire).toEqual(first.wire);
    expect(readdirSync(screensDir(runsDir))).toHaveLength(1);
    expect(inboxText(runsDir).split('\n').filter(row => row.includes('[src:'))).toHaveLength(1);

    // A different requestId with the same image is a new message — new line.
    const second = await post(api, { text: TEXT, image: PNG.toString('base64'), requestId: `req-${randomUUID()}` });
    expect(second.status).toBe(201);
    expect(inboxText(runsDir).split('\n').filter(row => row.includes('[src:'))).toHaveLength(2);
  });

  it('rejects a payload whose bytes are not PNG or JPEG', async () => {
    const root = tmp('interject-image-root-');
    const runsDir = join(root, 'runs');
    const api = createFleetRunsApi(deps(root, runsDir));
    const reply = await post(api, { text: TEXT, image: GIF.toString('base64') });
    expect(reply.status).toBe(400);
    expect(reply.wire?.code).toBe('VERSE_INVALID');
    expect(() => readdirSync(screensDir(runsDir))).toThrow();
    expect(() => inboxText(runsDir)).toThrow();
  });

  it.each([{ image: 42 }, { image: { data: PNG.toString('base64') } }, { image: 'not base64!!' }])(
    'rejects a malformed image field %j', async ({ image }) => {
      const root = tmp('interject-image-root-');
      const runsDir = join(root, 'runs');
      const api = createFleetRunsApi(deps(root, runsDir));
      const reply = await post(api, { text: TEXT, image });
      expect(reply.status).toBe(400);
      expect(reply.wire?.code).toBe('VERSE_INVALID');
    });

  it('rejects an image over 5 MiB', async () => {
    const root = tmp('interject-image-root-');
    const runsDir = join(root, 'runs');
    const api = createFleetRunsApi(deps(root, runsDir));
    const fat = Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024, 0x44)]);
    const reply = await post(api, { text: TEXT, image: fat.toString('base64') });
    expect(reply.status).toBe(400);
    expect(reply.wire?.code).toBe('VERSE_INVALID');
    expect(() => readdirSync(screensDir(runsDir))).toThrow();
  });

  it('refuses a client-supplied file name or path field entirely', async () => {
    const root = tmp('interject-image-root-');
    const runsDir = join(root, 'runs');
    const api = createFleetRunsApi(deps(root, runsDir));
    for (const extra of [{ path: '/tmp/evil.png' }, { name: 'evil.png' }, { filename: 'evil.png' }]) {
      const reply = await post(api, { text: TEXT, image: PNG.toString('base64'), ...extra });
      expect(reply.status).toBe(400);
      expect(reply.wire?.code).toBe('VERSE_INVALID');
    }
    expect(() => readdirSync(screensDir(runsDir))).toThrow();
  });
});
