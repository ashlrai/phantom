import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diffCatalog, renderCatalog, refreshCatalog, catalogPatch, type CatalogData } from '../src/core/routing/catalog-refresh.js';
import { CATALOG_SOURCE_SPECS, collectCatalogSources } from '../src/core/routing/catalog-sources.js';
import { MODEL_CATALOG_PATTERNS, type CatalogPattern } from '../src/core/run/model-catalog-patterns.js';
import { modelModeTier } from '../src/core/run/model-catalog.js';
import { catalogSchedule } from '../src/core/routing/catalog-schedule.js';
import { cmdRouterCatalog } from '../src/cli/router-catalog.js';

const now = '2026-11-17T00:00:00.000Z';
const empty: CatalogData = { tiers: {}, unassigned: [], unseen: {} };
const dirs: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });
describe('router catalog refresh', () => {
  it('extracts digit-bearing model ids rather than CLI names or descriptive words', () => {
    const extract = CATALOG_SOURCE_SPECS[0]!.extract;
    expect(extract('claude-code gpt-style grok-cli')).toEqual([]);
    expect(extract('claude-code claude-sonnet-5-5 gpt-style gpt-6.1-sol grok-cli grok-4.7-build-fast meta/llama-3.1-8b-instruct')).toEqual([
      'claude-sonnet-5-5', 'gpt-6.1-sol', 'grok-4.7-build-fast', 'meta/llama-3.1-8b-instruct',
    ]);
  });
  it('classifies new models without automatically promoting unknown or premium models', () => {
    const { data, report } = diffCatalog(empty, [{ id: 'codex', status: 'ok', models: ['gpt-99-mystery', 'gpt-99-terra'] }], MODEL_CATALOG_PATTERNS, now);
    expect(data.tiers).toEqual({ 'gpt-99-terra': 'lite' });
    expect(data.unassigned).toEqual(['gpt-99-mystery']);
    expect(report.additions).toHaveLength(2);
    expect(renderCatalog(data).split('MODEL_CATALOG_UNASSIGNED')[0]).not.toContain('gpt-99-mystery');
    expect(modelModeTier('gpt-99-mystery')).toBeNull();
  });
  it('uses the Antigravity CLI catalog without inventing an unlisted Neon seat model', async () => {
    const run = vi.fn(async () => [
      'gemini-4-hydrogen-medium', 'gemini-4-hydrogen-high', 'gemini-3.8-flash-medium',
      'claude-sonnet-4-6', 'claude-opus-4-6-thinking', 'gpt-oss-120b-medium',
    ].join('\n'));
    const sources = await collectCatalogSources(false, {
      resolve: bin => bin === 'agy' ? bin : null, run, fetch: async () => new Response('', { status: 503 }),
    });
    expect(run).toHaveBeenCalledWith('agy', ['models']);
    const seat = sources.find(source => source.id === 'agy')!;
    expect(seat.models).toEqual([
      'claude-opus-4-6-thinking', 'claude-sonnet-4-6', 'gemini-3.8-flash-medium',
      'gemini-4-hydrogen-high', 'gemini-4-hydrogen-medium', 'gpt-oss-120b-medium',
    ]);
    const current = { ...empty, tiers: { 'gemini-4-neon': 'normal' } } as const;
    const before = diffCatalog(current, sources, MODEL_CATALOG_PATTERNS, now);
    expect(before.data.tiers['gemini-4-neon']).toBe('normal');
    expect(before.data.unseen).toEqual({});
    expect(before.data.tiers).not.toHaveProperty('gemini-4-neon-high');

    const after = diffCatalog(current, [{ ...seat, models: [...seat.models, 'gemini-4-neon-high'] }], MODEL_CATALOG_PATTERNS, now);
    expect(after.data.tiers).toMatchObject({
      'gemini-4-neon-high': 'normal', 'gemini-4-hydrogen-high': 'lite', 'gemini-3.8-flash-medium': 'lite',
    });
  });
  it.each(['ultra', 'fusion', 'other'])('rejects %s rules at load', tier => {
    const rules = [{ pattern: '^new', sources: ['codex'], tier }] as unknown as CatalogPattern[];
    const { data, report } = diffCatalog(empty, [{ id: 'codex', status: 'ok', models: ['new-model'] }], rules, now);
    expect(data.tiers).toEqual({}); expect(data.unassigned).toEqual(['new-model']);
    expect(report.rejectedRules[0]?.reason).toContain('Only lite and normal');
  });
  it('retains missing models and timestamps, reports age, clears reappearances and never changes tiers', () => {
    const current: CatalogData = { tiers: { 'gpt-old': 'ultra', 'gpt-back': 'normal' }, unassigned: [], unseen: { 'gpt-old': '2026-01-01T00:00:00Z', 'gpt-back': now } };
    const { data, report } = diffCatalog(current, ['codex', 'devin'].map(id => ({ id, status: 'ok', models: ['gpt-back'] })), MODEL_CATALOG_PATTERNS, now);
    expect(data.tiers).toEqual(current.tiers); expect(report.reappeared).toEqual(['gpt-back']);
    expect(report.proposedRemovals).toEqual([{ model: 'gpt-old', unseenSince: '2026-01-01T00:00:00Z' }]);
    const first = diffCatalog({ ...current, unseen: {} }, ['codex', 'devin'].map(id => ({ id, status: 'ok', models: [] })), MODEL_CATALOG_PATTERNS, now);
    expect(first.data.unseen['gpt-old']).toBe(now);
  });
  it('does not mark missing models when an owner is unknown or there is no owner', () => {
    const { report, data } = diffCatalog({ ...empty, tiers: { 'gpt-old': 'lite', alias: 'lite' } }, [{ id: 'codex', status: 'unknown', models: [] }], MODEL_CATALOG_PATTERNS, now);
    expect(report.unknown).toHaveLength(2); expect(data.unseen).toEqual({});
    expect(catalogPatch(renderCatalog(empty), renderCatalog(empty))).toBe('');
  });
  it('handles empty and invalid rules', () => {
    expect(diffCatalog(empty, [], [], now).report.additions).toEqual([]);
    expect(diffCatalog(empty, [], [{ pattern: '[', sources: ['codex'] }], now).report.rejectedRules).toHaveLength(1);
  });
  it('uses stubbed discovery and treats errors, empty output and nonloopback as unknown', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ models: [{ name: 'qwen:7b' }] })));
    const sources = await collectCatalogSources(true, { resolve: b => b, run: async () => 'claude-sonnet-99', fetch, seats: async () => ['seat-model'] });
    expect(sources.find(s => s.id === 'ollama')?.models).toEqual(['qwen:7b']);
    expect(sources.find(s => s.id === 'devin')?.status).toBe('unknown');
    const failed = await collectCatalogSources(false, { resolve: () => null, fetch }, 'http://example.com');
    expect(failed.every(s => s.status === 'unknown')).toBe(true); expect(fetch).toHaveBeenCalledTimes(1);
    const errors = await collectCatalogSources(true, { resolve: b => b, run: async () => { throw new Error(); }, fetch: async () => new Response('', { status: 500 }), seats: async () => { throw new Error(); } });
    expect(errors.every(s => s.status === 'unknown')).toBe(true);
  });
  it('allows only unauthenticated HTTP loopback discovery and refuses redirects', async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ models: [{ name: 'qwen:7b' }] })));
    const deps = { resolve: () => null, run: async () => '', fetch };
    for (const base of ['http://localhost:11434', 'http://[::1]:11434']) {
      const sources = await collectCatalogSources(false, deps, base);
      expect(sources.find(s => s.id === 'ollama')?.status).toBe('ok');
    }
    expect(fetch.mock.calls.every(([, init]) => init?.redirect === 'error')).toBe(true);
    fetch.mockClear();
    const refused = await collectCatalogSources(false, deps, Object.assign(new URL('http://localhost:11434'), { username: 'user', password: 'x' }).href);
    expect(refused.find(s => s.id === 'ollama')?.status).toBe('unknown');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('refuses a configured non-loopback Ollama endpoint in default and seat-inclusive discovery', async () => {
    const home = await mkdtemp(join(tmpdir(), 'catalog-home-'));
    dirs.push(home);
    const ashlr = join(home, '.ashlr');
    const remote = 'http://203.0.113.17:11434';
    await mkdir(ashlr, { recursive: true });
    await writeFile(join(ashlr, 'config.json'), JSON.stringify({ version: 1, models: { ollama: remote } }));
    vi.stubEnv('HOME', home);
    vi.stubEnv('ASHLR_HOME', ashlr);
    vi.stubEnv('ASHLR_VERSE_LOCAL_DISPATCH', 'ollama');
    const requests: { url: string; redirect?: RequestRedirect }[] = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: input instanceof Request ? input.url : input.toString(), redirect: init?.redirect });
      return new Response(JSON.stringify({ models: [] }));
    });
    vi.stubGlobal('fetch', fetch);
    const deps = { resolve: () => null, run: async () => '', fetch };
    for (const includeSeats of [false, true]) {
      const sources = await collectCatalogSources(includeSeats, deps, remote);
      expect(sources.find(s => s.id === 'ollama')?.status).toBe('unknown');
      if (includeSeats) expect(sources.find(s => s.id === 'seats')?.status).toBe('unknown');
    }
    expect(requests).toEqual([]);
    await writeFile(join(ashlr, 'config.json'), JSON.stringify({ version: 1, models: { ollama: 'http://localhost:11434' } }));
    await collectCatalogSources(true, deps, 'http://localhost:11434');
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every(({ url, redirect }) =>
      ['127.0.0.1', '[::1]', 'localhost'].includes(new URL(url).hostname) && redirect === 'error',
    )).toBe(true);
  });
  it('defaults CLI to dry-run artifacts and applies only the catalog when requested', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'catalog-test-')); dirs.push(dir);
    const catalog = join(dir, 'catalog.ts'); const before = renderCatalog(empty); await writeFile(catalog, before);
    const refresh: typeof refreshCatalog = opts => refreshCatalog(opts, { current: empty, now, sources: [{ id: 'codex', status: 'ok', models: ['gpt-99-terra'] }] });
    const deps = { out: vi.fn(), err: vi.fn(), refresh };
    const args = ['refresh', '--json', '--out-dir', dir, '--catalog', catalog];
    expect(await cmdRouterCatalog(args, deps)).toBe(0); expect(await readFile(catalog, 'utf8')).toBe(before);
    expect((await readdir(dir)).filter(f => /\.(json|patch)$/.test(f))).toHaveLength(2);
    expect(await cmdRouterCatalog([...args, '--apply'], deps)).toBe(0); expect(await readFile(catalog, 'utf8')).toContain('gpt-99-terra');
    expect(await cmdRouterCatalog(['refresh', '--bad'], deps)).toBe(2);
    expect(await cmdRouterCatalog(['refresh'], { ...deps, refresh: async () => { throw new Error('failure'); } })).toBe(1);
  });
  it('prints and installs weekly user units without applying refresh', async () => {
    const out = vi.fn(); const installUnits = vi.fn(() => 0);
    vi.spyOn(process, 'getuid').mockReturnValue(1000);
    const deps = { out, err: vi.fn(), phmPath: '/opt/phm/bin/ashlr', platform: 'linux' as const, built: () => true, installUnits };
    expect(await cmdRouterCatalog(['schedule'], deps)).toBe(0); expect(installUnits).not.toHaveBeenCalled();
    expect(await cmdRouterCatalog(['schedule', '--install'], deps)).toBe(0); expect(installUnits).toHaveBeenCalledOnce();
    const linux = catalogSchedule({ phmPath: deps.phmPath, platform: 'linux', home: '/home/test', hour: 4 });
    expect(linux[1]!.contents).toContain('OnCalendar=Mon *-*-* 04:43:00'); expect(linux[1]!.contents).toContain('Weekly');
    expect(linux[0]!.contents).not.toContain('--apply');
    expect(catalogSchedule({ phmPath: deps.phmPath, platform: 'darwin', home: '/home/test' })[0]!.contents).toContain('<key>Weekday</key><integer>1</integer>');
    expect(await cmdRouterCatalog(['schedule', '--hour', '24'], deps)).toBe(2);
    expect(await cmdRouterCatalog(['schedule', '--install'], { ...deps, built: () => false })).toBe(1);
    vi.spyOn(process, 'getuid').mockReturnValue(0);
    expect(await cmdRouterCatalog(['schedule', '--install'], deps)).toBe(1);
  });
});
