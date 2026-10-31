import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runGraphDelegationPath } from '../examples/agents/graph-delegation-path.js';
import { seedFleetGraph } from '../src/core/fleet/graph-seed.js';
import { loadGraph, type GraphLoadResult, type GraphSnapshot } from '../src/core/graph/loader.js';

const graph: GraphSnapshot = {
  status: 'ready', complete: true,
  sources: { fleetJson: { state: 'loaded', path: null }, seats: { state: 'loaded', count: 0 } },
  issues: [],
  nodes: ['fake:start', 'fake:blocked', 'fake:alternate', 'fake:join', 'fake:end'].map(id => ({ id })),
  edges: [
    { id: 'fake:sb', from: 'fake:start', to: 'fake:blocked', kind: 'can-delegate' },
    { id: 'fake:sa', from: 'fake:start', to: 'fake:alternate', kind: 'can-delegate' },
    { id: 'fake:bj', from: 'fake:blocked', to: 'fake:join', kind: 'can-delegate' },
    { id: 'fake:aj', from: 'fake:alternate', to: 'fake:join', kind: 'can-delegate' },
    { id: 'fake:je', from: 'fake:join', to: 'fake:end', kind: 'can-delegate' },
    { id: 'fake:shortcut', from: 'fake:start', to: 'fake:end', kind: 'can-message' },
  ],
};
const endpoints = ['--from', 'fake:start', '--to', 'fake:end'];
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

async function query(args: string[], load: () => Promise<GraphLoadResult> = async () => graph) {
  const lines: string[] = [];
  const exit = await runGraphDelegationPath(args, { load, write: line => lines.push(line) });
  expect(lines).toHaveLength(1);
  return { exit, result: JSON.parse(lines[0]!) };
}

describe('delegation path exclusions', () => {
  it('reroutes a diamond using the original ordered delegation edges without mutating inventory', async () => {
    const before = structuredClone(graph);
    expect((await query(endpoints)).result).toMatchObject({ nodeIds: ['fake:start', 'fake:blocked', 'fake:join', 'fake:end'] });
    expect(await query([...endpoints, '--avoid', 'fake:blocked'])).toMatchObject({ exit: 0, result: {
      status: 'ready', nodeIds: ['fake:start', 'fake:alternate', 'fake:join', 'fake:end'],
      edgeIds: ['fake:sa', 'fake:aj', 'fake:je'], avoidedNodeIds: ['fake:blocked'], missingAvoidedNodeIds: [],
      complete: true, sources: graph.sources, issues: [],
    } });
    expect(graph).toEqual(before);
  });

  it('reports no path when a cut vertex is excluded', async () => {
    expect(await query([...endpoints, '--avoid', 'fake:join'])).toMatchObject({ exit: 1, result: {
      status: 'no_path', error: { code: 'GRAPH_NO_PATH' }, avoidedNodeIds: ['fake:join'],
      missingAvoidedNodeIds: [], complete: true,
    } });
  });

  it('deduplicates exclusions in first-input order and reports absent IDs separately', async () => {
    expect(await query([...endpoints, '--avoid', 'fake:missing', '--avoid', 'fake:blocked',
      '--avoid', 'fake:missing', '--avoid', 'fake:blocked', '--avoid', 'fake:other']))
      .toMatchObject({ exit: 0, result: { status: 'ready',
        avoidedNodeIds: ['fake:missing', 'fake:blocked', 'fake:other'],
        missingAvoidedNodeIds: ['fake:missing', 'fake:other'], complete: true,
        nodeIds: ['fake:start', 'fake:alternate', 'fake:join', 'fake:end'],
      } });
  });

  it.each(['fake:start', 'fake:end'])('rejects avoiding endpoint %s before reading the graph', async endpoint => {
    const load = vi.fn(async () => graph);
    expect(await query([...endpoints, '--avoid', endpoint], load)).toMatchObject({ exit: 2, result: {
      status: 'error', error: { code: 'GRAPH_USAGE', message: 'Cannot avoid a path endpoint.' },
    } });
    expect(load).not.toHaveBeenCalled();
  });

  it.each([['--avoid'], ['--avoid', '--from'], ['--avoid', '  ']])('rejects a missing exclusion value: %j', async (...invalid) => {
    const load = vi.fn(async () => graph);
    expect(await query([...endpoints, ...invalid], load)).toMatchObject({ exit: 2, result: { error: { code: 'GRAPH_USAGE' } } });
    expect(load).not.toHaveBeenCalled();
  });

  it('keeps unavailable inventory distinct and does not claim which exclusions are missing', async () => {
    const result = await query([...endpoints, '--avoid', 'fake:blocked'], async () => ({ status: 'unavailable' }));
    expect(result).toMatchObject({ exit: 1, result: { status: 'unavailable', avoidedNodeIds: ['fake:blocked'],
      error: { code: 'GRAPH_UNAVAILABLE' } } });
    expect(result.result).not.toHaveProperty('missingAvoidedNodeIds');
  });

  it('qualifies absent exclusions with actual incomplete inventory provenance', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fake-delegation-'));
    dirs.push(dir);
    const path = join(dir, 'fleet.json');
    const contents = '{ fake malformed inventory';
    writeFileSync(path, contents);
    const read = () => loadGraph(() => seedFleetGraph({ fleetJsonPath: path,
      seats: [{ id: 'fake-one', engine: 'local' }, { id: 'fake-two', engine: 'local' }],
      now: () => new Date('2020-01-01T00:00:00.000Z'),
    }));
    const result = await query(['--from', 'seat:fake-one', '--to', 'seat:fake-two', '--avoid', 'seat:fake-missing'], read);
    expect(result).toMatchObject({ exit: 1, result: { status: 'no_path', complete: false,
      avoidedNodeIds: ['seat:fake-missing'], missingAvoidedNodeIds: ['seat:fake-missing'],
      sources: { fleetJson: { state: 'malformed', path }, seats: { state: 'loaded', count: 2 } },
      error: { code: 'GRAPH_NO_PATH' },
    } });
    expect(result.result.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'malformed' })]));
    expect(readFileSync(path, 'utf8')).toBe(contents);
  });

  it('distinguishes missing endpoints from missing exclusions', async () => {
    expect(await query(['--from', 'fake:absent', '--to', 'fake:end', '--avoid', 'fake:missing']))
      .toMatchObject({ exit: 1, result: { status: 'not_found', missingNodeIds: ['fake:absent'],
        avoidedNodeIds: ['fake:missing'], missingAvoidedNodeIds: ['fake:missing'], complete: true,
        error: { code: 'GRAPH_NODE_NOT_FOUND' },
      } });
  });
});
