import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetContextPack } from '../src/cli/fleet-context-pack.js';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import { handleLibraryPinsApi } from '../src/core/verse/library-pins-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import { addPin, LIBRARY_PINS_MAX, LibraryPinError, libraryPinsPath, listPins, removePin } from '../src/core/fleet/library-pins.js';

let home: string;
let clock: number;
const opts = () => ({ home, now: () => clock++ });
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'pins-')); clock = 1_793_577_600_000; });
afterEach(async () => { vi.restoreAllMocks(); await rm(home, { recursive: true, force: true }); });

describe('library pins store', () => {
  it('adds, dedupes by kind+ref, lists newest first and removes', () => {
    expect(listPins(opts())).toEqual([]);
    const first = addPin({ kind: 'memory', ref: '/work/alpha', title: 'alpha memory' }, opts());
    const second = addPin({ kind: 'bus', ref: 'm42', title: 'worker-1 → leader: done' }, opts());
    expect(first.id).toMatch(/^pin_[a-f0-9]{12}$/);
    expect(addPin({ kind: 'memory', ref: '/work/alpha', title: 'renamed' }, opts())).toEqual(first);
    // Same ref under another kind is a separate pin.
    addPin({ kind: 'file', ref: '/work/alpha', title: 'alpha folder' }, opts());
    expect(listPins(opts()).map((pin) => pin.kind)).toEqual(['file', 'bus', 'memory']);
    expect(removePin(second.id, opts())).toBe(true);
    expect(removePin(second.id, opts())).toBe(false);
    expect(listPins(opts())).toHaveLength(2);
  });

  it('keeps at most the cap, dropping the oldest', () => {
    for (let i = 0; i <= LIBRARY_PINS_MAX; i++) addPin({ kind: 'note', ref: `note-${i}`, title: `note ${i}` }, opts());
    const pins = listPins(opts());
    expect(pins).toHaveLength(LIBRARY_PINS_MAX);
    expect(pins.some((pin) => pin.ref === 'note-0')).toBe(false);
    expect(pins[0]!.ref).toBe(`note-${LIBRARY_PINS_MAX}`);
  });

  it('writes atomically with mode 0600 and leaves no temp file', async () => {
    addPin({ kind: 'note', ref: 'plan', title: 'the plan' }, opts());
    expect(await readdir(join(home, '.phantom'))).toEqual(['library-pins.json']);
    if (process.platform !== 'win32') expect((await stat(libraryPinsPath(home))).mode & 0o777).toBe(0o600);
  });

  it('rejects secret-shaped refs and titles, bad kinds and long titles, writing nothing', () => {
    const fake = 'sk-' + 'FAKE0000000000000000';
    expect(() => addPin({ kind: 'note', ref: fake, title: 'key' }, opts())).toThrow(/looks like a secret/);
    expect(() => addPin({ kind: 'note', ref: 'ok', title: `token ${fake}` }, opts())).toThrow(LibraryPinError);
    expect(() => addPin({ kind: 'secret', ref: 'ok', title: 'ok' }, opts())).toThrow(/kind must be/);
    expect(() => addPin({ kind: 'note', ref: 'ok', title: 'x'.repeat(161) }, opts())).toThrow(/1 to 160/);
    expect(() => addPin({ kind: 'note', ref: 'two\nlines', title: 'ok' }, opts())).toThrow(LibraryPinError);
    expect(listPins(opts())).toEqual([]);
  });

  it('refuses a damaged store instead of resetting it', async () => {
    await mkdir(join(home, '.phantom'));
    await writeFile(libraryPinsPath(home), '{"v":1,"pins":[{"id":"nope"}]}');
    expect(() => listPins(opts())).toThrow(/damaged/);
    expect(() => addPin({ kind: 'note', ref: 'a', title: 'a' }, opts())).toThrow(/damaged/);
  });
});

describe('context pack pins section', () => {
  let runs: string;
  const now = 1793577600000;
  const packOpts = () => ({ root: join(runs, 'bus'), runsDir: runs, now: () => now });
  beforeEach(async () => {
    runs = await mkdtemp(join(tmpdir(), 'ctxpack-pins-'));
    await mkdir(join(runs, 'queue'));
    await writeFile(join(runs, 'queue/status.json'), JSON.stringify({ last_tick: new Date(now).toISOString(), paused: false, mem_free_pct: 50, lanes: { claude: { running: 1, target: 2, queued: 0, held: false } } }));
    await writeFile(join(runs, 'queue/dispatch-events.log'), '');
    expect(appendBusInbox({ id: 'seed', from: 'core', to: 'claude', priority: 'P2', ttl: 60000, body: { text: 'seed' } }, packOpts()).status).toBe('posted');
  });
  afterEach(async () => { await rm(runs, { recursive: true, force: true }); });

  async function pack(): Promise<{ sections: { name: string; rows: unknown[] }[] }> {
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await cmdFleetContextPack(['build', '--job', 'JOB-1', '--lane', 'leader'], packOpts())).toBe(0);
    return JSON.parse(output.mock.calls.at(-1)![0] as string);
  }

  it('is absent without pins and carries titles and refs when pinned', async () => {
    // The pack reads the pins under the test-isolated HOME.
    expect((await pack()).sections.map((s) => s.name)).not.toContain('pinned-by-mason');
    addPin({ kind: 'file', ref: 'docs/PLAN.md', title: 'Plan of record' }, { home: homedir() });
    const section = (await pack()).sections.find((s) => s.name === 'pinned-by-mason');
    expect(section?.rows).toEqual([{ kind: 'file', title: 'Plan of record', ref: 'docs/PLAN.md' }]);
    await rm(libraryPinsPath(homedir()));
  });
});

describe('library pins API', () => {
  const token = 'x'.repeat(64);
  async function call(method: string, path: string, body = '', headers: Record<string, string> = { 'x-ashlr-token': token, 'content-type': 'application/json' }, allowDispatch = true) {
    const req = Readable.from([body]) as unknown as IncomingMessage;
    req.url = path; req.method = method; req.headers = headers;
    let output = '';
    const res = { statusCode: 0, setHeader: vi.fn(), writeHead(n: number) { this.statusCode = n; }, end(v: string) { output = v; } } as unknown as ServerResponse;
    const handled = await handleLibraryPinsApi({ token, allowDispatch } as VerseApiContext, req, res, path, method);
    return { handled, status: res.statusCode, body: () => JSON.parse(output) };
  }
  afterEach(async () => { await rm(join(homedir(), '.phantom', 'library-pins.json'), { force: true }); });

  it('pins, lists and unpins through the gated routes', async () => {
    expect((await call('GET', '/api/verse/other')).handled).toBe(false);
    expect((await call('GET', '/api/verse/library/pins')).body()).toEqual({ v: 1, pins: [] });
    const added = await call('POST', '/api/verse/library/pins', JSON.stringify({ kind: 'memory', ref: '/work/alpha', title: 'alpha memory' }));
    expect(added.status).toBe(200);
    const { pin } = added.body();
    expect(listPins({ home: homedir() })).toEqual([pin]);
    expect((await call('POST', '/api/verse/library/pins', JSON.stringify({ remove: pin.id }))).body()).toEqual({ v: 1, removed: true, pins: [] });
    const again = (await call('POST', '/api/verse/library/pins', JSON.stringify({ kind: 'note', ref: 'n', title: 'n' }))).body().pin;
    expect((await call('DELETE', `/api/verse/library/pins/${again.id}`, '{}')).body()).toMatchObject({ removed: true, pins: [] });
  });

  it('refuses missing tokens, disabled dispatch, unknown keys and secret refs', async () => {
    const body = JSON.stringify({ kind: 'note', ref: 'n', title: 'n' });
    expect((await call('POST', '/api/verse/library/pins', body, { 'content-type': 'application/json' })).status).toBe(401);
    expect((await call('POST', '/api/verse/library/pins', body, undefined, false)).status).toBe(404);
    expect((await call('POST', '/api/verse/library/pins', JSON.stringify({ kind: 'note', ref: 'n', title: 'n', body: 'x' }))).status).toBe(400);
    const secret = await call('POST', '/api/verse/library/pins', JSON.stringify({ kind: 'note', ref: 'sk-' + 'FAKE0000000000000000', title: 'k' }));
    expect(secret.status).toBe(400);
    expect(secret.body().error).toMatch(/looks like a secret/);
    expect(listPins({ home: homedir() })).toEqual([]);
  });
});
