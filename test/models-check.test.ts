/**
 * `phm models check`: every model the router can pick is confirmed, stale or unconfirmed,
 * and a saved release-notes page is compared with the registry. Hermetic: saved fixtures
 * and temp dirs, no network, no real home.
 */
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdModels, formatModelCheck } from '../src/cli/models.js';
import { READ_ONLY_COMMANDS } from '../src/core/commands/catalog.js';
import { checkModels, diffReleaseNotes, parseReleaseNoteIds } from '../src/core/fleet/model-check.js';
import { loadVerifiedRegistry } from '../src/core/fleet/model-verify.js';
import { handleFleetControlApi } from '../src/core/verse/fleet-control-api.js';
import { createModelsApi, VERSE_MODELS_CHECK_PATH } from '../src/core/verse/models-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/models-check/${name}`, import.meta.url));
const DOCS = 'https://developers.openai.com/api/docs/models';
const now = () => Date.parse('2026-11-17T12:00:00Z');
let runsDir: string, log: ReturnType<typeof vi.spyOn>;
const opts = (registry: string, extra: object = {}) => ({ registryPath: fixture(registry), runsDir, now, ...extra });
const printed = () => JSON.parse(String(log.mock.calls.at(-1)![0]));
beforeEach(async () => {
  runsDir = await mkdtemp(join(tmpdir(), 'models-check-'));
  await writeFile(join(runsDir, 'models.json'), JSON.stringify({ codex: 'gpt-6-luna', 'codex.frontier': 'gpt-6-luna', fast: 'fast', 'effort.codex': 'high' }));
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(async () => { vi.restoreAllMocks(); await rm(runsDir, { recursive: true, force: true }); });

describe('checkModels', () => {
  it('reports an all-confirmed registry with a stable, versioned shape', async () => {
    const report = await checkModels(opts('registry-confirmed.json'));
    expect(report).toEqual({
      schema: 'models.check.v1', version: 1, ok: true, registry: 'ok', router_choices: 'ok', stale_after_days: 14,
      counts: { confirmed: 2, stale: 0, unconfirmed: 0 },
      models: [
        { id: 'gpt-6-luna', provider: 'openai', lanes: ['codex', 'codex-personal'], source_url: DOCS, confirmed_on: '2026-11-17', state: 'confirmed', routable: true, reason: null },
        { id: 'gpt-6-sol', provider: 'openai', lanes: [], source_url: DOCS, confirmed_on: '2026-11-10', state: 'confirmed', routable: true, reason: null },
      ],
      diff: null, error: null,
    });
    expect(JSON.stringify(await checkModels(opts('registry-confirmed.json')))).toBe(JSON.stringify(report));
  });
  it('calls an entry stale after 14 full days; it stays routable', async () => {
    const report = await checkModels(opts('registry-stale.json'));
    expect(report).toMatchObject({ ok: false, counts: { confirmed: 1, stale: 1, unconfirmed: 0 } });
    expect(report.models[1]).toMatchObject({ id: 'gpt-6-sol', state: 'stale', routable: true, reason: 'Confirmed over 14 days ago. Check the docs again.' });
    // 2026-11-01 plus 14 days. A registry with only that row, since a clock before another row's date is rejected.
    const edge = Date.parse('2026-11-15T00:00:00Z'), registryPath = join(runsDir, 'registry.json');
    await writeFile(registryPath, JSON.stringify([{ id: 'gpt-6-sol', provider: 'openai', verified_source: DOCS, verified_at: '2026-11-01', status: 'verified' }]));
    expect((await checkModels({ registryPath, runsDir, now: () => edge })).counts.stale).toBe(0);
    expect((await checkModels({ registryPath, runsDir, now: () => edge + 1 })).counts.stale).toBe(1);
  });
  it('flags an unconfirmed entry as not routable, matching the router', async () => {
    const report = await checkModels(opts('registry-unconfirmed.json'));
    expect(report).toMatchObject({ ok: false, counts: { confirmed: 1, stale: 0, unconfirmed: 1 } });
    expect(report.models[1]).toEqual({ id: 'gpt-6-nova', provider: 'openai', lanes: [], source_url: null, confirmed_on: null, state: 'unconfirmed', routable: false, reason: 'Not confirmed by official docs. The router will not use it.' });
    for (const row of report.models) expect(row.routable).toBe(row.state !== 'unconfirmed');
  });
  it('lists a lane choice that is not in the registry as unconfirmed, and says when models.json is unreadable', async () => {
    await writeFile(join(runsDir, 'models.json'), JSON.stringify({ 'claude.frontier': 'ghost-1' }));
    const report = await checkModels(opts('registry-confirmed.json'));
    expect(report.models[0]).toEqual({ id: 'ghost-1', provider: null, lanes: ['claude'], source_url: null, confirmed_on: null, state: 'unconfirmed', routable: false, reason: 'Not in the registry. The router will not use it.' });
    expect(report.ok).toBe(false);
    await writeFile(join(runsDir, 'models.json'), 'broken');
    expect(await checkModels(opts('registry-confirmed.json'))).toMatchObject({ ok: true, router_choices: 'unknown', counts: { confirmed: 2 } });
  });
  it('reports a missing registry file as unknown, never as empty or fine', async () => {
    const report = await checkModels(opts('no-such-registry.json'));
    expect(report).toEqual({
      schema: 'models.check.v1', version: 1, ok: false, registry: 'unknown', router_choices: 'unknown', stale_after_days: 14,
      counts: { confirmed: 0, stale: 0, unconfirmed: 0 }, models: [], diff: null,
      error: 'The model registry could not be read, so every model is unknown and none is routable.',
    });
    expect(formatModelCheck(report)).toEqual([`Models: unknown. ${report.error}`]);
  });
});

describe('--diff <saved release-notes file>', () => {
  it('finds one new and one retired id in a saved page', async () => {
    const report = await checkModels(opts('registry-confirmed.json', { diffPath: fixture('release-notes.html') }));
    expect(report.diff).toEqual({ file: 'release-notes.html', provider: 'openai', new: ['gpt-6.5-nova'], renamed: [], retired: ['gpt-6-sol'], error: null });
    expect(report.ok).toBe(false);
    expect(report.counts).toEqual({ confirmed: 2, stale: 0, unconfirmed: 0 });
  });
  it('pairs an id that only changed its spelling as renamed, and ignores other providers and retired rows', async () => {
    const registry = await loadVerifiedRegistry({ registryPath: fixture('registry-confirmed.json'), now });
    const extra = [...registry, { ...registry[0]!, id: 'gpt-5-old', status: 'retired' as const }, { ...registry[0]!, id: 'grok-9', provider: 'xai' }];
    expect(diffReleaseNotes('Now gpt-6-luna-20261117 and gpt-6-sol. Compare grok-9-mini.', extra, 'notes.md'))
      .toEqual({ file: 'notes.md', provider: 'openai', new: [], renamed: [{ from: 'gpt-6-luna', to: 'gpt-6-luna-20261117' }], retired: [], error: null });
    expect(parseReleaseNoteIds('see gpt-6.2-sol.md, /introducing-gpt-6-luna. GPT-6, gpt-store and other-7 are not ids', ['gpt'])).toEqual(['gpt-6-luna', 'gpt-6.2-sol']);
  });
  it('says so when the page names no known id, two providers equally, or cannot be read', async () => {
    const registry = await loadVerifiedRegistry({ registryPath: fixture('registry-confirmed.json'), now });
    expect(diffReleaseNotes('nothing here', registry, 'a.txt')).toMatchObject({ provider: null, retired: [], error: 'No model ids from a known provider were found in this file.' });
    expect(diffReleaseNotes('gpt-6-luna grok-9', [...registry, { ...registry[0]!, id: 'grok-9', provider: 'xai' }], 'a.txt').error).toBe('Could not tell which provider this page is from.');
    const report = await checkModels(opts('registry-confirmed.json', { diffPath: join(runsDir, 'missing.html') }));
    expect(report).toMatchObject({ ok: false, registry: 'ok', diff: { file: 'missing.html', error: 'Could not read this file.' } });
  });
});

describe('phm models check', () => {
  it('prints the report as JSON and exits 0 only when nothing needs doing', async () => {
    expect(await cmdModels(['check', '--json'], opts('registry-confirmed.json'))).toBe(0);
    expect(printed()).toEqual(await checkModels(opts('registry-confirmed.json')));
    expect(await cmdModels(['check', '--json'], opts('registry-unconfirmed.json'))).toBe(1);
    expect(await cmdModels(['check', '--json'], opts('no-such-registry.json'))).toBe(1);
    expect(printed()).toMatchObject({ schema: 'models.check.v1', version: 1, registry: 'unknown' });
    expect(await cmdModels(['check', '--json', '--diff', fixture('release-notes.html')], opts('registry-confirmed.json'))).toBe(1);
    expect(printed().diff).toMatchObject({ new: ['gpt-6.5-nova'], retired: ['gpt-6-sol'] });
    expect(READ_ONLY_COMMANDS.has('models check')).toBe(true);
  });
  it('says it in plain words: counts, the list, the next step, the diff', async () => {
    expect(await cmdModels(['check', '--diff', fixture('release-notes.html')], opts('registry-unconfirmed.json'))).toBe(1);
    expect(log.mock.calls.map(call => call[0])).toEqual([
      'Models: 1 confirmed, 0 stale, 1 unconfirmed',
      `  gpt-6-luna: confirmed; openai; lanes codex; confirmed 2026-11-17; source ${DOCS}`,
      '  gpt-6-nova: unconfirmed, not routable; openai; lanes unknown; confirmed never; source none',
      'Confirm one: phm models verify <id> --source <official doc URL>',
      'release-notes.html (openai): 1 new, 0 renamed, 1 retired',
      '  new: gpt-6.5-nova',
      '  retired: gpt-6-nova',
    ]);
  });
  it('rejects bad usage with exit 2', async () => {
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    for (const args of [['check', 'extra'], ['check', '--diff'], ['check', '--text'], ['check', '--source', DOCS], ['list', '--diff', 'x']])
      expect(await cmdModels(args, opts('registry-confirmed.json'))).toBe(2);
  });
});

describe('GET /api/verse/fleet/control/models/check', () => {
  async function call(handler: typeof handleFleetControlApi, method = 'GET') {
    const req = new EventEmitter() as IncomingMessage;
    req.method = method; req.url = VERSE_MODELS_CHECK_PATH; req.headers = {};
    let status = 0, text = '';
    const res = { headersSent: false, writeHead(code: number) { status = code; return this; }, end(body?: string) { text += body ?? ''; }, write() { return true; } } as unknown as ServerResponse;
    const handled = await handler({ cfg: {}, token: 't', allowDispatch: false } as unknown as VerseApiContext, req, res, VERSE_MODELS_CHECK_PATH, method);
    return { handled, status, body: text ? JSON.parse(text) : null };
  }
  it('serves the same report as the CLI, read-only, through the fleet-control family', async () => {
    const api = createModelsApi({ check: () => checkModels(opts('registry-stale.json')) });
    expect(await call(api)).toEqual({ handled: true, status: 200, body: await checkModels(opts('registry-stale.json')) });
    expect((await call(api, 'POST')).status).toBe(405);
    expect(await call(handleFleetControlApi)).toMatchObject({ handled: true, status: 200, body: { schema: 'models.check.v1', version: 1, registry: 'ok' } });
  });
  it('answers 200 with registry "unknown" when the registry cannot be read', async () => {
    expect(await call(createModelsApi({ check: () => checkModels(opts('no-such-registry.json')) }))).toMatchObject({ status: 200, body: { registry: 'unknown', ok: false, models: [] } });
  });
});
