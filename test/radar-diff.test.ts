import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { diffRadarSnapshots } from '../src/core/radar/diff.js';
import { normalizeRadarSnapshot, radarSnapshotsDir, readRadarState, runRadarSource, RADAR_MIN_INTERVAL_MS } from '../src/core/radar/snapshot.js';
import type { RadarSource } from '../src/core/radar/sources.js';
import * as catalogue from '../src/core/radar/sources.js';
import * as storage from '../src/core/radar/snapshot.js';
import { cmdRadar } from '../src/cli/radar.js';

const source: RadarSource = { id: 'fixture-docs', product: 'Fixture', url: 'https://docs.fixture.org/updates', kind: 'page', verified: true };
const time = Date.parse('2026-11-04T12:00:00Z');
const snapshot = (body: string, kind: RadarSource['kind'] = 'page', offset = 0) => normalizeRadarSnapshot({ ...source, kind }, body, new Date(time + offset).toISOString());
const atom = (entries: string) => `<feed xmlns="http://www.w3.org/2005/Atom">${entries}</feed>`;
const entry = (id: string, title: string) => `<entry><id>${id}</id><title>${title}</title></entry>`;
const homes: string[] = [];
async function home(): Promise<string> { const path = await mkdtemp(join(tmpdir(), 'radar-diff-')); homes.push(path); return path; }
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(homes.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

describe('Radar normalization and pure diff', () => {
  it('normalizes page whitespace, headings, scripts, comments, entities and timestamps', () => {
    const a = snapshot('<h1>Version &amp; tools</h1><p>Hello world</p><script>secret fixture text</script>');
    const b = snapshot('<h1> Version &#38; tools </h1><!-- noise --><p>Hello   world</p><style>noise</style>', 'page', 1);
    expect(diffRadarSnapshots(a, b).status).toBe('unchanged');
    expect(a.data.kind === 'page' && a.data.headings).toEqual(['Version & tools']);
    expect(JSON.stringify(a)).not.toContain('secret fixture text');
    expect(diffRadarSnapshots(null, a).status).toBe('baseline');
  });
  it('bounds malformed page scanning and ignores unterminated executable content', () => {
    const body = '<'.repeat(100_000);
    expect(snapshot(body).data.kind).toBe('page');
    expect(snapshot('<h1>Visible</h1><script>' + body).data).toEqual(snapshot('<h1>Visible</h1>').data);
  });
  it('reports page content and heading changes without storing raw page bodies', () => {
    const result = diffRadarSnapshots(snapshot('<h1>Old</h1>text'), snapshot('<h1>New</h1>changed'));
    expect(result).toMatchObject({ status: 'changed', added: ['New'], removed: ['Old'] });
    expect(result.after).not.toHaveProperty('text');
    expect(diffRadarSnapshots(snapshot('<p>before</p>'), snapshot('<p>after</p>')).status).toBe('changed');
  });
  it('sorts Atom identities and reports additions, removals and changed titles', () => {
    const a = snapshot(atom(entry('retired', 'Old') + entry('stable', 'Before')), 'atom');
    const b = snapshot(atom(entry('stable', 'After') + entry('new', 'New')), 'atom');
    expect(diffRadarSnapshots(a, b)).toMatchObject({ status: 'changed', added: ['new'], removed: ['retired'], changed: [{ id: 'stable', before: 'Before', after: 'After' }] });
    expect(diffRadarSnapshots(a, snapshot(atom(entry('stable', 'Before') + entry('retired', 'Old')), 'atom')).status).toBe('unchanged');
    expect(diffRadarSnapshots(a, snapshot(atom(''), 'atom')).removed).toEqual(['retired', 'stable']);
  });
  it('preserves literal text titles and supports namespaced, HTML, CDATA and XHTML titles', () => {
    expect(snapshot(atom(entry('literal', 'Use &lt;file&gt;')), 'atom').data).toEqual({ kind: 'atom', entries: [{ id: 'literal', title: 'Use <file>' }] });
    const body = '<a:feed xmlns:a="http://www.w3.org/2005/Atom"><a:entry><a:id>one</a:id><a:title type="html"><![CDATA[<b>Ship</b> now]]></a:title></a:entry><a:entry><a:id>two</a:id><a:title type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml">Useful <b>tools</b></div></a:title></a:entry></a:feed>';
    expect(snapshot(body, 'atom').data).toEqual({ kind: 'atom', entries: [{ id: 'one', title: 'Ship now' }, { id: 'two', title: 'Useful tools' }] });
  });
  it.each([
    '<feed>', '<feed xmlns="http://www.w3.org/2005/Atom"><entry></feed>',
    atom(entry('same', 'One') + entry('same', 'Two')), atom('<entry><title>Missing identity</title></entry>'),
    atom(entry('one', '&unsupported;')), atom(entry('one', '&#0;')),
    '<!DOCTYPE feed [<!ENTITY data "bad">]>' + atom(''),
    '<feed xmlns="http://www.w3.org/2005/Atom" malformed></feed>',
    '<feed xmlns="https://fixture.org/other"/>', atom(entry('one', 'Title')).slice(0, -3),
  ])('rejects malformed or incomplete Atom before diff %#', body => {
    expect(() => snapshot(body, 'atom')).toThrow();
  });
  it.each(['npm', 'pypi'] as const)('compares %s versions rather than unrelated metadata', kind => {
    const body = (version: string, noise: string) => JSON.stringify(kind === 'npm' ? { 'dist-tags': { latest: version }, noise } : { info: { version }, noise });
    const a = snapshot(body('1.0.0', 'first'), kind);
    expect(diffRadarSnapshots(a, snapshot(body('1.0.0', 'second'), kind)).status).toBe('unchanged');
    expect(diffRadarSnapshots(a, snapshot(body('2.0.0', 'second'), kind)).changed).toEqual([{ id: 'version', before: '1.0.0', after: '2.0.0' }]);
    expect(() => snapshot('{}', kind)).toThrow();
  });
  it('canonicalizes JSON keys but preserves array order and value types', () => {
    const a = snapshot('{"b":2,"a":[1,2]}', 'json');
    expect(diffRadarSnapshots(a, snapshot('{"a":[1,2],"b":2}', 'json')).status).toBe('unchanged');
    expect(diffRadarSnapshots(a, snapshot('{"a":[2,1],"b":2}', 'json')).status).toBe('changed');
    expect(() => snapshot('not json', 'json')).toThrow();
    expect(() => snapshot('1e400', 'json')).toThrow();
  });
  it('rejects different identities, kinds, URLs and invalid synthetic snapshots', () => {
    const a = snapshot('<h1>A</h1>');
    for (const b of [{ ...a, id: 'other' }, { ...a, url: 'https://docs.fixture.org/other' }, snapshot('{"version":"1.0.0"}', 'npm')]) expect(() => diffRadarSnapshots(a, b)).toThrow();
    expect(() => diffRadarSnapshots(a, { ...a, observedAt: 'invalid' })).toThrow();
    const invalid = { ...a, data: { kind: 'atom' as const, entries: [{ id: 'one', title: 'A' }, { id: 'one', title: 'B' }] } };
    expect(() => diffRadarSnapshots(null, invalid)).toThrow();
  });
});

describe('Radar private storage and cooldown', () => {
  it('keeps two successful observations in 0600 files and throttles for exactly six hours', async () => {
    const dir = await home();
    const fetch = vi.fn().mockResolvedValue('<h1>First</h1>');
    expect((await runRadarSource(source, { home: dir, now: () => time, fetch })).status).toBe('updated');
    const path = join(radarSnapshotsDir(dir), `${source.id}.json`);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(radarSnapshotsDir(dir))).mode & 0o777).toBe(0o700);
    expect((await runRadarSource(source, { home: dir, now: () => time + RADAR_MIN_INTERVAL_MS - 1, fetch })).status).toBe('throttled');
    expect(fetch).toHaveBeenCalledTimes(1);
    fetch.mockResolvedValue('<h1>Second</h1>');
    await runRadarSource(source, { home: dir, now: () => time + RADAR_MIN_INTERVAL_MS, fetch });
    const state = await readRadarState(source, dir);
    expect(state?.previous?.data.kind === 'page' && state.previous.data.headings).toEqual(['First']);
    expect(state?.current?.data.kind === 'page' && state.current.data.headings).toEqual(['Second']);
    expect(diffRadarSnapshots(state!.previous, state!.current!).status).toBe('changed');
  });
  it('preserves valid snapshots on errors, records failed attempts and fails closed on clock rollback', async () => {
    const dir = await home();
    await runRadarSource(source, { home: dir, now: () => time, fetch: async () => '<h1>Known</h1>' });
    const fetch = vi.fn().mockRejectedValue(new Error('transport details must stay local'));
    expect(await runRadarSource(source, { home: dir, now: () => time + RADAR_MIN_INTERVAL_MS, fetch })).toEqual({ id: source.id, status: 'warning', reason: 'source unavailable' });
    const state = await readRadarState(source, dir);
    expect(state?.failed).toBe(true);
    expect(state?.current?.data).toEqual(snapshot('<h1>Known</h1>').data);
    expect(await readFile(join(radarSnapshotsDir(dir), `${source.id}.json`), 'utf8')).not.toContain('transport details');
    for (const now of [time - 1, time + RADAR_MIN_INTERVAL_MS + 1]) expect((await runRadarSource(source, { home: dir, now: () => now, fetch })).status).toBe('throttled');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('parses and compares RSS 2.0 items with guid preferred over link', () => {
    const rss = (items: string) => `<rss version="2.0"><channel>${items}</channel></rss>`;
    const a = snapshot(rss('<item><guid>one</guid><link>https://example.org/one</link><title>Before &amp; more</title></item><item><link>https://example.org/old</link><title>Old</title></item>'), 'rss');
    const b = snapshot(rss('<item><guid>one</guid><title>After</title></item><item><link>https://example.org/new</link><title>New</title></item>'), 'rss');
    expect(diffRadarSnapshots(a, b)).toMatchObject({ status: 'changed', added: ['https://example.org/new'], removed: ['https://example.org/old'], changed: [{ id: 'one', before: 'Before & more', after: 'After' }] });
    for (const body of [
      '<!DOCTYPE rss><rss version="2.0"><channel/></rss>',
      rss('<item><guid>a</guid><title>&unknown;</title></item>'),
      rss('<item><guid>a</guid><title>One</title></item><item><guid>a</guid><title>Two</title></item>'),
      '<rss version="1.0"><channel/></rss>', '<rss version="2.0"></rss>',
    ]) expect(() => snapshot(body, 'rss')).toThrow();
  });
  it('serializes concurrent runs and does no I/O for unverified sources', async () => {
    const dir = await home();
    let release!: (body: string) => void;
    const fetch = vi.fn(() => new Promise<string>(resolve => { release = resolve; }));
    const pending = runRadarSource(source, { home: dir, now: () => time, fetch });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect((await runRadarSource(source, { home: dir, now: () => time, fetch })).status).toBe('busy');
    release('<h1>Done</h1>');
    await pending;
    expect((await runRadarSource({ ...source, verified: false }, { home: dir, fetch })).status).toBe('unverified');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('refuses corrupt state, symlinked files/parents and source identity changes', async () => {
    const dir = await home();
    await runRadarSource(source, { home: dir, now: () => time, fetch: async () => '<h1>Known</h1>' });
    await expect(readRadarState({ ...source, url: 'https://docs.fixture.org/other' }, dir)).rejects.toThrow();
    const path = join(radarSnapshotsDir(dir), `${source.id}.json`);
    await writeFile(path, 'invalid JSON');
    const fetch = vi.fn();
    await expect(runRadarSource(source, { home: dir, fetch })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    await rm(path);
    await symlink(join(dir, 'outside.json'), path);
    await expect(readRadarState(source, dir)).rejects.toThrow();
    const other = await home();
    await symlink(join(dir, '.phantom'), join(other, '.phantom'));
    await expect(runRadarSource(source, { home: other, fetch })).rejects.toThrow();
  });
});

describe('Radar CLI offline contract', () => {
  it('lists, runs and compares synthetic observations with machine-readable failure states', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(catalogue, 'loadRadarSources').mockResolvedValue([source]);
    const before = snapshot('<h1>Before</h1>');
    const current = snapshot('<h1>After</h1>');
    const state = { schemaVersion: 1 as const, lastRunAt: new Date(time).toISOString(), current, previous: before, failed: false };
    const run = vi.spyOn(storage, 'runRadarSource').mockResolvedValue({ id: source.id, status: 'updated', state });
    const read = vi.spyOn(storage, 'readRadarState').mockResolvedValue(state);
    expect(await cmdRadar(['list', '--json'])).toBe(0);
    expect(JSON.parse(log.mock.calls.at(-1)![0])).toEqual({ ok: true, sources: [source] });
    expect(run).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(await cmdRadar(['run', '--json'])).toBe(0);
    expect(JSON.parse(log.mock.calls.at(-1)![0]).results[0]).toMatchObject({ status: 'updated', diff: { status: 'changed' } });
    read.mockResolvedValue({ ...state, failed: true });
    expect(await cmdRadar(['diff', '--json'])).toBe(1);
    expect(JSON.parse(log.mock.calls.at(-1)![0]).results[0]).toMatchObject({ status: 'stale', diff: { status: 'changed' } });
    read.mockResolvedValue(null);
    expect(await cmdRadar(['diff', '--json'])).toBe(1);
    expect(JSON.parse(log.mock.calls.at(-1)![0]).results[0]).toEqual({ id: source.id, status: 'missing', diff: null });
    run.mockResolvedValue({ id: source.id, status: 'throttled', retryAt: new Date(time).toISOString() });
    expect(await cmdRadar(['run', '--json'])).toBe(0);
  });
  it('sanitizes transport and catalogue failures and continues collecting other sources', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const load = vi.spyOn(catalogue, 'loadRadarSources').mockResolvedValue([source, { ...source, id: 'fixture-other' }]);
    vi.spyOn(storage, 'runRadarSource').mockRejectedValueOnce(new Error('fixture private detail')).mockResolvedValueOnce({ id: 'fixture-other', status: 'throttled' });
    expect(await cmdRadar(['run', '--json'])).toBe(1);
    expect(JSON.parse(log.mock.calls.at(-1)![0])).toEqual({ ok: false, results: [{ id: source.id, status: 'error' }, { id: 'fixture-other', status: 'throttled' }], warnings: [] });
    load.mockRejectedValue(new Error('fixture private detail'));
    expect(await cmdRadar(['list', '--json'])).toBe(1);
    expect(log.mock.calls.at(-1)![0]).not.toContain('fixture private detail');
  });
  it('provides JSON help and fixed usage diagnostics without echoing bad arguments', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await cmdRadar(['--help', '--json'])).toBe(0);
    expect(JSON.parse(log.mock.calls.at(-1)![0]).usage).toContain('phm radar run');
    expect(await cmdRadar(['run', '--unknown', '--json'])).toBe(2);
    expect(JSON.parse(log.mock.calls.at(-1)![0])).toEqual({ ok: false, error: 'Use phm radar list|run|diff --json' });
  });
});
