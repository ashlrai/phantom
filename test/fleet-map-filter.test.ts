import { describe, expect, it, vi } from 'vitest';
import { buildFleetLiveMap, renderFleetLiveMapText, type FleetLiveMap } from '../src/core/fleet/live-map.js';
import { filterLiveMap, jobMapState, mapFilterChoices, mapFilterError, MAP_FILTER_EMPTY } from '../src/core/fleet/map-filter.js';
import { fleetOrgMap } from '../src/core/fleet/org-map.js';
import { fleetOrgTree } from '../src/core/fleet/org-tree.js';
import type { FleetSessionsV1 } from '../src/core/fleet/runs-sessions.js';

const mocks = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('../src/core/verse/fleet-live-map-api.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/core/verse/fleet-live-map-api.js')>(), readFleetLiveMap: mocks.read }));
import { cmdMap } from '../src/cli/map.js';

const NOW = Date.parse('2026-11-17T12:00:00Z'), AT = new Date(NOW).toISOString();
const session = (job: string, lane: string, repo: string, status = 'running') => ({ job, lane, repo, model: 'fixture-model', status,
  elapsedSeconds: 60, startedAt: '2026-11-17T11:59:00Z', live: 'unknown' });

/** Five agents: two running on claude, one done, one failed, one with no lane or repo reported. */
function fleet(): FleetLiveMap {
  const map = fleetOrgMap(null, { now: NOW, minutes: 15, sessions: { generatedAt: AT, sourceState: 'healthy', truncated: false, recent: [], sessions: [
    session('RQ-A', 'claude', 'phantom'), session('RQ-B', 'claude', 'docs'), session('RQ-C', 'codex-local', 'phantom'),
    session('RQ-D', 'zai', 'docs'), session('RQ-E', 'unknown', 'unknown', 'unknown'),
  ] } as unknown as FleetSessionsV1 });
  const live = buildFleetLiveMap({ now: NOW, org: { ...map, tree: fleetOrgTree(map) } });
  const set = (id: string, state: 'done' | 'failed') => { live.nodes.find(node => node.id === `job:${id}`)!.state = state; };
  set('RQ-B', 'done'); set('RQ-D', 'failed');
  return live;
}
const jobs = (map: FleetLiveMap) => map.nodes.filter(node => node.kind === 'job').map(node => node.label);
const lanes = (map: FleetLiveMap) => map.nodes.filter(node => node.kind === 'lane').map(node => node.label);

describe('filterLiveMap', () => {
  it('records lane, repo and state on every job', () => {
    const rows = fleet().nodes.filter(node => node.kind === 'job').map(node => [node.label, node.lane, node.repo]);
    expect(rows).toEqual([['RQ-A', 'claude', 'phantom'], ['RQ-B', 'claude', 'docs'], ['RQ-C', 'codex-local', 'phantom'], ['RQ-D', 'zai', 'docs'], ['RQ-E', null, null]]);
  });
  it('gives the same map back when no filter is chosen', () => {
    const map = fleet();
    expect(filterLiveMap(map, {})).toBe(map);
    expect(filterLiveMap(map, { lane: '  ', state: null })).toBe(map);
  });
  it('filters by lane and keeps only that lane', () => {
    const out = filterLiveMap(fleet(), { lane: 'claude' });
    expect(jobs(out)).toEqual(['RQ-A', 'RQ-B']);
    expect(lanes(out)).toEqual(['claude']);
    expect(out.filter).toEqual({ lane: 'claude', repo: null, state: null, matched: 2, total: 5 });
    expect(out.counts.jobs).toBe(2);
    expect(out.edges.every(edge => out.nodes.some(node => node.id === edge.from) && out.nodes.some(node => node.id === edge.to))).toBe(true);
    expect(out.orgLayout?.positions.some(row => row.id === 'job:RQ-C')).toBe(false);
  });
  it('filters by repo', () => {
    expect(jobs(filterLiveMap(fleet(), { repo: 'docs' }))).toEqual(['RQ-B', 'RQ-D']);
    expect(lanes(filterLiveMap(fleet(), { repo: 'docs' }))).toEqual(['claude', 'zai']);
  });
  it.each([['running', ['RQ-A', 'RQ-C']], ['done', ['RQ-B']], ['failed', ['RQ-D']], ['unknown', ['RQ-E']]] as const)('filters by state %s', (state, expected) => {
    expect(jobs(filterLiveMap(fleet(), { state }))).toEqual(expected);
  });
  it('shows unknown as unknown: --lane unknown finds the agent nobody placed, a named lane never does', () => {
    expect(jobs(filterLiveMap(fleet(), { lane: 'unknown' }))).toEqual(['RQ-E']);
    expect(jobs(filterLiveMap(fleet(), { repo: 'unknown' }))).toEqual(['RQ-E']);
    expect(jobs(filterLiveMap(fleet(), { lane: 'claude' }))).not.toContain('RQ-E');
  });
  it('combines filters: every one must match, and spelling case does not matter', () => {
    expect(jobs(filterLiveMap(fleet(), { lane: 'Claude', repo: 'docs', state: 'done' }))).toEqual(['RQ-B']);
    expect(jobs(filterLiveMap(fleet(), { lane: 'claude', repo: 'phantom', state: 'running' }))).toEqual(['RQ-A']);
    expect(lanes(filterLiveMap(fleet(), { repo: 'phantom', state: 'running' }))).toEqual(['claude', 'codex-local']);
  });
  it('has an empty result with a count of zero, and says why a state has no source', () => {
    const out = filterLiveMap(fleet(), { lane: 'claude', state: 'failed' });
    expect(out.filter).toMatchObject({ matched: 0, total: 5 });
    expect(jobs(out)).toEqual([]);
    expect(renderFleetLiveMapText(out)).toContain(MAP_FILTER_EMPTY);
    const plain = fleet(); plain.nodes.forEach(node => { if (node.state === 'failed') node.state = 'running'; });
    expect(filterLiveMap(plain, { state: 'failed' }).gaps.join(' ')).toContain('No source reports failed jobs');
  });
  it('lists only what the map holds in the pickers', () => {
    expect(mapFilterChoices(fleet())).toEqual({ lanes: ['claude', 'codex-local', 'zai', 'unknown'], repos: ['docs', 'phantom', 'unknown'], states: ['running', 'done', 'failed', 'unknown'] });
  });
  it('maps raw job statuses to the four words', () => {
    expect(['launching', 'queued', 'failed', 'weird'].map(status => jobMapState(status))).toEqual(['running', 'waiting', 'failed', 'unknown']);
    expect(jobMapState('running', 'done')).toBe('done');
  });
  it('rejects a bad state or name', () => {
    expect(mapFilterError({ state: 'asleep' as never })).toMatch(/--state takes one of/);
    expect(mapFilterError({ lane: 'a b' })).toMatch(/--lane takes a name/);
    expect(mapFilterError({ lane: 'claude', repo: 'phantom', state: 'running' })).toBeNull();
  });
});

describe('phm map --lane/--repo/--state', { timeout: 30_000 }, () => {
  const run = async (args: string[]) => {
    mocks.read.mockResolvedValue(fleet());
    const log = vi.spyOn(console, 'log').mockImplementation(() => {}), err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const code = await cmdMap(args);
    const out = String(log.mock.calls.at(-1)?.[0] ?? '');
    const errors = err.mock.calls.length;
    log.mockRestore(); err.mockRestore();
    return { code, out, errors };
  };
  it('prints the filtered fleet.live-map.v1 with its filter and counts', async () => {
    const { code, out } = await run(['--json', '--lane', 'claude', '--state', 'running']);
    const map = JSON.parse(out) as FleetLiveMap;
    expect(code).toBe(0);
    expect(map.schema).toBe('fleet.live-map.v1');
    expect(map.filter).toEqual({ lane: 'claude', repo: null, state: 'running', matched: 1, total: 5 });
    expect(jobs(map)).toEqual(['RQ-A']);
  });
  it('prints the empty words and exits 0 when nothing matches', async () => {
    const { code, out } = await run(['--lane', 'gemini']);
    expect(code).toBe(0);
    expect(out).toContain('No agents match these filters.');
  });
  it('shows a plain count in text', async () => {
    expect((await run(['--repo', 'docs'])).out).toContain('Showing 2 of 5 agents (repo docs).');
  });
  it('exits 2 on a bad state, a missing value or a repeated flag, and does not read the fleet', async () => {
    mocks.read.mockClear();
    for (const args of [['--state', 'asleep'], ['--lane'], ['--lane', 'a', '--lane', 'b'], ['--repo', '--json']]) {
      const { code, errors } = await run(args);
      expect(code).toBe(2);
      expect(errors).toBe(1);
    }
    expect(mocks.read).toHaveBeenCalledTimes(0);
  });
});
