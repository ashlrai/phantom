import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const graph = { nodes: [], edges: [], crossRepo: [] };
const impact = { target: 'needle', references: [], dependents: [] };
let repo: string;
let out: string;
let err: string;
let enrolled: ReturnType<typeof vi.fn>;
let buildGraph: ReturnType<typeof vi.fn>;
let findImpact: ReturnType<typeof vi.fn>;
let unavailable: boolean;

beforeEach(() => {
  vi.resetModules();
  repo = mkdtempSync(path.join(os.tmpdir(), 'knowledge-cli-'));
  out = '';
  err = '';
  enrolled = vi.fn((value: string) => value === repo);
  buildGraph = vi.fn(() => graph);
  findImpact = vi.fn(() => impact);
  unavailable = false;
  vi.doMock('../src/core/sandbox/policy.js', () => ({ isEnrolled: enrolled }));
  vi.doMock('../src/core/knowledge/graph.js', () => {
    if (unavailable) throw new Error('unavailable');
    return { buildGraph, impact: findImpact };
  });
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    out += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    err += String(chunk);
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock('../src/core/sandbox/policy.js');
  vi.doUnmock('../src/core/knowledge/graph.js');
  rmSync(repo, { recursive: true, force: true });
});

async function run(args: string[]) {
  const { cmdKnowledge } = await import('../src/cli/knowledge.js');
  return cmdKnowledge(args);
}

function expectJson(value: unknown) {
  expect(JSON.parse(out)).toEqual(value);
}

describe('knowledge CLI machine contract', () => {
  it.each([
    [['--unknown', '--json'], 'Unknown knowledge'],
    [['graph', '--unknown', '--json'], 'Unknown flag'],
    [['graph', '-x', '--json'], 'Unknown flag'],
    [['graph', '--repo', '--json'], '--repo requires'],
    [['impact', 'needle', '--repo', '-h', '--json'], '--repo requires'],
    [['impact', '', '--json'], 'target is required'],
    [['impact', '   ', '--json'], 'target is required'],
    [['impact', 'one', 'two', '--json'], 'Unexpected argument'],
    [['graph', '--help', '--unknown', '--json'], 'Unknown flag'],
    [['graph', '--help', '--json'], '--help cannot'],
    [['graph', 'repo', '--repo', 'other', '--json'], 'either --repo'],
    [['impact', 'needle', '--allow-cloud', '--json'], 'Unknown flag'],
    [['build', '--repo', '--json'], '--repo requires'],
  ])('rejects %j before enrollment or scanning', async (args, diagnostic) => {
    expect(await run(args)).toBe(2);
    expectJson({ error: true, exitCode: 2 });
    expect(err).toContain(diagnostic);
    expect(enrolled).not.toHaveBeenCalled();
    expect(buildGraph).not.toHaveBeenCalled();
    expect(findImpact).not.toHaveBeenCalled();
  });

  it('rejects an unenrolled repository before scanning', async () => {
    expect(await run(['graph', '--repo', path.join(repo, 'other'), '--json'])).toBe(1);
    expectJson({ error: true, exitCode: 1 });
    expect(err).toContain('not enrolled');
    expect(buildGraph).not.toHaveBeenCalled();
  });

  it('reports an unavailable graph module as one JSON error', async () => {
    unavailable = true;
    expect(await run(['impact', 'needle', '--json'])).toBe(1);
    expectJson({ error: true, exitCode: 1 });
    expect(err).toContain('impact requires');
  });

  it('returns the graph payload without diagnostics', async () => {
    expect(await run(['graph', '--repo', repo, '--json'])).toBe(0);
    expectJson(graph);
    expect(err).toBe('');
    expect(buildGraph).toHaveBeenCalledWith([repo]);
  });

  it('returns the impact payload without diagnostics', async () => {
    expect(await run(['impact', 'needle', '--repo', repo, '--json'])).toBe(0);
    expectJson(impact);
    expect(err).toBe('');
    expect(findImpact).toHaveBeenCalledWith('needle', [repo]);
  });

  it('reports a core failure with exit 1 and a JSON result', async () => {
    buildGraph.mockImplementation(() => { throw new Error('scan failed'); });
    expect(await run(['graph', '--json'])).toBe(1);
    expectJson({ error: true, exitCode: 1 });
    expect(err).toContain('scan failed');
  });
});
