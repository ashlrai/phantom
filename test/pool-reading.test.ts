import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cmdPool } from '../src/cli/pool.js';
import { POOL_READING_PATH, setPoolReading, showPoolReadings } from '../src/core/usage/pool-reading.js';
import { handleApi } from '../src/core/web/api.js';
import { callNativeTool, listNativeTools, nativeToolSafety } from '../src/core/mcp-native.js';

vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof fs>();
  return { ...original, rename: vi.fn(original.rename) };
});
const NOW = Date.parse('2026-11-18T12:00:00Z');
const valid = { pool: 'ultra', pct: 25, reset_at: '2026-11-19T12:00:00Z', source: 'Provider usage page' };
let root: string;
const target = () => join(root, 'queue/ultra-reading.json');
beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'pool-reading-'));
  vi.stubEnv('ASHLR_RUNS_DIR', root); vi.stubEnv('ASHLR_HOME', join(root, 'config'));
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await fs.rm(root, { recursive: true, force: true }); });

it('writes exact gate fields, private regular file, own capture time and bounded bytes', async () => {
  expect(await setPoolReading(valid)).toMatchObject({ ageSeconds: 0, stale: false });
  const stat = await fs.lstat(target());
  expect(stat.isFile()).toBe(true); expect(stat.size).toBeLessThan(4096); expect(stat.mode & 0o777).toBe(0o600);
  expect(JSON.parse(await fs.readFile(target(), 'utf8'))).toEqual({ pct: 25, ts: NOW / 1000, reset_at: NOW / 1000 + 86400, src: valid.source });
});

it.each([0, 100])('accepts pct boundary %s and numeric Unix reset', async pct => {
  await expect(setPoolReading({ ...valid, pct, reset_at: NOW / 1000 + 1 })).resolves.toMatchObject({ reading: { pct } });
});
it.each([
  { pct: -1 }, { pct: 101 }, { pct: NaN }, { pct: Infinity }, { pct: '25' }, { pct: null },
  { reset_at: 'yesterday' }, { reset_at: NOW / 1000 }, { reset_at: NOW / 1000 - 1 }, { reset_at: Infinity }, { reset_at: '' },
  { reset_at: '2026-11-19T12:00:00' }, { reset_at: '2027-02-30T12:00:00Z' }, { source: '' }, { source: '   ' }, { source: undefined }, { source: 'Page\ntext' },
  { source: '字'.repeat(2000) }, { pool: '../ultra' }, { pool: '' }, { ts: NOW / 1000 }, { extra: 'text' },
])('rejects invalid reading %j without a file', async patch => {
  await expect(setPoolReading({ ...valid, ...patch })).rejects.toThrow();
  await expect(fs.stat(target())).rejects.toMatchObject({ code: 'ENOENT' });
});

it('atomically replaces an existing inode and removes temporary files on failed rename', async () => {
  await setPoolReading(valid);
  const previous = await fs.open(target(), 'r');
  try {
    await setPoolReading({ ...valid, pct: 50 });
    expect(JSON.parse(await previous.readFile('utf8')).pct).toBe(25);
    expect(JSON.parse(await fs.readFile(target(), 'utf8')).pct).toBe(50);
    vi.mocked(fs.rename).mockRejectedValueOnce(new Error('Disk unavailable'));
    await expect(setPoolReading({ ...valid, pct: 75 })).rejects.toThrow('Disk unavailable');
    expect(JSON.parse(await fs.readFile(target(), 'utf8')).pct).toBe(50);
    expect(await fs.readdir(join(root, 'queue'))).toEqual(['ultra-reading.json']);
  } finally { await previous.close(); }
});

it('shows missing as unknown and crosses the eight-hour boundary without refreshing capture time', async () => {
  expect((await showPoolReadings()).readings).toEqual([]);
  expect((await showPoolReadings('ultra')).readings[0]).toMatchObject({ reading: null, stale: true });
  await setPoolReading(valid);
  vi.mocked(Date.now).mockReturnValue(NOW + 8 * 3600000 - 1);
  expect((await showPoolReadings('ultra')).readings[0]).toMatchObject({ stale: false, ageSeconds: 28799 });
  vi.mocked(Date.now).mockReturnValue(NOW + 8 * 3600000);
  expect(await showPoolReadings()).toMatchObject({ staleAfterSeconds: 28800, readings: [{ stale: true, ageSeconds: 28800, reading: { ts: NOW / 1000 } }] });
});

it('refuses links and nonregular targets and bounds malformed reads', async () => {
  await fs.mkdir(join(root, 'queue'));
  const outside = join(root, 'outside'); await fs.writeFile(outside, 'unchanged');
  await fs.symlink(outside, target());
  await expect(setPoolReading(valid)).rejects.toThrow('regular file');
  expect((await showPoolReadings('ultra')).readings[0]?.reading).toBeNull();
  expect(await fs.readFile(outside, 'utf8')).toBe('unchanged');
  await fs.unlink(target()); await fs.mkdir(target());
  await expect(setPoolReading(valid)).rejects.toThrow('regular file');
  await fs.rmdir(target()); await fs.writeFile(target(), 'x'.repeat(4096));
  expect((await showPoolReadings('ultra')).readings[0]?.reading).toBeNull();
});

it('routes CLI set/show and rejects unknown, duplicate and missing arguments', async () => {
  const out = vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(await cmdPool(['reading', 'set', 'ultra', '--pct', '25', '--reset-at', String(NOW / 1000 + 86400), '--source', valid.source, '--json'])).toBe(0);
  expect(await cmdPool(['reading', 'show', 'ultra', '--json'])).toBe(0);
  expect(JSON.parse(String(out.mock.calls.at(-1)?.[0])).readings[0]).toMatchObject({ ageSeconds: 0, stale: false });
  expect(await cmdPool(['reading', 'show'])).toBe(0);
  expect(out.mock.calls.at(-1)?.[0]).toContain('stale after 8h');
  for (const args of [['set', 'ultra'], ['set', 'ultra', '--ts', 'now'], ['show', 'ultra', 'other'], ['show', '--json', '--json'], ['show', '../ultra']]) {
    expect(await cmdPool(['reading', ...args])).toBe(2);
  }
});

async function api(method: string, body: unknown = valid, dispatch = true, authenticated = true, query = '') {
  const req = Readable.from([JSON.stringify(body)]) as IncomingMessage;
  Object.assign(req, { url: POOL_READING_PATH + query, method, headers: { 'content-type': 'application/json', 'x-ashlr-token': authenticated ? 'test' : 'absent' } });
  let status = 0, result: unknown;
  const res = { setHeader: vi.fn(), writeHead: (code: number) => { status = code; }, end: (value: string) => { result = JSON.parse(value); } } as unknown as ServerResponse;
  expect(await handleApi(req, res, {} as never, { token: 'test', allowDispatch: dispatch })).toBe(true);
  return { status, body: result };
}
it('API shares validation, authenticates mutations and supports filtered reads', async () => {
  expect((await api('POST', valid, false)).status).toBe(404);
  expect((await api('POST', valid, true, false)).status).toBe(401);
  expect((await api('POST', { ...valid, ts: 1 })).status).toBe(400);
  expect((await api('POST')).status).toBe(200);
  expect(await api('GET', null, false, false, '?pool=ultra')).toMatchObject({ status: 200, body: { readings: [{ pool: 'ultra', stale: false }] } });
  expect((await api('GET', null, false, false, '?ts=now')).status).toBe(400);
  expect((await api('DELETE')).status).toBe(405);
});

it('MCP exposes both tools with correct safety and the same measured reading', async () => {
  expect(listNativeTools().map(tool => tool.name)).toEqual(expect.arrayContaining(['phm_pool_reading_set', 'phm_pool_reading_show']));
  expect(nativeToolSafety('phm_pool_reading_set')).toBe('append'); expect(nativeToolSafety('phm_pool_reading_show')).toBe('read');
  expect((await callNativeTool('phm_pool_reading_set', valid)).isError).not.toBe(true);
  expect((await showPoolReadings('ultra')).readings[0]?.reading?.pct).toBe(25);
  expect((await callNativeTool('phm_pool_reading_show', { pool: 'ultra' })).isError).not.toBe(true);
  expect((await callNativeTool('phm_pool_reading_set', { ...valid, ts: 1 })).isError).toBe(true);
});
