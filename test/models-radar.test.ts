/**
 * `phm models radar`: saved provider release notes are compared with the registry, and a
 * registry patch is proposed but never applied. Hermetic: saved fixtures and temp dirs,
 * no network, no real home. Fetch responses are injected.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdModels, formatModelRadar } from '../src/cli/models.js';
import { READ_ONLY_COMMANDS } from '../src/core/commands/catalog.js';
import { MODEL_RADAR_SOURCES } from '../src/core/fleet/model-radar-fetch.js';
import { MODEL_RADAR_PROVIDERS, proposeRegistryPatch, radarProvider, radarSummary, runModelRadar, scanModelReleaseNotes, type ModelRadarDoc } from '../src/core/fleet/model-radar.js';
import { modelRadarSchedule } from '../src/core/fleet/model-radar-schedule.js';
import { loadVerifiedRegistry, selectVerifiedModel, type VerifiedModelRegistryEntry } from '../src/core/fleet/model-verify.js';
import { listProposals } from '../src/core/inbox/store.js';
import * as radarFetch from '../src/core/radar/fetch.js';
import { isPublicRadarUrl } from '../src/core/radar/sources.js';

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/models-radar/${name}`, import.meta.url));
const now = () => Date.parse('2026-11-18T12:00:00Z');
const opts = { registryPath: fixture('registry.json'), now };
const SUMMARY = '5 new, 1 retired, 1 renamed; 2 low confidence, left out of the patch; 4 of 8 providers unknown';
let registry: VerifiedModelRegistryEntry[], docs: ModelRadarDoc[], temp: string, log: ReturnType<typeof vi.spyOn>;
const note = async (provider: string, file: string) => ({ provider, text: await readFile(fixture(`notes/${file}`), 'utf8') });
const ids = (items: Array<{ id: string; confidence: string }>) => items.map(item => `${item.id} ${item.confidence}`);
beforeEach(async () => {
  registry = await loadVerifiedRegistry(opts);
  docs = [await note('Anthropic', 'anthropic.md'), await note('OpenAI', 'openai.md'), await note('Z.ai', 'zai.md'), await note('Google', 'google.txt'), await note('Cognition', 'cognition.md')];
  temp = await mkdtemp(join(tmpdir(), 'models-radar-'));
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(temp, { recursive: true, force: true }); });

describe('scanModelReleaseNotes', () => {
  it('finds a new model with the line it came from, and never reads a link as an id', () => {
    const scan = scanModelReleaseNotes(docs, registry);
    expect(scan.new_models.find(item => item.id === 'claude-opus-6')).toEqual({
      provider: 'anthropic', id: 'claude-opus-6', confidence: 'high', line_number: 4,
      line: '- We shipped `claude-opus-6`, our most capable model. See [the guide](https://platform.claude.com/docs/en/models/claude-opus-9).',
    });
    expect(scan.new_models.some(item => item.id.includes('opus-9'))).toBe(false);
  });

  it('keeps a marketing line low confidence, and does not report the display name of a model we have', () => {
    const scan = scanModelReleaseNotes(docs, registry);
    expect(scan.new_models.find(item => item.id === 'Claude Opus 7')).toMatchObject({ provider: 'anthropic', confidence: 'low', line_number: 5, line: '- Claude Opus 7 is coming soon and will change how you work.' });
    expect(scan.new_models.some(item => /opus 5\.5/i.test(item.id))).toBe(false);
  });

  it('reports a retired model only from a line that says so, and a renamed one as a pair', () => {
    const scan = scanModelReleaseNotes(docs, registry);
    expect(scan.retired_models).toEqual([{ provider: 'anthropic', id: 'claude-fable-5-1', confidence: 'high', line_number: 7, line: '- `claude-fable-5-1` was retired today. Requests to it now fail.' }]);
    expect(scan.renamed).toEqual([{ provider: 'openai', from: 'gpt-6-luna', id: 'gpt-6-nova', confidence: 'high', line_number: 3, line: 'gpt-6-luna is now gpt-6-nova. The old name keeps working for a week.' }]);
    // claude-opus-5-5 and gpt-6-astra were read and did not change. glm-5.3 (empty doc) and grok-4.7 (no doc) are unknown, not unchanged.
    expect(scan.unchanged_count).toBe(2);
  });

  it('shows an empty doc, a missing doc and a provider missing from the registry as what they are', () => {
    const { providers, new_models } = scanModelReleaseNotes([...docs, { provider: 'mistral', text: 'mistral-9 is out' }, { provider: 'qwen', text: null }], registry);
    const row = (name: string) => providers.find(provider => provider.provider === name);
    expect(providers.map(provider => `${provider.provider} ${provider.doc}`)).toEqual(['anthropic read', 'cursor unknown', 'devin read', 'google read', 'mistral unknown', 'openai read', 'qwen unknown', 'xai unknown', 'zai empty']);
    expect(row('zai')).toEqual({ provider: 'zai', doc: 'empty', in_registry: true, doc_site: 'docs.z.ai', note: 'The saved release notes are empty.' });
    expect(row('xai')!.note).toBe('No saved release notes.');
    expect(row('qwen')!.note).toBe('Could not read the saved release notes.');
    expect(row('mistral')!.note).toBe('No id shapes are known for this provider, so nothing was read.');
    // Google has no registry entry: the id is still found, and the unknown doc site is said, not guessed.
    expect(row('google')).toEqual({ provider: 'google', doc: 'read', in_registry: false, doc_site: 'ai.google.dev', note: 'No model from this provider is in the registry yet, so every id here is new.' });
    expect(ids(new_models.filter(item => item.provider === 'google'))).toEqual(['gemini-4-pro high']);
    expect(ids(new_models.filter(item => item.provider === 'devin'))).toEqual(['Devin 3 low', 'swe-2 high']);
  });

  it('only calls an exact provider id high', () => {
    const text = ['GPT-7 Turbo arrives', 'gpt-7 and gpt-6.3-sol-2026-11-18 ship', 'gpt_7 and gpt-7x.beta too', 'gpt-5 will be retired', 'gpt-6-astra and gpt-6-luna are deprecated', 'gpt-6.astra is listed'].join('\n');
    const scan = scanModelReleaseNotes([{ provider: 'openai', text }], registry);
    expect(ids(scan.new_models)).toEqual(['GPT-7 low', 'gpt-5 low', 'gpt-6.3-sol-2026-11-18 high', 'gpt-7 high', 'gpt-7x.beta low', 'gpt_7 low']);
    expect(ids(scan.retired_models)).toEqual(['gpt-6-astra low', 'gpt-6-luna low']);
    expect(scan.renamed).toMatchObject([{ from: 'gpt-6-astra', id: 'gpt-6.astra', confidence: 'low' }]);
    for (const [provider, id] of [['anthropic', 'claude-fable-5-2'], ['openai', 'gpt-6.1-sol'], ['xai', 'grok-4.7-build-fast'], ['zai', 'glm-5.3-flash'], ['qwen', 'qwen2.5:72b'], ['qwen', 'qwen3.8:27b-ctx64k'], ['qwen', 'qwen3-coder-next'], ['google', 'gemini-4-pro']] as const)
      expect(MODEL_RADAR_PROVIDERS[provider]!.exact!.test(id), id).toBe(true);
    expect(radarProvider(' Z.ai ')).toBe('zai');
  });

  it('handles no input, is stable, and never changes what it was given', () => {
    expect(scanModelReleaseNotes([], [])).toMatchObject({ new_models: [], retired_models: [], renamed: [], unchanged_count: 0 });
    const before = JSON.stringify([docs, registry]);
    expect(scanModelReleaseNotes(docs, registry)).toEqual(scanModelReleaseNotes([...docs].reverse(), [...registry].reverse()));
    expect(JSON.stringify([docs, registry])).toBe(before);
  });
});

describe('proposeRegistryPatch', () => {
  it('proposes only high-confidence changes, and says it was not applied', () => {
    const scan = scanModelReleaseNotes(docs, registry);
    expect(radarSummary(scan)).toBe(SUMMARY);
    expect(proposeRegistryPatch(scan)).toEqual({
      schema: 'models.registry-patch.v1', version: 1, applied: false,
      add: [{ id: 'claude-opus-6', provider: 'anthropic', verified_source: null, verified_at: null, status: 'unverified' }, { id: 'swe-2', provider: 'devin', verified_source: null, verified_at: null, status: 'unverified' }, { id: 'gemini-4-pro', provider: 'google', verified_source: null, verified_at: null, status: 'unverified' }],
      retire: [{ provider: 'anthropic', id: 'claude-fable-5-1' }], rename: [{ provider: 'openai', from: 'gpt-6-luna', to: 'gpt-6-nova' }],
    });
  });

  it('leaves the router refusing every proposed and every low-confidence id, even with the patch in the registry', async () => {
    const scan = scanModelReleaseNotes(docs, registry), patch = proposeRegistryPatch(scan);
    const path = join(temp, 'registry.json');
    await writeFile(path, JSON.stringify([...registry, ...patch.add]));
    const patched = await loadVerifiedRegistry({ registryPath: path, now });
    const low = scan.new_models.filter(item => item.confidence === 'low').map(item => item.id);
    expect(low).toEqual(['Claude Opus 7', 'Devin 3']);
    expect(patched.filter(entry => low.includes(entry.id))).toEqual([]);
    expect(selectVerifiedModel([...low, ...patch.add.map(row => row.id)], patched)).toMatchObject({ model: null });
    expect(selectVerifiedModel([...low, 'claude-opus-6', 'claude-opus-5-5'], patched).model).toBe('claude-opus-5-5');
  });
});

describe('phm models radar', () => {
  it('prints a versioned report with the patch, and changes nothing', async () => {
    const before = await readFile(fixture('registry.json'), 'utf8');
    expect(await cmdModels(['radar', '--json', '--from', fixture('notes')], opts)).toBe(1);
    const report = JSON.parse(String(log.mock.calls.at(-1)![0]));
    expect(report).toEqual({ ...await runModelRadar({ ...opts, from: fixture('notes') }) });
    expect(report).toMatchObject({ schema: 'models.radar.v1', version: 1, summary: SUMMARY, ok: false, registry: 'ok', from: fixture('notes'), unchanged_count: 2, fetch: null, error: null, patch: { schema: 'models.registry-patch.v1', version: 1, applied: false } });
    expect(await readFile(fixture('registry.json'), 'utf8')).toBe(before);
    expect(READ_ONLY_COMMANDS.has('models radar')).toBe(false);
  });

  it('says it in plain words: the summary, each finding, what is unknown, the next step', async () => {
    await cmdModels(['radar', '--from', fixture('notes')], opts);
    const lines = log.mock.calls.map(call => String(call[0]));
    expect(lines[0]).toBe(SUMMARY);
    expect(lines).toContain('  new: claude-opus-6 (anthropic, high confidence), line 4: - We shipped `claude-opus-6`, our most capable model. See [the guide](https://platform.claude.com/docs/en/models/claude-opus-9).');
    expect(lines).toContain('  renamed: gpt-6-luna is now gpt-6-nova (openai, high confidence), line 3: gpt-6-luna is now gpt-6-nova. The old name keeps working for a week.');
    expect(lines).toContain('  unknown: xai: No saved release notes.');
    expect(lines.slice(-2)).toEqual(['Confirm one: phm models verify claude-opus-6 --provider anthropic --source <official doc URL>', 'Nothing was changed. The proposed registry patch is in --json.']);
  });

  it('is ok only when every provider was read and nothing is waiting; unknown is never ok', async () => {
    for (const provider of Object.keys(MODEL_RADAR_PROVIDERS)) await writeFile(join(temp, `${provider}.md`), 'Faster replies this week.\n');
    expect(await runModelRadar({ ...opts, from: temp })).toMatchObject({ ok: true, summary: '0 new, 0 retired, 0 renamed', unchanged_count: 6, error: null });
    expect(await cmdModels(['radar', '--json', '--from', temp], opts)).toBe(0);
    // A fetch that saved no page for a provider means its file is old: reported, and not ok.
    const fetched = [{ provider: 'xai', url: 'https://docs.x.ai/docs/release-notes', saved: false }, { provider: 'zai', url: 'https://docs.z.ai/release-notes/new-released', saved: true }];
    expect(await runModelRadar({ ...opts, from: temp, fetched })).toMatchObject({ ok: false, fetch: fetched });
    expect(formatModelRadar(await runModelRadar({ ...opts, from: temp, fetched }))).toContain('  not fetched: xai: https://docs.x.ai/docs/release-notes');
    expect(await runModelRadar({ ...opts, from: temp, fetched: fetched.slice(1) })).toMatchObject({ ok: true });
    expect(await runModelRadar({ ...opts, from: join(temp, 'none') })).toMatchObject({ ok: false, summary: '0 new, 0 retired, 0 renamed; 8 of 8 providers unknown', error: expect.stringContaining('No saved release notes were found.') });
    expect(await runModelRadar(opts)).toMatchObject({ ok: false, from: null });
    expect(await runModelRadar({ registryPath: fixture('none.json'), from: temp })).toMatchObject({ ok: false, registry: 'unknown', new_models: [], summary: 'The model registry could not be read, so nothing can be compared.' });
  });

  it('rejects bad usage with exit 2', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    for (const args of [['radar', 'extra'], ['radar', '--from'], ['radar', '--yes'], ['radar', '--propose'], ['radar', 'schedule', '--hour', '24'], ['check', '--from', temp], ['list', '--fetch']]) expect(await cmdModels(args, opts), args.join(' ')).toBe(2);
  });

  it('joins saved model-check deprecations and retirement mentions to actual configured choices', async () => {
    const docsPath = join(temp, 'model-docs.json');
    await writeFile(docsPath, JSON.stringify({ schema: 'models.docs.v1', version: 1, records: [{
      provider: 'anthropic', id: 'claude-opus-5-5', status: 'deprecated', source_url: 'https://platform.claude.com/docs/en/models/overview', seen_at: '2026-11-18',
    }] }));
    await writeFile(join(temp, 'models.json'), JSON.stringify({ 'agy.fast': 'gemini-3.8-flash-medium', 'claude.work': 'claude-opus-5-5' }));
    await writeFile(join(temp, 'google.md'), 'gemini-3.8-flash-medium will be removed November 30.');
    const report = await runModelRadar({ ...opts, docsPath, from: temp, runsDir: temp });
    expect(report).toMatchObject({ ok: false, router_choices: 'ok', lane_notices: [
      { lane: 'agy.fast', id: 'gemini-3.8-flash-medium', status: 'mentioned' },
      { lane: 'claude.work', id: 'claude-opus-5-5', status: 'deprecated' },
    ] });
    expect(report.patch.add).toEqual([]);
  });

  it('files one pending inbox note per fresh exact candidate, retaining the originating page and date', async () => {
    vi.stubEnv('HOME', temp);
    await mkdir(join(temp, '.ashlr'), { mode: 0o700 });
    await writeFile(join(temp, 'xai.md'), 'grok-9-new');
    const pages = new Map([
      ['https://antigravity.google/docs/models/', 'Marketing text'],
      ['https://antigravity.google/docs/cli/headless.md', 'Models:\n- `gemini-4-neon-xhigh`\n- `gemini-pro-orchestrator-neon`'],
      ['https://docs.devin.ai/cli/models', '`swe-2-1-lightning` now available'],
      ['https://cursor.com/changelog', 'Composer 2.5 is now available'],
    ]);
    const fetch = vi.spyOn(radarFetch, 'fetchRadarSource').mockImplementation(async ({ url }) => {
      const page = pages.get(url);
      if (page === undefined) throw new Error('fixture: unavailable');
      return page;
    });
    const run = async () => {
      const code = await cmdModels(['radar', '--fetch', '--propose', '--json', '--from', temp], { ...opts, runsDir: temp });
      return { code, report: JSON.parse(String(log.mock.calls.at(-1)![0])) };
    };
    const first = await run();
    expect(first.code, JSON.stringify(first.report.proposals)).toBe(0);
    expect(first.report.proposals).toEqual({ filed: expect.any(Array), existing: [], failed: 0 });
    expect(first.report.proposals.filed).toHaveLength(3);
    const proposals = listProposals();
    expect(proposals).toHaveLength(3);
    const neon = proposals.find(item => item.title.includes('neon-xhigh'));
    expect(neon).toMatchObject({ kind: 'note', status: 'pending', repo: null });
    expect(neon?.diff).toBeUndefined();
    expect(neon?.summary).toContain('https://antigravity.google/docs/cli/headless.md (retrieved 2026-11-18, line 2)');
    expect(neon?.summary).toContain('gemini-4-neon-xhigh');
    expect(neon?.summary).toContain('"applied":false');
    expect(neon?.summary).toContain('"status":"unverified"');
    const second = await run();
    expect(second.report.proposals).toEqual({ filed: [], existing: first.report.proposals.filed, failed: 0 });
    fetch.mockRejectedValue(new Error('fixture: all unavailable'));
    const failed = await run();
    expect(failed.code).toBe(1);
    expect(failed.report.proposals).toEqual({ filed: [], existing: [], failed: 0 });
    expect(listProposals()).toHaveLength(3);
  });

  it('previews a daily launchd or systemd schedule without writing or activating it', async () => {
    for (const platform of ['linux', 'darwin'] as const) {
      const units = modelRadarSchedule({ home: temp, platform, phmPath: '/bin/phm', nodePath: '/bin/node', hour: 5 });
      const output = units.map(unit => unit.contents).join('\n');
      expect(output).toContain('--propose');
      expect(output).toContain('--fetch');
      if (platform === 'linux') expect(output).toContain('05:47:00');
      else {
        expect(output).toContain('<key>Hour</key><integer>5</integer>');
        expect(output).not.toContain('Weekday');
      }
    }
    expect(await cmdModels(['radar', 'schedule', '--hour', '5'], opts)).toBe(0);
    expect(log.mock.calls.map(row => String(row[0])).join('\n')).toContain('--propose');
  });
});

describe('MODEL_RADAR_SOURCES', () => {
  it('lists a public official page for every provider, and marks the ones nobody has fetched yet', async () => {
    expect([...new Set(MODEL_RADAR_SOURCES.map(source => source.provider))].sort()).toEqual(Object.keys(MODEL_RADAR_PROVIDERS).sort());
    const catalogue = JSON.parse(await readFile(new URL('../radar/sources.json', import.meta.url), 'utf8')) as Array<{ url: string }>;
    const shipped = JSON.parse(await readFile(new URL('../docs/model-registry.json', import.meta.url), 'utf8')) as Array<{ verified_source: string | null }>;
    const seen = new Set([...catalogue.map(source => source.url), ...shipped.map(entry => entry.verified_source)]);
    for (const source of MODEL_RADAR_SOURCES) {
      expect(isPublicRadarUrl(source.url), source.url).toBe(true);
      if (source.checked) expect(seen.has(source.url), source.url).toBe(true);
    }
  });
});
