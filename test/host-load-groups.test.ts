/** `phm host load`: fixture ps texts in, typed groups out. Nothing here runs ps or reads the real home. */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { cmdHost } from '../src/cli/host.js';
import { groupHostLoad, readHostLoadJobRoots, readHostLoadReport, type HostLoadGroupId, type HostLoadReport } from '../src/core/fleet/host-load.js';
import { createFleetMemoryApi, VERSE_FLEET_HOST_LOAD_PATH } from '../src/core/verse/fleet-memory-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const fixture = (name: string): string => readFileSync(join(__dirname, 'fixtures', 'host-load', `${name}.txt`), 'utf8');
const group = (report: HostLoadReport, id: HostLoadGroupId) => report.groups.find(g => g.id === id)!;
const brief = (report: HostLoadReport) => Object.fromEntries(report.groups.map(g => [g.id, [g.loadPoints, g.cpuPercent, g.rssMb, g.processes]]));

describe('groupHostLoad', () => {
  it('fleet-heavy: counts every descendant of a job root, per job', () => {
    const report = groupHostLoad(fixture('fleet-heavy'), [{ jobId: 'RQ-ONE', pid: 400 }, { jobId: 'RQ-TWO', pid: 500 }], { load1: 74.2, cores: 18, now: 0 });
    expect(report).toMatchObject({ schema: 'host.load.v1', version: 1, generatedAt: '1970-01-01T00:00:00.000Z', state: 'known', load1: 74.2, cores: 18, jobRoots: 2, processes: 14, cpuPercent: 973.1 });
    expect(report.summary).toBe('Load 74: 61 from fleet workers, 7 from local models, 2 from desktop apps, 4 other');
    expect(brief(report)).toEqual({
      'fleet-workers': [61, 800.5, 2480, 6], 'local-models': [7, 90, 9000, 1], 'desktop-apps': [2, 30, 800, 2], system: [0, 2.5, 100, 2], other: [4, 50.1, 154, 3],
    });
    expect(group(report, 'fleet-workers').items).toEqual([
      { name: 'RQ-ONE', cpuPercent: 600, rssMb: 1850, processes: 4 }, { name: 'RQ-TWO', cpuPercent: 200.5, rssMb: 630, processes: 2 },
    ]);
    expect(group(report, 'desktop-apps').items).toEqual([{ name: 'Chrome', cpuPercent: 30, rssMb: 800, processes: 2 }]);
    expect(report.groups.reduce((sum, g) => sum + g.loadPoints!, 0)).toBe(74);
  });

  it('model-heavy: a model server and its children are local models', () => {
    const report = groupHostLoad(fixture('model-heavy'), [{ jobId: 'RQ-ONE', pid: 400 }], { load1: 40, cores: 18 });
    expect(report.summary).toBe('Load 40: 36 from local models, 1 from desktop apps, 1 from fleet workers, 2 other');
    expect(brief(report)).toEqual({
      'fleet-workers': [1, 20, 250, 2], 'local-models': [36, 800, 35000, 3], 'desktop-apps': [1, 30, 500, 1], system: [0, 5, 60, 2], other: [2, 45, 100, 1],
    });
    expect(group(report, 'local-models').items.map(item => [item.name, item.cpuPercent])).toEqual([['ollama', 700], ['mlx-server', 100]]);
  });

  it('app-heavy: app helpers follow their app, a job root inside an app is still fleet, other keeps its top five', () => {
    const report = groupHostLoad(fixture('app-heavy'), [{ jobId: 'RQ-ONE', pid: 351 }], { load1: 12, cores: 18 });
    expect(report.summary).toBe('Load 12: 10 from desktop apps, 1 from fleet workers, 1 other');
    expect(brief(report)).toEqual({
      'fleet-workers': [1, 40, 250, 2], 'local-models': [0, 0, 0, 0], 'desktop-apps': [10, 460, 9000, 6], system: [0, 1, 20, 1], other: [1, 64, 360, 7],
    });
    expect(group(report, 'desktop-apps').items.map(item => [item.name, item.cpuPercent, item.processes]))
      .toEqual([['Cursor', 300, 3], ['Docker', 80, 1], ['ChatGPT', 60, 1], ['Codex', 20, 1]]);
    expect(group(report, 'other').items.map(item => item.name)).toEqual(['Notes', 'alpha', 'bravo', 'charlie', 'delta']);
  });

  it('shows unknown as unknown', () => {
    for (const text of [null, '', 'ps: not permitted\n']) {
      expect(groupHostLoad(text, [], { load1: 80, cores: 18 })).toMatchObject({ state: 'unknown', summary: 'Load 80: sources unknown', groups: [], processes: 0 });
    }
    expect(groupHostLoad(null, null).summary).toBe('Load unknown: sources unknown');
    const noRoots = groupHostLoad(fixture('fleet-heavy'), null, { load1: null, cores: null });
    expect(noRoots).toMatchObject({ state: 'partial', jobRoots: null, load1: null });
    expect(noRoots.summary).toBe('Load unknown: 90% CPU from local models, 30% CPU from desktop apps, 2.5% CPU from the system, 850.6% CPU other');
    expect(group(noRoots, 'fleet-workers')).toMatchObject({ processes: 0, loadPoints: null });
    expect(noRoots.gaps[0]).toMatch(/job roots are unknown/);
  });

  it('survives a parent loop and keeps odd names plain', () => {
    const report = groupHostLoad('10 11 5.0 1024 /opt/a<b>/we$ird name\n11 10 5.0 1024 loop\n', [], { load1: 1, cores: 2 });
    expect(group(report, 'other').items.map(item => item.name)).toEqual(['loop', 'weird name']);
  });
});

describe('reading job roots and the CLI', () => {
  it('reads live claims and skips malformed ones; a missing folder is unknown', () => {
    const runs = mkdtempSync(join(tmpdir(), 'host-load-'));
    expect(readHostLoadJobRoots(runs)).toBeNull();
    const dir = join(runs, 'queue', 'run', 'resource-sessions');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'RQ-ONE.json'), JSON.stringify({ schemaVersion: 1, jobId: 'RQ-ONE', rootPid: 400 }));
    writeFileSync(join(dir, 'RQ-BAD.json'), JSON.stringify({ jobId: 'RQ-OTHER', rootPid: 500 }));
    writeFileSync(join(dir, 'RQ-TORN.json'), '{');
    expect(readHostLoadJobRoots(runs)).toEqual([{ jobId: 'RQ-ONE', pid: 400 }]);
  });

  const deps = (ps: string | null, out: string[]) => ({
    ps: async () => ps, jobRoots: () => [{ jobId: 'RQ-ONE', pid: 400 }, { jobId: 'RQ-TWO', pid: 500 }],
    load: () => ({ load1: 74.2, load5: 70, load15: 60, cores: 18, ratio: 4.1 }), now: () => 0, owners: () => ({}), write: (text: string) => { out.push(text); },
  });

  it('prints a schema and version in JSON and the same top line for people', async () => {
    const json: string[] = [], human: string[] = [];
    expect(await cmdHost(['load', '--json'], deps(fixture('fleet-heavy'), json))).toBe(0);
    const report = JSON.parse(json.join('')) as HostLoadReport;
    expect(report).toMatchObject({ schema: 'host.load.v1', version: 1, state: 'known' });
    expect(Object.keys(report)).toEqual(['schema', 'version', 'generatedAt', 'state', 'load1', 'cores', 'jobRoots', 'processes', 'cpuPercent', 'summary', 'groups', 'gaps', 'owners']);
    expect(await cmdHost(['load'], deps(fixture('fleet-heavy'), human))).toBe(0);
    const lines = human.join('').split('\n');
    expect(lines[0]).toBe(report.summary);
    expect(lines).toContainEqual(expect.stringMatching(/^Fleet workers\s+61\s+800\.5\s+2480 MB\s+6$/));
    expect(lines).toContainEqual(expect.stringMatching(/^ {2}RQ-ONE\s+-\s+600\.0\s+1850 MB\s+4$/));
  });

  it('exits 1 when ps cannot be read, 2 on bad usage, 0 on help, and never throws', async () => {
    const out: string[] = [];
    expect(await cmdHost(['load', '--json'], deps(null, out))).toBe(1);
    expect(JSON.parse(out.join(''))).toMatchObject({ state: 'unknown', groups: [] });
    expect(await cmdHost(['load', '--jsno'], deps('', out))).toBe(2);
    expect(await cmdHost(['watch'], deps('', out))).toBe(2);
    expect(await cmdHost(['--help'], deps('', out))).toBe(0);
    const failing = await readHostLoadReport({ ps: () => Promise.reject(new Error('denied')), jobRoots: () => { throw new Error('denied'); }, load: () => ({ load1: null, load5: null, load15: null, cores: null, ratio: null }) });
    expect(failing).toMatchObject({ state: 'unknown', jobRoots: null });
  });

  it('serves the same report to the Host card', async () => {
    let status = 0, text = '';
    const res = { writeHead(code: number) { status = code; return this; }, end(body: string) { text = body; } } as unknown as ServerResponse;
    const api = createFleetMemoryApi({ readHostLoad: () => readHostLoadReport(deps(fixture('model-heavy'), [])) });
    const call = (method: string) => api({ cfg: {} } as VerseApiContext, Object.assign(new PassThrough(), { url: VERSE_FLEET_HOST_LOAD_PATH, method }) as IncomingMessage, res, VERSE_FLEET_HOST_LOAD_PATH, method);
    expect(await call('GET')).toBe(true);
    expect([status, JSON.parse(text).schema, JSON.parse(text).groups.length]).toEqual([200, 'host.load.v1', 5]);
    expect(await call('POST')).toBe(true);
    expect(status).toBe(405);
  });
});
