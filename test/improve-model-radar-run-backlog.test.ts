import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MODEL_RADAR_MIN_RUNS,
  foldModelRadarEvidence,
  parseModelRadarJournal,
  parseModelRadarReportDoc,
  modelRadarRunBacklogItems,
  type ModelRadarRunReport,
} from '../src/core/improve/model-radar-run-backlog.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

/** One providers[] row inside a journaled radar report, writer-shaped. */
const providerRow = (provider: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  provider,
  doc: 'read',
  in_registry: true,
  doc_site: 'https://docs.example.com/models',
  note: null,
  ...over,
});

/** One fetch[] row: a MODEL_RADAR_SOURCES page's save outcome. */
const fetchRow = (provider: string, saved = true, url = `https://docs.example.com/${provider}`): Record<string, unknown> => ({
  provider, url, saved,
});

/** The document `phm models radar --fetch --propose --json` prints: JSON.stringify(report, null, 2). */
const radarDoc = (over: Record<string, unknown> = {}): string => JSON.stringify({
  schema: 'models.radar.v1',
  version: 1,
  summary: '0 new, 0 retired, 0 renamed',
  ok: true,
  registry: 'ok',
  from: '/home/test/model-radar',
  new_models: [],
  retired_models: [],
  renamed: [],
  unchanged_count: 12,
  providers: [providerRow('anthropic'), providerRow('openai')],
  patch: { schema: 'models.registry-patch.v1', version: 1, applied: false, add: [], retire: [], rename: [] },
  fetch: [fetchRow('anthropic'), fetchRow('openai')],
  router_choices: 'ok',
  lane_notices: [],
  proposals: { filed: [], existing: [], failed: 0 },
  error: null,
  ...over,
}, null, 2);

/** A registry-outage report, shaped the way runModelRadar's catch writes it: empty scan, all providers 'unknown'. */
const registryOutageDoc = (over: Record<string, unknown> = {}): string => radarDoc({
  ok: false,
  registry: 'unknown',
  summary: 'The model registry could not be read, so nothing can be compared.',
  providers: [providerRow('anthropic', { doc: 'unknown', in_registry: false }), providerRow('openai', { doc: 'unknown', in_registry: false })],
  patch: { schema: 'models.registry-patch.v1', version: 1, applied: false, add: [], retire: [], rename: [] },
  proposals: { filed: [], existing: [], failed: 0 },
  error: 'The model registry could not be read, so nothing can be compared.',
  ...over,
});

/** `n` consecutive all-pages-failed documents for one provider, oldest first. */
const fetchFailDocs = (provider: string, count: number, over: Record<string, unknown> = {}): string[] =>
  Array.from({ length: count }, () => radarDoc({
    fetch: [fetchRow(provider, false), fetchRow(provider, false, `https://docs.example.com/${provider}-2`), fetchRow('openai')],
    ...over,
  }));

/** A validated run for the pure fold, same defaults as radarDoc's rows. */
const runReport = (over: Partial<ModelRadarRunReport> = {}): ModelRadarRunReport => ({
  registryOk: true,
  ok: true,
  error: null,
  providers: [
    { provider: 'anthropic', doc: 'read', inRegistry: true, note: null },
    { provider: 'openai', doc: 'read', inRegistry: true, note: null },
  ],
  fetch: [
    { provider: 'anthropic', saved: true },
    { provider: 'openai', saved: true },
  ],
  proposals: { filed: 0, existing: 0, failed: 0 },
  patchAdd: 0,
  patchRetire: 0,
  patchRename: 0,
  ...over,
});

describe('parseModelRadarReportDoc', () => {
  it('accepts an on-contract report and rejects off-contract shapes', () => {
    const doc = JSON.parse(radarDoc()) as Record<string, unknown>;
    const run = parseModelRadarReportDoc(doc);
    expect(run).not.toBeNull();
    expect(run!.registryOk).toBe(true);
    expect(run!.providers).toHaveLength(2);
    expect(run!.providers[0]).toMatchObject({ provider: 'anthropic', doc: 'read', inRegistry: true });
    expect(run!.fetch).toHaveLength(2);
    expect(run!.proposals).toEqual({ filed: 0, existing: 0, failed: 0 });
    expect(run!.patchAdd).toBe(0);

    const cases: unknown[] = [
      null,
      [],
      'text',
      { ...doc, schema: 'models.radar.v2' },
      { ...doc, version: 2 },
      { ...doc, registry: 'fine' },
      { ...doc, ok: 'yes' },
      { ...doc, router_choices: 'maybe' },
      { ...doc, summary: 42 },
      { ...doc, from: 7 },
      { ...doc, error: 5 },
      { ...doc, new_models: 'none' },
      { ...doc, unchanged_count: -1 },
      { ...doc, providers: 'none' },
      { ...doc, providers: [{}] },
      { ...doc, providers: [{ ...providerRow('x'), doc: 'fine' }] },
      { ...doc, providers: [{ ...providerRow('x'), in_registry: 'yes' }] },
      { ...doc, providers: [{ ...providerRow('x'), note: 9 }] },
      { ...doc, providers: [{ ...providerRow(''), provider: '' }] },
      { ...doc, patch: null },
      { ...doc, patch: { schema: 'models.registry-patch.v1', version: 1, applied: true, add: [], retire: [], rename: [] } },
      { ...doc, patch: { schema: 'models.registry-patch.v1', version: 1, applied: false, add: 'x', retire: [], rename: [] } },
      { ...doc, fetch: 'all' },
      { ...doc, fetch: [{ provider: 'x', saved: 'yes' }] },
      { ...doc, fetch: [{ provider: 'x', url: 3, saved: true }] },
      { ...doc, lane_notices: [{}] },
      { ...doc, lane_notices: [{ lane: 'l', id: 'i', status: 'gone', replacement: null }] },
      { ...doc, proposals: { filed: 'x', existing: [], failed: 0 } },
      { ...doc, proposals: { filed: [], existing: [], failed: -1 } },
      { ...doc, proposals: { filed: [], existing: [], failed: 1.5 } },
    ];
    for (const value of cases) expect(parseModelRadarReportDoc(value)).toBeNull();
    // fetch:null (a run that never fetched) and absent proposals both parse.
    const noFetch = JSON.parse(radarDoc({ fetch: null })) as Record<string, unknown>;
    const parsedNoFetch = parseModelRadarReportDoc(noFetch);
    expect(parsedNoFetch).not.toBeNull();
    expect(parsedNoFetch!.fetch).toBeNull();
    const noProposals = { ...doc } as Record<string, unknown>;
    delete noProposals['proposals'];
    const parsedNoProposals = parseModelRadarReportDoc(noProposals);
    expect(parsedNoProposals).not.toBeNull();
    expect(parsedNoProposals!.proposals).toBeNull();
    // A registry-outage report parses with its own verdicts.
    expect(parseModelRadarReportDoc(JSON.parse(registryOutageDoc()))).not.toBeNull();
  });
});

describe('parseModelRadarJournal', () => {
  it('frames documents on column-0 braces and counts everything else as coverage', () => {
    const docs = fetchFailDocs('anthropic', 2);
    const invalid = JSON.stringify({ schema: 'models.radar.v1' }, null, 2);
    const text = [
      'stderr noise before the first report',
      docs[0],
      'a stderr warning between reports',
      invalid,
      docs[1],
      '',
    ].join('\n');
    const { runs, coverage } = parseModelRadarJournal(text);
    expect(runs).toHaveLength(2);
    expect(coverage.strayLines).toBe(2);
    expect(coverage.invalidDocs).toBe(1);
    expect(coverage.abandonedDocs).toBe(0);
    expect(coverage.openTail).toBe(false);
  });

  it('counts a column-0 brace inside a document as an abandoned mid-write', () => {
    const good = fetchFailDocs('anthropic', 1)[0]!;
    const torn = '{\n  "schema": "models.radar.v1",\n  "providers": [\n    {\n      "provider": "anthropic",';
    const text = `${torn}\n${good}\n`;
    const { runs, coverage } = parseModelRadarJournal(text);
    expect(runs).toHaveLength(1);
    expect(coverage.abandonedDocs).toBe(1);
    expect(coverage.openTail).toBe(false);
  });

  it('flags an unterminated tail document as openTail, never a run', () => {
    const good = fetchFailDocs('anthropic', 1)[0]!;
    const torn = '{\n  "schema": "models.radar.v1",\n  "providers": [';
    const text = `${good}\n${torn}`;
    const { runs, coverage } = parseModelRadarJournal(text);
    expect(runs).toHaveLength(1);
    expect(coverage.openTail).toBe(true);
  });

  it('counts closed documents failing the contract as invalidDocs', () => {
    const bad = JSON.stringify({ schema: 'models.radar.v1', registry: 'fine' }, null, 2);
    const good = fetchFailDocs('anthropic', 1)[0]!;
    const { runs, coverage } = parseModelRadarJournal(`${bad}\n${good}\n`);
    expect(runs).toHaveLength(1);
    expect(coverage.invalidDocs).toBe(1);
  });
});

describe('foldModelRadarEvidence', () => {
  it('measures consecutive registry-outage runs ending at the newest', () => {
    const outage = { registryOk: false, ok: false, error: 'The model registry could not be read, so nothing can be compared.' };
    const runs = [
      runReport(),
      runReport(),
      runReport(outage),
      runReport(outage),
      runReport(outage),
    ];
    const cells = foldModelRadarEvidence(runs);
    const registry = cells.find((c) => c.kind === 'registry');
    expect(registry).toMatchObject({ kind: 'registry', runs: 3 });
    expect(registry && 'error' in registry ? registry.error : null).toContain('model registry');
  });

  it('emits no registry cell once a readable run is newest', () => {
    const outage = { registryOk: false, ok: false };
    const cells = foldModelRadarEvidence([
      runReport(outage), runReport(outage), runReport(outage), runReport(),
    ]);
    expect(cells.find((c) => c.kind === 'registry')).toBeUndefined();
  });

  it('counts registry-outage runs as unmeasured for the doc axis', () => {
    // Three outage runs write doc:'unknown' for every provider by
    // construction — they must not fabricate per-provider blindness.
    const outageProviders = [
      { provider: 'anthropic', doc: 'unknown' as const, inRegistry: false, note: null },
      { provider: 'openai', doc: 'unknown' as const, inRegistry: false, note: null },
    ];
    const outage = { registryOk: false, ok: false, providers: outageProviders };
    const cells = foldModelRadarEvidence([
      runReport(), runReport(), runReport(),
      runReport(outage), runReport(outage), runReport(outage),
    ]);
    expect(cells.find((c) => c.kind === 'registry')).toMatchObject({ runs: 3 });
    expect(cells.filter((c) => c.kind === 'doc')).toEqual([]);
    // And a doc streak cannot span an outage: unknown-by-construction
    // runs break it like any unmeasured run.
    const spanning = foldModelRadarEvidence([
      runReport({ providers: [{ provider: 'anthropic', doc: 'unknown', inRegistry: true, note: null }] }),
      runReport({ providers: [{ provider: 'anthropic', doc: 'unknown', inRegistry: true, note: null }] }),
      runReport(outage),
      runReport({ providers: [{ provider: 'anthropic', doc: 'unknown', inRegistry: true, note: null }] }),
    ]);
    const doc = spanning.find((c) => c.kind === 'doc' && c.key === 'anthropic');
    expect(doc).toMatchObject({ runs: 1 });
  });

  it('measures per-provider fetch streaks only when every page fails', () => {
    const allFail = {
      fetch: [
        { provider: 'anthropic', saved: false },
        { provider: 'anthropic', saved: false },
        { provider: 'openai', saved: true },
      ],
    };
    const cells = foldModelRadarEvidence([runReport(), runReport(), runReport(allFail), runReport(allFail), runReport(allFail)]);
    const fetch = cells.find((c) => c.kind === 'fetch' && c.key === 'anthropic');
    expect(fetch).toMatchObject({ kind: 'fetch', key: 'anthropic', runs: 3, pages: 2 });
    // Partial failure is not the verdict: one dead page beside a live one breaks the streak.
    const partial = foldModelRadarEvidence([
      runReport(allFail), runReport(allFail),
      runReport({ fetch: [{ provider: 'anthropic', saved: false }, { provider: 'anthropic', saved: true }, { provider: 'openai', saved: true }] }),
      runReport(allFail),
    ]);
    expect(partial.find((c) => c.kind === 'fetch' && c.key === 'anthropic')).toMatchObject({ runs: 1 });
    // A fetch-less report is unmeasured and breaks the streak.
    const noFetch = foldModelRadarEvidence([
      runReport(allFail), runReport(allFail), runReport({ fetch: null }), runReport(allFail),
    ]);
    expect(noFetch.find((c) => c.kind === 'fetch' && c.key === 'anthropic')).toMatchObject({ runs: 1 });
    // A provider absent from the fetch results is unmeasured too.
    const absent = foldModelRadarEvidence([
      runReport(allFail), runReport(allFail),
      runReport({ fetch: [{ provider: 'openai', saved: true }] }),
      runReport(allFail),
    ]);
    expect(absent.find((c) => c.kind === 'fetch' && c.key === 'anthropic')).toMatchObject({ runs: 1 });
  });

  it('measures per-provider doc streaks on registry-readable runs only', () => {
    const bad = { providers: [{ provider: 'anthropic', doc: 'unknown' as const, inRegistry: true, note: 'No saved release notes.' }] };
    const cells = foldModelRadarEvidence([
      runReport(), runReport(), runReport(bad), runReport(bad), runReport(bad),
    ]);
    const doc = cells.find((c) => c.kind === 'doc' && c.key === 'anthropic');
    expect(doc).toMatchObject({ kind: 'doc', key: 'anthropic', runs: 3, doc: 'unknown', inRegistry: true, note: 'No saved release notes.' });
    // A 'read' verdict or a missing row breaks the streak.
    const recovered = foldModelRadarEvidence([
      runReport(bad), runReport(bad), runReport(bad), runReport(),
    ]);
    expect(recovered.find((c) => c.kind === 'doc')).toBeUndefined();
    const missing = foldModelRadarEvidence([
      runReport(bad), runReport(bad),
      runReport({ providers: [{ provider: 'openai', doc: 'read', inRegistry: true, note: null }] }),
      runReport(bad),
    ]);
    expect(missing.find((c) => c.kind === 'doc' && c.key === 'anthropic')).toMatchObject({ runs: 1 });
  });

  it('measures proposal-filing streaks and treats absent proposals as unmeasured', () => {
    const failing = { proposals: { filed: 1, existing: 2, failed: 3 } };
    const cells = foldModelRadarEvidence([
      runReport(), runReport(), runReport(failing), runReport(failing), runReport(failing),
    ]);
    const proposals = cells.find((c) => c.kind === 'proposals');
    expect(proposals).toMatchObject({ kind: 'proposals', runs: 3, failed: 3, filed: 1, existing: 2 });
    // failed:0 clears; an absent proposals field is unmeasured and breaks.
    const cleared = foldModelRadarEvidence([
      runReport(failing), runReport(failing), runReport(), runReport(failing),
    ]);
    expect(cleared.find((c) => c.kind === 'proposals')).toMatchObject({ runs: 1 });
    const absent = foldModelRadarEvidence([
      runReport(failing), runReport(failing), runReport({ proposals: null }), runReport(failing),
    ]);
    expect(absent.find((c) => c.kind === 'proposals')).toMatchObject({ runs: 1 });
  });

  it('sorts cells by streak length, then axis order, then key', () => {
    // Oldest→newest: three clean runs, then two registry-outage runs
    // whose fetch/proposals verdicts still count (fetch happens
    // before the registry load; proposals.failed is synthetic here —
    // a real outage files nothing — the fold only checks the shape).
    const outageFetch = [{ provider: 'zeta', saved: false }, { provider: 'zeta', saved: false }, { provider: 'alpha', saved: false }];
    const cleanFetch = [{ provider: 'zeta', saved: false }, { provider: 'zeta', saved: false }, { provider: 'alpha', saved: true }];
    const failing = { proposals: { filed: 0, existing: 0, failed: 2 } };
    const cells = foldModelRadarEvidence([
      runReport({ fetch: cleanFetch, ...failing }),
      runReport({ fetch: cleanFetch, ...failing }),
      runReport({ fetch: cleanFetch, ...failing }),
      runReport({ registryOk: false, ok: false, fetch: outageFetch, ...failing }),
      runReport({ registryOk: false, ok: false, fetch: outageFetch, ...failing }),
    ]);
    // proposals and zeta-fetch streaks are 5; registry and alpha-fetch
    // are 2 (alpha's single page failed on the two outage runs then
    // saved on the clean ones). The 5-tie breaks on axis order —
    // proposals before fetch — and the 2-tie puts registry first.
    expect(cells.map((c) => `${c.kind}:${c.key}`)).toEqual([
      'proposals:proposals',
      'fetch:zeta',
      'registry:registry',
      'fetch:alpha',
    ]);
  });
});

describe('modelRadarRunBacklogItems', () => {
  let home: string;
  let saved: { HOME?: string; ASHLR_HOME?: string };

  beforeEach(async () => {
    saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME };
    delete process.env.ASHLR_HOME;
    home = await mkdtemp(join(tmpdir(), 'modelradar-run-backlog-'));
    process.env.HOME = home;
  });
  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    vi.restoreAllMocks();
    await rm(home, { recursive: true, force: true });
  });

  /** Write docs as the schedule's append sink would: one pretty doc per run. */
  async function journal(name: string, docs: string[]): Promise<string> {
    const dir = join(home, '.ashlr', 'logs');
    await mkdir(dir, { recursive: true });
    const path = join(dir, name);
    await writeFile(path, docs.join('\n') + '\n');
    return path;
  }
  const opts = (journalPath: string, repo = 'ashlrai/phantom') => ({ repo, journalPath });

  it('emits one item per adverse axis at the consecutive-run bar', async () => {
    // Both axes hold on the same three newest runs: anthropic's two
    // pages never save and openai's notes stay unreadable.
    const mixed = [
      radarDoc({ fetch: [fetchRow('anthropic', false), fetchRow('anthropic', false, 'https://x/2'), fetchRow('openai')], providers: [providerRow('anthropic'), providerRow('openai', { doc: 'unknown' })] }),
      radarDoc({ fetch: [fetchRow('anthropic', false), fetchRow('anthropic', false, 'https://x/2'), fetchRow('openai')], providers: [providerRow('anthropic'), providerRow('openai', { doc: 'unknown' })] }),
      radarDoc({ fetch: [fetchRow('anthropic', false), fetchRow('anthropic', false, 'https://x/2'), fetchRow('openai')], providers: [providerRow('anthropic'), providerRow('openai', { doc: 'unknown' })] }),
    ];
    const path = await journal('model-radar.jsonl', mixed);
    const items = await modelRadarRunBacklogItems(opts(path));
    expect(items).toHaveLength(2);
    const ids = items.map((i) => i.id);
    expect(new Set(ids).size).toBe(2);
    for (const item of items) {
      expect(validBacklogItem(item)).not.toBeNull();
      expect(item).toMatchObject({ priority: 3, repo: 'ashlrai/phantom', area: 'router-catalog' });
      expect(item.id).toMatch(/^modelradar-(fetch|doc)-[A-Za-z0-9._-]+-[0-9a-f]{16}$/);
      expect(item.prompt).toContain('consecutive recorded runs');
      expect(item.prompt).toContain('model-radar.jsonl');
      expect(item.prompt).toContain('phm models radar');
      expect(item.prompt).toContain('no-change');
    }
    const fetch = items.find((i) => i.id.startsWith('modelradar-fetch-'))!;
    expect(fetch.title).toContain('anthropic');
    expect(fetch.prompt).toContain('all 2 recorded page(s)');
    const doc = items.find((i) => i.id.startsWith('modelradar-doc-'))!;
    expect(doc.title).toContain('openai');
    expect(doc.prompt).toContain("doc:'unknown'");
  });

  it('emits a registry item for an outage streak and suppresses doc cells', async () => {
    const path = await journal('model-radar.jsonl', [
      registryOutageDoc(), registryOutageDoc(), registryOutageDoc(),
    ]);
    const items = await modelRadarRunBacklogItems(opts(path));
    // Only the registry cell: the outage's doc:'unknown' rows are the
    // empty scan's construction, never per-provider evidence.
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toMatch(/^modelradar-registry-[0-9a-f]{16}$/);
    expect(items[0]!.prompt).toContain('registry');
    expect(items[0]!.prompt).toContain('loadVerifiedRegistry');
    expect(items[0]!.prompt).toContain('unmeasured');
  });

  it('emits a proposals item when filing keeps failing', async () => {
    const failing = { proposals: { filed: ['a'], existing: ['b', 'c'], failed: 2 } };
    const path = await journal('model-radar.jsonl', [
      radarDoc(failing), radarDoc(failing), radarDoc(failing),
    ]);
    const items = await modelRadarRunBacklogItems(opts(path));
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toMatch(/^modelradar-proposals-[0-9a-f]{16}$/);
    expect(items[0]!.prompt).toContain('failed:2');
    expect(items[0]!.prompt).toContain('filed and');
  });

  it('emits nothing below the bar or when the newest verdict recovered', async () => {
    const two = await journal('two.jsonl', fetchFailDocs('anthropic', MODEL_RADAR_MIN_RUNS - 1));
    expect(await modelRadarRunBacklogItems(opts(two))).toEqual([]);

    // Three failing runs then a recovery: the streak is broken.
    const recovered = await journal('recovered.jsonl', [
      ...fetchFailDocs('anthropic', MODEL_RADAR_MIN_RUNS),
      radarDoc(),
    ]);
    expect(await modelRadarRunBacklogItems(opts(recovered))).toEqual([]);

    // Partial fetch failures never reach the bar.
    const partial = await journal('partial.jsonl', Array.from({ length: MODEL_RADAR_MIN_RUNS + 1 }, () =>
      radarDoc({ fetch: [fetchRow('anthropic', false), fetchRow('anthropic', true, 'https://x/2'), fetchRow('openai')] })));
    expect(await modelRadarRunBacklogItems(opts(partial))).toEqual([]);
  });

  it('emits nothing on missing, unreadable-shape or foreign-repo evidence', async () => {
    expect(await modelRadarRunBacklogItems(opts(join(home, 'no-such.jsonl')))).toEqual([]);
    const noise = await journal('noise.jsonl', ['plain stderr line', '{"half":']);
    expect(await modelRadarRunBacklogItems(opts(noise))).toEqual([]);
    const bad = await journal('bad.jsonl', [JSON.stringify({ schema: 'models.radar.v1', registry: 'fine' }, null, 2)]);
    expect(await modelRadarRunBacklogItems(opts(bad))).toEqual([]);
    const path = await journal('model-radar.jsonl', fetchFailDocs('anthropic', MODEL_RADAR_MIN_RUNS));
    expect(await modelRadarRunBacklogItems(opts(path, 'ashlrai/other'))).toEqual([]);
    expect(await modelRadarRunBacklogItems(opts(path, 'AshlrAI/Phantom'))).toHaveLength(1);
    expect(await modelRadarRunBacklogItems({ repo: '', journalPath: path })).toEqual([]);
  });

  it('honors homeDir resolution and the limit', async () => {
    // Both axes hold on the same three runs: anthropic's pages never
    // save and openai's notes stay empty.
    const doc = () => radarDoc({
      fetch: [fetchRow('anthropic', false), fetchRow('anthropic', false, 'https://x/2'), fetchRow('openai')],
      providers: [providerRow('anthropic'), providerRow('openai', { doc: 'empty' })],
    });
    const explicit = await journal('explicit.jsonl', [doc(), doc(), doc()]);
    const viaOpts = await modelRadarRunBacklogItems({ repo: 'ashlrai/phantom', journalPath: explicit });
    expect(viaOpts).toHaveLength(2);
    expect(await modelRadarRunBacklogItems({ repo: 'ashlrai/phantom', journalPath: explicit, limit: 1 })).toHaveLength(1);
    // Default resolution reads <home>/.ashlr/logs/model-radar.jsonl via HOME.
    await journal('model-radar.jsonl', [doc(), doc(), doc()]);
    const viaHome = await modelRadarRunBacklogItems({ repo: 'ashlrai/phantom' });
    expect(viaHome.map((i) => i.id)).toEqual(viaOpts.map((i) => i.id));
    // Explicit homeDir + journalPath name the same evidence.
    const viaHomeDir = await modelRadarRunBacklogItems({ repo: 'ashlrai/phantom', homeDir: home, journalPath: explicit });
    expect(viaHomeDir.map((i) => i.id)).toEqual(viaOpts.map((i) => i.id));
  });

  it('derives stable ids so a refresh re-adds nothing', async () => {
    const path = await journal('model-radar.jsonl', fetchFailDocs('anthropic', MODEL_RADAR_MIN_RUNS + 1));
    const first = await modelRadarRunBacklogItems(opts(path));
    const second = await modelRadarRunBacklogItems(opts(path));
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
    const longer = await journal('model-radar-longer.jsonl', fetchFailDocs('anthropic', MODEL_RADAR_MIN_RUNS + 4));
    const third = await modelRadarRunBacklogItems(opts(longer));
    expect(third.map((i) => i.id)).toEqual(first.map((i) => i.id));
  });

  it('appends model-radar run items through discovery and dedupes on refresh', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const mixed = [
        radarDoc({ fetch: [fetchRow('anthropic', false), fetchRow('anthropic', false, 'https://x/2'), fetchRow('openai')] }),
        radarDoc({ fetch: [fetchRow('anthropic', false), fetchRow('anthropic', false, 'https://x/2'), fetchRow('openai')] }),
        radarDoc({ fetch: [fetchRow('anthropic', false), fetchRow('anthropic', false, 'https://x/2'), fetchRow('openai')] }),
      ];
      await journal('model-radar.jsonl', mixed);
      const greenGh = async (args: string[]) => {
        const p = args[4] ?? '';
        if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
        return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
      };
      const first = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
      const radarItems = first.items.filter((i) => i.id.startsWith('modelradar-'));
      expect(radarItems).toHaveLength(1);
      expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
      expect(appendUserBacklogItems(radarItems)).toBe(1);
      const second = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
      expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('modelradar-')))).toBe(0);
      expect(readUserBacklogItems().filter((i) => i.id.startsWith('modelradar-'))).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
