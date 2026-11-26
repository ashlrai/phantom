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
import { checkModelsAgainstDocs, loadVerifiedRegistry, readDocsRecords, selectVerifiedModel, type DocsModelRecord, type VerifiedModelRegistryEntry } from '../src/core/fleet/model-verify.js';
import { handleFleetControlApi } from '../src/core/verse/fleet-control-api.js';
import { createModelsApi, VERSE_MODELS_CHECK_PATH } from '../src/core/verse/models-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/models-check/${name}`, import.meta.url));
const DOCS = 'https://developers.openai.com/api/docs/models';
const now = () => Date.parse('2026-11-17T12:00:00Z');
const NO_DOCS = 'Provider docs are unknown: no confirmed list yet, so models are checked against the registry only.';
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
      schema: 'models.check.v1', version: 1, summary: NO_DOCS, ok: true, registry: 'ok', router_choices: 'ok', docs: 'unknown', docs_as_of: null, stale_after_days: 14,
      counts: { confirmed: 2, stale: 0, unconfirmed: 0 },
      models: [
        { id: 'gpt-6-luna', provider: 'openai', lanes: ['codex', 'codex-personal'], source_url: DOCS, confirmed_on: '2026-11-17', state: 'confirmed', routable: true, docs: 'unknown', replacement: null, reason: null },
        { id: 'gpt-6-sol', provider: 'openai', lanes: [], source_url: DOCS, confirmed_on: '2026-11-10', state: 'confirmed', routable: true, docs: 'unknown', replacement: null, reason: null },
      ],
      missing: [], diff: null, error: null,
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
    expect(report.models[1]).toEqual({ id: 'gpt-6-nova', provider: 'openai', lanes: [], source_url: null, confirmed_on: null, state: 'unconfirmed', routable: false, docs: 'unknown', replacement: null, reason: 'Not confirmed by official docs. The router will not use it.' });
    for (const row of report.models) expect(row.routable).toBe(row.state !== 'unconfirmed');
  });
  it('lists a lane choice that is not in the registry as unconfirmed, and says when models.json is unreadable', async () => {
    await writeFile(join(runsDir, 'models.json'), JSON.stringify({ 'claude.frontier': 'ghost-1' }));
    const report = await checkModels(opts('registry-confirmed.json'));
    expect(report.models[0]).toEqual({ id: 'ghost-1', provider: null, lanes: ['claude'], source_url: null, confirmed_on: null, state: 'unconfirmed', routable: false, docs: 'unknown', replacement: null, reason: 'Not in the registry. The router will not use it.' });
    expect(report.ok).toBe(false);
    await writeFile(join(runsDir, 'models.json'), 'broken');
    expect(await checkModels(opts('registry-confirmed.json'))).toMatchObject({ ok: true, router_choices: 'unknown', counts: { confirmed: 2 } });
  });
  it('reports a missing registry file as unknown, never as empty or fine', async () => {
    const report = await checkModels(opts('no-such-registry.json'));
    expect(report).toEqual({
      schema: 'models.check.v1', version: 1, ok: false, registry: 'unknown', router_choices: 'unknown', docs: 'unknown', docs_as_of: null, stale_after_days: 14,
      counts: { confirmed: 0, stale: 0, unconfirmed: 0 }, models: [], missing: [], diff: null,
      summary: 'The model registry could not be read, so every model is unknown and none is routable.',
      error: 'The model registry could not be read, so every model is unknown and none is routable.',
    });
    expect(formatModelCheck(report)).toEqual([`Models: unknown. ${report.error}`]);
  });
  it('flags Antigravity retirement notices without treating them as Gemini API coverage', async () => {
    await writeFile(join(runsDir, 'models.json'), JSON.stringify({
      'agy.fast': 'gemini-3.8-flash-medium', 'agy.work': 'claude-sonnet-4-6-thinking', gemini: 'gemini-4-argon',
    }));
    for (const [date, verdict] of [['2026-11-29', 'deprecated'], ['2026-11-30', 'retired']]) {
      const report = await checkModels({ runsDir, localRegistryPath: null, now: () => Date.parse(date!) });
      const byId = new Map(report.models.map(row => [row.id, row]));
      expect(byId.get('gemini-3.8-flash-medium')).toMatchObject({ docs: verdict, routable: false });
      expect(byId.get('claude-sonnet-4-6-thinking')).toMatchObject({ docs: verdict, routable: false });
      expect(byId.get('gemini-4-argon-high')).toMatchObject({ docs: verdict, routable: verdict !== 'retired' });
      expect(byId.get('gemini-4-argon')).toMatchObject({ docs: 'unknown', routable: true });
    }
  });
});

describe('checkModelsAgainstDocs (registry against provider docs, both passed in)', () => {
  const entry = (id: string, provider = 'acme') => ({ provider, id, lanes: ['two', 'one'], capabilities: ['text'], added_at: '2026-11-01' });
  const doc = (id: string, extra: Partial<DocsModelRecord> = {}): DocsModelRecord => ({ provider: 'acme', id, status: 'current', source_url: 'https://docs.acme.test/models', seen_at: '2026-11-17', ...extra });
  const verdicts = (result: ReturnType<typeof checkModelsAgainstDocs>) => result.models.map(row => `${row.id} ${row.verdict}`);

  it('confirms every entry the docs call current', () => {
    const result = checkModelsAgainstDocs([entry('sol-2'), entry('luna-1')], [doc('luna-1'), doc('sol-2')]);
    expect(result).toEqual({
      summary: 'All 2 models we route to are confirmed by provider docs.',
      counts: { confirmed: 2, deprecated: 0, retired: 0, unconfirmed: 0, unknown: 0 },
      models: [
        { provider: 'acme', id: 'luna-1', lanes: ['one', 'two'], verdict: 'confirmed', replacement: null, source_url: 'https://docs.acme.test/models', seen_at: '2026-11-17' },
        { provider: 'acme', id: 'sol-2', lanes: ['one', 'two'], verdict: 'confirmed', replacement: null, source_url: 'https://docs.acme.test/models', seen_at: '2026-11-17' },
      ],
      missing: [],
    });
    expect(checkModelsAgainstDocs([entry('luna-1')], [doc('luna-1')]).summary).toBe('The 1 model we route to is confirmed by provider docs.');
  });
  it('calls an id the docs do not name unconfirmed, and one from a provider with no docs list unknown', () => {
    const result = checkModelsAgainstDocs([entry('luna-1'), entry('ghost-9'), entry('far-1', 'other')], [doc('luna-1')]);
    expect(verdicts(result)).toEqual(['ghost-9 unconfirmed', 'luna-1 confirmed', 'far-1 unknown']);
    expect(result.models[0]).toMatchObject({ replacement: null, source_url: null, seen_at: null });
    expect(result.summary).toBe("1 model we route to is not in any provider's docs; 1 model could not be checked (no docs list for the provider).");
  });
  it('reports retired and deprecated with the replacement the docs name; the newest record wins', () => {
    const docs = [doc('old-1', { seen_at: '2026-10-01' }), doc('old-1', { status: 'retired', replacement: 'luna-1', seen_at: '2026-11-16' }), doc('luna-1'), doc('mid-1', { status: 'deprecated', replacement: 'luna-1' }), doc('gone-1', { status: 'retired' })];
    const result = checkModelsAgainstDocs([entry('old-1'), entry('luna-1'), entry('mid-1')], docs);
    expect(result.models.map(row => [row.id, row.verdict, row.replacement])).toEqual([['luna-1', 'confirmed', null], ['mid-1', 'deprecated', 'luna-1'], ['old-1', 'retired', 'luna-1']]);
    expect(result.summary).toBe('1 model we route to is retired; 1 model we route to is deprecated.');
    expect(result.missing).toEqual([]);
  });
  it('lists a current docs model the registry lacks as missing', () => {
    const result = checkModelsAgainstDocs([entry('luna-1'), entry('ghost-8'), entry('ghost-9')], [doc('luna-1'), doc('nova-3')]);
    expect(result.missing).toEqual([doc('nova-3')]);
    expect(result.summary).toBe("2 models we route to are not in any provider's docs; 1 new model shipped and is missing.");
    expect(checkModelsAgainstDocs([], [doc('nova-3'), doc('nova-4')]).summary).toBe('2 new models shipped and are missing.');
  });
  it('handles empty input, is stable, and never changes what it was given', () => {
    expect(checkModelsAgainstDocs([], [])).toEqual({ summary: 'No models are registered.', counts: { confirmed: 0, deprecated: 0, retired: 0, unconfirmed: 0, unknown: 0 }, models: [], missing: [] });
    const registry = Object.freeze([Object.freeze(entry('luna-1'))]), docs = Object.freeze([] as DocsModelRecord[]);
    const result = checkModelsAgainstDocs(registry, docs);
    expect(verdicts(result)).toEqual(['luna-1 unknown']);
    expect(result.summary).toBe('1 model could not be checked (no docs list for the provider).');
    expect(JSON.stringify(checkModelsAgainstDocs(registry, docs))).toBe(JSON.stringify(result));
  });
});

describe('the router guard (selectVerifiedModel with a docs list)', () => {
  const verified = (id: string): VerifiedModelRegistryEntry => ({ id, provider: 'acme', status: 'verified', verified_source: DOCS, verified_at: '2026-11-17' });
  const registry = [verified('old-1'), verified('luna-1'), verified('ghost-9'), { ...verified('draft-1'), status: 'unverified' as const }];
  const docs: DocsModelRecord[] = [
    { provider: 'acme', id: 'old-1', status: 'retired', replacement: 'luna-1', source_url: DOCS, seen_at: '2026-11-16' },
    { provider: 'acme', id: 'luna-1', status: 'current', source_url: DOCS, seen_at: '2026-11-17' },
    { provider: 'acme', id: 'draft-1', status: 'current', source_url: DOCS, seen_at: '2026-11-17' },
  ];
  it('skips a model the docs retired or do not name, and still picks a confirmed one', () => {
    expect(selectVerifiedModel(['old-1', 'ghost-9', 'luna-1'], registry, docs)).toEqual({
      model: 'luna-1', reason: 'Skipped old-1: retired in provider docs. Skipped ghost-9: not in provider docs. Using verified model luna-1 on the same lane.',
    });
    expect(selectVerifiedModel(['old-1'], registry, docs).model).toBeNull();
  });
  it('leaves routing as it was for confirmed models, with no docs list, and for providers the docs do not cover', () => {
    expect(selectVerifiedModel(['luna-1', 'old-1'], registry, docs)).toEqual(selectVerifiedModel(['luna-1', 'old-1'], registry));
    for (const none of [undefined, null, []]) expect(selectVerifiedModel(['old-1', 'luna-1'], registry, none)).toEqual({ model: 'old-1', reason: null });
    expect(selectVerifiedModel(['old-1'], registry, [{ ...docs[1]!, provider: 'other', id: 'far-1' }]).model).toBe('old-1');
  });
  it('never lets the docs make an unverified model routable', () => {
    expect(selectVerifiedModel(['draft-1'], registry, docs)).toEqual(selectVerifiedModel(['draft-1'], registry));
    expect(selectVerifiedModel(['draft-1'], registry, docs).model).toBeNull();
  });
});

describe('phm models check with a confirmed list from provider docs', () => {
  const withDocs = (registry: string) => opts(registry, { docsPath: fixture('docs-list.json') });
  it('reads the list, drops rows that are malformed or not from the provider doc site, and says unknown when there is no list', async () => {
    const records = await readDocsRecords(withDocs('registry-confirmed.json'));
    expect(records!.map(record => `${record.id} ${record.status} ${record.replacement}`)).toEqual(['gpt-6-luna current null', 'gpt-6-sol retired gpt-6-luna', 'gpt-6-nova current null']);
    expect(await readDocsRecords(opts('registry-confirmed.json'))).toBeNull();
    expect(await readDocsRecords({ docsPath: join(runsDir, 'none.json') })).toBeNull();
    expect(await readDocsRecords({ docsPath: fixture('registry-confirmed.json') })).toBeNull();
  });
  it('adds the top line, each docs verdict, the replacement and the missing models to the same versioned report', async () => {
    const report = await checkModels(withDocs('registry-confirmed.json'));
    expect(report).toMatchObject({
      schema: 'models.check.v1', version: 1, ok: false, docs: 'ok', docs_as_of: '2026-11-17', counts: { confirmed: 2, stale: 0, unconfirmed: 0 },
      summary: '1 model we route to is retired; 1 new model shipped and is missing.',
      missing: [{ provider: 'openai', id: 'gpt-6-nova', status: 'current', replacement: null, source_url: DOCS, seen_at: '2026-11-17' }],
    });
    expect(report.models.map(row => [row.id, row.docs, row.replacement, row.routable, row.reason])).toEqual([
      ['gpt-6-luna', 'confirmed', null, true, null],
      ['gpt-6-sol', 'retired', 'gpt-6-luna', false, 'Retired in provider docs. The router will not use it. Use gpt-6-luna.'],
    ]);
  });
  it('is ok when the docs confirm everything, and does not count a model the registry already retired', async () => {
    const registryPath = join(runsDir, 'registry.json'), docsPath = join(runsDir, 'docs.json');
    const row = { provider: 'openai', verified_source: DOCS, verified_at: '2026-11-17' }, seen = { provider: 'openai', source_url: DOCS, seen_at: '2026-11-17T08:00:00Z' };
    await writeFile(registryPath, JSON.stringify([{ ...row, id: 'gpt-6-luna', status: 'verified' }, { ...row, id: 'gpt-5-old', status: 'retired' }]));
    await writeFile(docsPath, JSON.stringify({ schema: 'models.docs.v1', version: 1, records: [{ ...seen, id: 'gpt-6-luna', status: 'current' }, { ...seen, id: 'gpt-5-old', status: 'current' }] }));
    expect(await checkModels({ registryPath, docsPath, runsDir, now })).toMatchObject({ ok: true, docs: 'ok', docs_as_of: '2026-11-17T08:00:00Z', summary: 'The 1 model we route to is confirmed by provider docs.', missing: [] });
    await writeFile(docsPath, JSON.stringify({ schema: 'models.docs.v1', version: 1, records: [] }));
    expect(await checkModels({ registryPath, docsPath, runsDir, now })).toMatchObject({ ok: true, docs: 'ok', docs_as_of: null, summary: '1 model could not be checked (no docs list for the provider).', models: [{ docs: 'unknown', routable: true }] });
  });
  it('prints the top line first and the exact command that adds a missing model', async () => {
    expect(await cmdModels(['check'], withDocs('registry-confirmed.json'))).toBe(1);
    expect(log.mock.calls.map(call => call[0])).toEqual([
      '1 model we route to is retired; 1 new model shipped and is missing.',
      'Models: 2 confirmed, 0 stale, 0 unconfirmed',
      `  gpt-6-luna: confirmed; openai; lanes codex, codex-personal; confirmed 2026-11-17; source ${DOCS}; docs confirmed`,
      `  gpt-6-sol: confirmed, not routable; openai; lanes unknown; confirmed 2026-11-10; source ${DOCS}; docs retired, use gpt-6-luna`,
      `  missing: gpt-6-nova (openai), seen 2026-11-17. Add it: phm models verify gpt-6-nova --source ${DOCS} --provider openai`,
    ]);
    expect(await cmdModels(['check', '--json'], withDocs('registry-confirmed.json'))).toBe(1);
    expect(printed()).toEqual(await checkModels(withDocs('registry-confirmed.json')));
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
      NO_DOCS,
      'Models: 1 confirmed, 0 stale, 1 unconfirmed',
      `  gpt-6-luna: confirmed; openai; lanes codex; confirmed 2026-11-17; source ${DOCS}; docs unknown`,
      '  gpt-6-nova: unconfirmed, not routable; openai; lanes unknown; confirmed never; source none; docs unknown',
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
