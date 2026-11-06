import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildWikiGraph } from '../src/core/knowledge/wiki/graph.js';
import { scanRepo } from '../src/core/knowledge/wiki/scan.js';
import type { WikiGraphView } from '../src/core/knowledge/wiki/types.js';

const steeringReads = vi.hoisted(() => ({ completed: 0 }));
vi.mock('../src/core/knowledge/wiki/scan.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/knowledge/wiki/scan.js')>();
  return { ...actual, scanRepo: vi.fn(actual.scanRepo) };
});
vi.mock('../src/core/knowledge/wiki/steering.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/knowledge/wiki/steering.js')>();
  return { ...actual, readWikiSteering: async (repo: string) => {
    const steering = await actual.readWikiSteering(repo);
    steeringReads.completed++;
    return steering;
  } };
});

const dirs: string[] = [];
function fixture(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'wiki-graph-isolation-'));
  dirs.push(dir);
  mkdirSync(path.join(dir, 'app'));
  mkdirSync(path.join(dir, 'lib'));
  writeFileSync(path.join(dir, 'app/index.ts'), 'import { value } from "../lib/index.js";\nexport const result = value;\n');
  writeFileSync(path.join(dir, 'lib/index.ts'), 'export const value = 42;\n');
  return dir;
}

function mutate(graph: WikiGraphView): void {
  const node = graph.nodes.find((item) => item.id === 'app')!;
  node.id = 'changed';
  node.files[0]!.file = 'changed-file';
  node.exports[0]!.name = 'changed-export';
  node.exports[0]!.cite.line = 999;
  graph.edges[0]!.from = 'changed-edge';
  graph.edges[0]!.citations![0]!.file = 'changed-citation';
  graph.coverage.importEvidence!.checkedCitations = 999;
  graph.nodes.push({ id: 'added', sourceFiles: 0, testFiles: 0, bytes: 0, files: [], exports: [] });
  graph.edges[0]!.citations!.push({ file: 'added', line: 1 });
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.mocked(scanRepo).mockClear();
  steeringReads.completed = 0;
});

describe('wiki graph cache isolation', () => {
  it('keeps nested caller mutations out of cached and subsequent snapshots', async () => {
    const dir = fixture();
    const first = await buildWikiGraph(dir);
    expect(first.nodes.find((node) => node.id === 'app')?.exports).not.toHaveLength(0);
    expect(first.edges[0]?.citations).toEqual([{ file: 'app/index.ts', line: 1 }]);
    expect(first.coverage.importEvidence?.checkedCitations).toBe(1);
    const expected = structuredClone(first);
    expect(JSON.stringify(first)).not.toContain('export const result = value');
    mutate(first);
    const second = await buildWikiGraph(dir);
    expect(second).toEqual(expected);
    mutate(second);
    expect(await buildWikiGraph(dir)).toEqual(expected);
    expect(scanRepo).toHaveBeenCalledTimes(1);
  });

  it('coalesces simultaneous scans while giving every reader an independent graph', async () => {
    const dir = fixture();
    const originalScan = vi.mocked(scanRepo).getMockImplementation()!;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.mocked(scanRepo).mockImplementationOnce(async (...args) => {
      await gate;
      return originalScan(...args);
    });
    const firstPromise = buildWikiGraph(dir);
    const secondPromise = buildWikiGraph(dir);
    try {
      await vi.waitFor(() => {
        expect(steeringReads.completed).toBe(2);
        expect(scanRepo).toHaveBeenCalledTimes(1);
      });
    } finally { release(); }
    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    const expected = structuredClone(second);
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    mutate(first);
    expect(second).toEqual(expected);
    mutate(second);
    expect(await buildWikiGraph(dir)).toEqual(expected);
    expect(scanRepo).toHaveBeenCalledTimes(1);
  });

  it('rescans when ignorePaths changes and never serves the prior policy result', async () => {
    const dir = fixture();
    const original = await buildWikiGraph(dir);
    expect(original.nodes.map((node) => node.id)).toContain('lib');
    mkdirSync(path.join(dir, '.ashlr'));
    writeFileSync(path.join(dir, '.ashlr/wiki.json'), JSON.stringify({ ignorePaths: ['lib/'] }));
    const restricted = await buildWikiGraph(dir);
    expect(restricted.nodes.map((node) => node.id)).not.toContain('lib');
    expect(restricted.nodes.flatMap((node) => node.files).some((file) => file.file.startsWith('lib/'))).toBe(false);
    expect(scanRepo).toHaveBeenCalledTimes(2);
    expect(scanRepo).toHaveBeenLastCalledWith(dir, ['lib/']);
  });

  it('clears a failed single-flight build so a later call can retry', async () => {
    const dir = fixture();
    vi.mocked(scanRepo).mockRejectedValueOnce(new Error('synthetic scan failure'));
    await expect(buildWikiGraph(dir)).rejects.toThrow('synthetic scan failure');
    const recovered = await buildWikiGraph(dir);
    expect(recovered.edges[0]?.citations).toEqual([{ file: 'app/index.ts', line: 1 }]);
    expect(scanRepo).toHaveBeenCalledTimes(2);
  });
});
