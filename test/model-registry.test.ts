/**
 * The model registry rule: the router only launches a model whose name official docs
 * confirm. Covers the listing (`phm models --json`, the Models panel API), the router's
 * refusal, staleness, and `phm models verify <id> --source <url>`. Hermetic: temp files,
 * a stubbed fetch, no real home and no network.
 */
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdModels, formatModelRegistry } from '../src/cli/models.js';
import { READ_ONLY_COMMANDS } from '../src/core/commands/catalog.js';
import { listModelRegistry, loadVerifiedRegistry, markModelVerified, ModelVerifyRefusal, selectVerifiedModel } from '../src/core/fleet/model-verify.js';
import { handleFleetControlApi } from '../src/core/verse/fleet-control-api.js';
import { createModelsApi, VERSE_MODELS_PATH, VERSE_MODELS_VERIFY_PATH } from '../src/core/verse/models-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

vi.mock('../src/core/run/model-manager.js', () => ({ listLocalModels: async () => [], ollamaInstalled: () => false, pullModel: vi.fn(), startOllama: vi.fn() }));
vi.mock('../src/core/providers.js', () => ({ probeApiModelEngine: async (engineId: string) => ({ engineId, keyPresent: false, reachable: false }) }));
vi.mock('../src/core/config.js', () => ({ loadConfig: () => ({}) }));

const DOCS = 'https://developers.openai.com/api/docs/models';
const now = () => Date.parse('2026-11-05T12:00:00Z');
const row = (id: string, extra: object = {}) => ({ id, provider: 'openai', verified_source: DOCS, verified_at: '2026-11-05', status: 'verified', ...extra });
const unknown = { verified_source: null, verified_at: null, status: 'unverified' };
const SEED = [row('z-retired', { status: 'retired' }), row('b-unknown', unknown), row('a-stale', { verified_at: '2026-10-05' }), row('fresh', { lanes: ['codex-personal', 'codex-cmp'] })];

let root: string, registryPath: string, localRegistryPath: string, log: ReturnType<typeof vi.spyOn>;
const opts = () => ({ registryPath, localRegistryPath, now });
const page = (text: string | null) => vi.stubGlobal('fetch', vi.fn(async () => text === null ? Promise.reject(new Error('offline')) : new Response(text)));
const printed = () => JSON.parse(String(log.mock.calls.at(-1)![0]));
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'model-registry-'));
  registryPath = join(root, 'registry.json');
  localRegistryPath = join(root, 'home', 'model-registry.json');
  await writeFile(registryPath, JSON.stringify(SEED));
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await rm(root, { recursive: true, force: true }); });

describe('listing', () => {
  it('gives every entry its fields plus unverified and stale flags, unknown lanes as an empty list', async () => {
    const { schema, entries } = await listModelRegistry(opts());
    expect(schema).toBe('models.registry.v1');
    expect(entries).toEqual([
      { id: 'a-stale', provider: 'openai', lanes: [], verified: true, status: 'verified', source_url: DOCS, verified_on: '2026-10-05', unverified: false, stale: true, reason: 'Verified over 30 days ago. Check the docs again.' },
      { id: 'b-unknown', provider: 'openai', lanes: [], verified: false, status: 'unverified', source_url: null, verified_on: null, unverified: true, stale: false, reason: 'Not confirmed by official docs. The router will not use it.' },
      { id: 'fresh', provider: 'openai', lanes: ['codex-cmp', 'codex-personal'], verified: true, status: 'verified', source_url: DOCS, verified_on: '2026-11-05', unverified: false, stale: false, reason: null },
      { id: 'z-retired', provider: 'openai', lanes: [], verified: false, status: 'retired', source_url: DOCS, verified_on: '2026-11-05', unverified: true, stale: false, reason: 'Retired. The router will not use it.' },
    ]);
  });
  it('is byte-stable whatever order the file is in', async () => {
    const first = JSON.stringify(await listModelRegistry(opts()));
    await writeFile(registryPath, JSON.stringify([...SEED].reverse()));
    expect(JSON.stringify(await listModelRegistry(opts()))).toBe(first);
  });
  it('calls an entry stale only after 30 full days', async () => {
    await writeFile(registryPath, JSON.stringify([row('edge', { verified_at: '2026-10-06' })]));
    const at = Date.parse('2026-11-05T00:00:00Z');
    expect((await listModelRegistry({ ...opts(), now: () => at })).entries[0]!.stale).toBe(false);
    expect((await listModelRegistry({ ...opts(), now: () => at + 1 })).entries[0]!.stale).toBe(true);
  });
  it('rejects malformed lanes in the shipped list', async () => {
    await writeFile(registryPath, JSON.stringify([row('fresh', { lanes: ['ok', 'not ok'] })]));
    await expect(listModelRegistry(opts())).rejects.toThrow();
  });
  it('`phm models --json` carries the registry; the table shows unknown as unknown', async () => {
    const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    expect(await cmdModels(['--json'], opts())).toBe(0);
    const json = JSON.parse(String(out.mock.calls.at(-1)![0]));
    expect(Object.keys(json)).toEqual(['registry', 'local', 'apiEngines']);
    expect(json.registry).toEqual((await listModelRegistry(opts())).entries);
    const text = formatModelRegistry(json.registry).join('\n');
    expect(text).toMatch(/a-stale\s+openai\s+unknown\s+stale \(verified over 30 days ago\)\s+2026-10-05/);
    expect(text).toMatch(/b-unknown\s+openai\s+unknown\s+unverified\s+unknown\s+unknown/);
    expect(text).toContain('2 verified, 2 blocked, 1 stale.');
    expect(formatModelRegistry(null).join('\n')).toContain('unknown');
    expect(formatModelRegistry([]).join('\n')).toContain('empty');
    expect(await cmdModels([], opts())).toBe(0);
    expect(log.mock.calls.flat().join('\n')).toContain('fresh');
  });
});

describe('router', () => {
  it('launches a verified model, keeps a stale one, and refuses the rest with a plain reason', async () => {
    const registry = await loadVerifiedRegistry(opts());
    expect(selectVerifiedModel(['fresh'], registry)).toEqual({ model: 'fresh', reason: null });
    expect(selectVerifiedModel(['a-stale'], registry).model).toBe('a-stale');
    expect(selectVerifiedModel(['b-unknown'], registry)).toEqual({ model: null, reason: 'Skipped b-unknown: unverified. No verified model is available on this lane.' });
    expect(selectVerifiedModel(['z-retired', 'not-listed'], registry)).toEqual({ model: null, reason: 'Skipped z-retired: retired. Skipped not-listed: unverified. No verified model is available on this lane.' });
  });
});

describe('phm models verify <id> --source <url>', () => {
  it('marks a model verified once the official page names it, and the router then uses it', async () => {
    page('<td>b-unknown</td>');
    expect(await cmdModels(['verify', 'b-unknown', '--source', DOCS, '--lane', 'codex-local', '--json'], opts())).toBe(0);
    expect(printed()).toEqual({ ok: true, entry: { id: 'b-unknown', provider: 'openai', lanes: ['codex-local'], verified: true, status: 'verified', source_url: DOCS, verified_on: '2026-11-05', unverified: false, stale: false, reason: null } });
    expect(JSON.parse(await readFile(localRegistryPath, 'utf8'))).toEqual([{ id: 'b-unknown', provider: 'openai', verified_source: DOCS, verified_at: '2026-11-05', status: 'verified', lanes: ['codex-local'] }]);
    expect(await readFile(registryPath, 'utf8')).toBe(JSON.stringify(SEED));
    expect(selectVerifiedModel(['b-unknown'], await loadVerifiedRegistry(opts())).model).toBe('b-unknown');
    expect(await cmdModels(['verify', 'a-stale', '--source', DOCS], opts())).toBe(1);
    expect(console.error).toHaveBeenCalledWith(`${DOCS} does not mention a-stale, so it stays as it was.`);
  });
  it('adds a model that shipped today when its provider is named', async () => {
    page('new: brand-new-1 is out');
    await expect(markModelVerified({ id: 'brand-new-1', source: DOCS }, opts())).rejects.toThrow(/not in the registry.*--provider/);
    expect(await markModelVerified({ id: 'brand-new-1', source: DOCS, provider: 'openai' }, opts())).toMatchObject({ verified: true, lanes: [], verified_on: '2026-11-05' });
    expect((await listModelRegistry(opts())).entries.map(entry => entry.id)).toEqual(['a-stale', 'b-unknown', 'brand-new-1', 'fresh', 'z-retired']);
  });
  it.each([
    ['a page that does not name the exact id', 'b-unknown', DOCS, 'b-unknown-mini only', /does not mention b-unknown/],
    ['a page it cannot read', 'b-unknown', DOCS, null, /Could not read/],
    ['a page off the provider doc site', 'b-unknown', 'https://example.com/models', 'b-unknown', /https page on .*developers\.openai\.com/],
    ['a plain http page', 'b-unknown', DOCS.replace('https', 'http'), 'b-unknown', /https page/],
    ['a retired model', 'z-retired', DOCS, 'z-retired', /retired/],
    ['a malformed id', 'bad id', DOCS, 'bad id', /not a valid model id/],
  ])('refuses %s and writes nothing', async (_name, id, source, body, reason) => {
    page(body);
    const failure = await markModelVerified({ id, source }, opts()).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ModelVerifyRefusal);
    expect((failure as Error).message).toMatch(reason);
    await expect(readFile(localRegistryPath, 'utf8')).rejects.toThrow();
    expect(await cmdModels(['verify', id, '--source', source, '--json'], opts())).toBe(1);
    expect(printed()).toMatchObject({ ok: false, error: expect.stringMatching(reason) });
  });
  it('refuses a provider mismatch, and bad usage exits 2 without fetching', async () => {
    page('fresh');
    await expect(markModelVerified({ id: 'fresh', source: DOCS, provider: 'xai' }, opts())).rejects.toThrow('registered under provider openai');
    for (const args of [['verify', 'fresh'], ['verify', 'fresh', '--source'], ['verify', '--source', DOCS], ['verify', 'fresh', 'more', '--source', DOCS], ['list', '--lane', 'x'], ['verify', 'fresh', '--source', DOCS, '--text']])
      expect(await cmdModels(args, opts())).toBe(2);
    expect(fetch).not.toHaveBeenCalled();
    expect(READ_ONLY_COMMANDS.has('models verify')).toBe(false);
  });
  it('ignores damaged or weaker local records: no revived retired model, no stale downgrade', async () => {
    page('fresh');
    await markModelVerified({ id: 'fresh', source: DOCS }, opts());
    const local = [row('z-retired'), row('fresh', { verified_at: '2026-10-01' }), row('b-unknown', { provider: 'xai', verified_source: 'https://docs.x.ai/developers/models' }), row('off-site', { verified_source: 'https://example.com/x' }), 'junk'];
    await writeFile(localRegistryPath, JSON.stringify(local));
    expect((await listModelRegistry(opts())).entries).toEqual((await listModelRegistry({ ...opts(), localRegistryPath: null })).entries);
    await writeFile(localRegistryPath, 'not json');
    expect((await listModelRegistry(opts())).entries).toHaveLength(4);
    await expect(markModelVerified({ id: 'fresh', source: DOCS }, { ...opts(), localRegistryPath: null })).rejects.toThrow('read-only');
  });
});

describe('Models panel API', () => {
  const TOKEN = 'test-token-models';
  const ctx = (allowDispatch: boolean) => ({ cfg: {}, token: TOKEN, allowDispatch }) as unknown as VerseApiContext;
  const headers = { 'x-ashlr-token': TOKEN, 'content-type': 'application/json' };
  async function call(handler: typeof handleFleetControlApi, path: string, o: { method?: string; write?: boolean; headers?: Record<string, string>; body?: unknown } = {}) {
    const req = new EventEmitter() as IncomingMessage;
    req.method = o.method ?? 'GET'; req.url = path; req.headers = o.headers ?? {};
    process.nextTick(() => { if (o.body !== undefined) req.emit('data', Buffer.from(JSON.stringify(o.body))); req.emit('end'); });
    let status = 0, text = '';
    const res = { headersSent: false, writeHead(code: number) { status = code; return this; }, end(body?: string) { text += body ?? ''; }, write() { return true; } } as unknown as ServerResponse;
    const handled = await handler(ctx(o.write ?? false), req, res, path, req.method);
    return { handled, status, body: text ? JSON.parse(text) : null };
  }
  const api = () => createModelsApi({ list: () => listModelRegistry(opts()), verify: input => markModelVerified(input, opts()) });
  const post = (body: unknown, o: { write?: boolean; headers?: Record<string, string> } = {}) => call(api(), VERSE_MODELS_VERIFY_PATH, { method: 'POST', write: true, headers, body, ...o });

  it('serves the shipped registry through the fleet-control family, read-only', async () => {
    const r = await call(handleFleetControlApi, VERSE_MODELS_PATH);
    expect(r).toMatchObject({ handled: true, status: 200, body: { schema: 'models.registry.v1' } });
    const shipped: Array<{ id: string; status: string }> = JSON.parse(await readFile(new URL('../docs/model-registry.json', import.meta.url), 'utf8'));
    expect(r.body.entries.map((entry: { id: string }) => entry.id)).toEqual(shipped.map(entry => entry.id).sort());
    // Names on master stay as they are: nothing shipped unverified becomes verified here.
    for (const entry of shipped.filter(e => e.status !== 'verified')) expect(r.body.entries.find((e: { id: string }) => e.id === entry.id)).toMatchObject({ verified: false, unverified: true });
    expect((await call(handleFleetControlApi, VERSE_MODELS_PATH, { method: 'DELETE' })).status).toBe(405);
    expect((await call(handleFleetControlApi, VERSE_MODELS_VERIFY_PATH, { method: 'POST', headers, body: {} })).status).toBe(404);
  });
  it('reports an unreadable registry as an error, not an empty list', async () => {
    await writeFile(registryPath, 'broken');
    expect(await call(api(), VERSE_MODELS_PATH)).toMatchObject({ status: 500, body: { error: 'The model registry could not be read.' } });
  });
  it('gates the write, then verifies or refuses in plain words', async () => {
    page('b-unknown');
    expect((await post({ id: 'b-unknown', source: DOCS }, { write: false })).status).toBe(404);
    expect((await post({ id: 'b-unknown', source: DOCS }, { headers: { 'content-type': 'application/json' } })).status).toBe(401);
    expect((await post({ id: 'b-unknown', source: DOCS, provider: 'openai' })).status).toBe(400);
    expect((await post({ id: 'b-unknown' })).status).toBe(400);
    await expect(readFile(localRegistryPath, 'utf8')).rejects.toThrow();
    expect(await post({ id: 'fresh', source: DOCS })).toMatchObject({ status: 422, body: { error: `${DOCS} does not mention fresh, so it stays as it was.` } });
    expect(await post({ id: 'b-unknown', source: DOCS })).toMatchObject({ status: 200, body: { id: 'b-unknown', verified: true, verified_on: '2026-11-05' } });
  });
});
