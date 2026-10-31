import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { run } from '../examples/upgrade/graph-upgrade-audit.js';
import { buildFleetGraphSeed, seedFleetGraph } from '../src/core/fleet/graph-seed.js';
import { loadGraph, type GraphLoadResult, type GraphSnapshot } from '../src/core/graph/loader.js';

const graph: GraphSnapshot = {
  status: 'ready', complete: true,
  sources: { fleetJson: { state: 'loaded', path: '/private/example' }, seats: { state: 'loaded', count: 0 } },
  issues: [],
  nodes: [
    { id: 'task:root', kind: 'task', private: 'PRIVATE_RECORD' },
    { id: 'task:next', kind: 'task' }, { id: 'output:one', kind: 'output' },
    { id: 'output:orphan', kind: 'output' },
  ],
  edges: [{ from: 'task:next', to: 'task:root' }, { from: 'task:next', to: 'output:one' }],
};

async function audit(args: string[], load: () => Promise<GraphLoadResult> = async () => graph) {
  const output: string[] = [];
  const exit = await run(args, { load, write: text => output.push(text) });
  expect(output).toHaveLength(1);
  return { exit, text: output[0]!, result: JSON.parse(output[0]!) };
}

describe('graph upgrade audit', () => {
  it('counts the connected component in both directions without exposing records', async () => {
    const { exit, result, text } = await audit(['--node', 'task:root']);
    expect(exit).toBe(0);
    expect(result).toEqual({ schemaVersion: 1, status: 'verified', available: true, rootFound: true,
      counts: { tasks: 2, outputs: 1 }, truncated: false, complete: true,
      sources: { fleetJson: 'loaded', seats: 'loaded' }, issues: [], issuesTruncated: false, evidenceComplete: true });
    expect(text).not.toMatch(/PRIVATE_RECORD|private\/example|task:root|output:orphan/);
    expect(await audit(['--node', 'output:orphan'])).toMatchObject({
      exit: 0, result: { rootFound: true, counts: { tasks: 0, outputs: 1 }, truncated: false },
    });
  });

  it('distinguishes an unsupported absent task from a missing supported fleet ID', async () => {
    const missing = await audit(['--node', 'task:orphan']);
    expect(missing).toMatchObject({ exit: 3, result: { status: 'insufficient_evidence', rootFound: false, counts: null } });
    const seed = buildFleetGraphSeed({ fleet: { v: 1 }, seats: [] });
    const read = () => loadGraph(async () => seed);
    expect(await audit(['--node', 'repo:missing'], read)).toMatchObject({
      exit: 1, result: { status: 'not_found', rootFound: false, evidenceComplete: true },
    });
    expect(await audit(['--node', 'task:missing'], read)).toMatchObject({
      exit: 3, result: { status: 'insufficient_evidence', rootFound: false, evidenceComplete: true },
    });
  });

  it('detects truncation even at the end of a long chain', async () => {
    const ids = Array.from({ length: 501 }, (_, i) => `task:${i}`);
    const large: GraphSnapshot = { ...graph, nodes: ids.map(id => ({ id, kind: 'task' })),
      edges: ids.slice(1).map((id, i) => ({ from: ids[i], to: id })) };
    const result = await audit(['--node', ids[0]!], async () => large);
    expect(result).toMatchObject({ exit: 3, result: { rootFound: true, truncated: true, counts: { tasks: 500, outputs: 0 } } });
  });

  it('retains bounded issue metadata and reports incomplete and unknown sources', async () => {
    const partial = buildFleetGraphSeed({ fleet: { repos: [{ repo: 'example/good' },
      { repo: 'example/rejected', token: 'FAKE_PRIVATE_VALUE' }] }, seats: [] });
    const read = () => loadGraph(async () => partial);
    const result = await audit(['--node', 'repo:example/good'], read);
    expect(result).toMatchObject({ exit: 3, result: { rootFound: true, complete: false,
      issues: [{ code: 'secret-field', relatedNodeCount: 0 }], issuesTruncated: false } });
    expect(result.text).not.toMatch(/FAKE_PRIVATE_VALUE|example\/rejected|token/);
    expect(await audit(['--node', 'repo:absent'], read)).toMatchObject({ exit: 3, result: { rootFound: false } });
    const noSeats = buildFleetGraphSeed({ fleet: { repos: [{ repo: 'example/good' }] } });
    expect(await audit(['--node', 'repo:example/good'], () => loadGraph(async () => noSeats)))
      .toMatchObject({ exit: 3, result: { complete: true, sources: { seats: 'absent' }, evidenceComplete: false } });
    expect(await audit(['--node', 'task:root'], async () => ({ ...graph, sources: undefined, issues: undefined })))
      .toMatchObject({ exit: 3, result: { sources: null, issues: null, issuesTruncated: null } });
    const issues = Array.from({ length: 129 }, () => ({ code: 'bad-ref' as const, message: 'PRIVATE', nodeIds: ['PRIVATE'] }));
    const bounded = await audit(['--node', 'task:root'], async () => ({ ...graph, issues }));
    expect(bounded.result.issues).toHaveLength(128);
    expect(bounded.result.issuesTruncated).toBe(true);
    expect(bounded.text).not.toContain('PRIVATE');
  });

  it('uses the real file seeder and injected loader boundary without a running app', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'graph-audit-'));
    try {
      const path = join(dir, 'fleet.json');
      writeFileSync(path, JSON.stringify({ v: 1, repos: [{ repo: 'example/repo' }], lanes: [{ lane: 'codex' }] }));
      const read = () => loadGraph(() => seedFleetGraph({ fleetJsonPath: path, seats: [] }));
      expect(await audit(['--node', 'repo:example/repo'], read)).toMatchObject({
        exit: 0, result: { rootFound: true, counts: { tasks: 0, outputs: 0 }, truncated: false },
      });
      writeFileSync(path, '{broken');
      expect(await audit(['--node', 'repo:example/repo'], read)).toMatchObject({
        exit: 3, result: { status: 'unavailable', available: false, rootFound: null },
      });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('handles unavailable, reader errors, and malformed graphs without private errors', async () => {
    expect(await audit(['--node', 'x'], () => loadGraph(async () => buildFleetGraphSeed())))
      .toMatchObject({ exit: 3, result: { status: 'unavailable' } });
    const failed = await audit(['--node', 'x'], async () => { throw new Error('PRIVATE_FAILURE'); });
    expect(failed).toMatchObject({ exit: 1, result: { error: { code: 'GRAPH_READ_FAILED' } } });
    expect(failed.text).not.toContain('PRIVATE_FAILURE');
    expect(await audit(['--node', 'x'], async () => ({ ...graph, nodes: [{ id: 'x' }, { id: 'x' }] })))
      .toMatchObject({ exit: 1, result: { error: { code: 'GRAPH_READ_FAILED' } } });
  });

  it.each([[], ['--node'], ['--node', ''], ['--node', '--help'], ['--node', ' x'],
    ['--node', 'x\ny'], ['--node', 'x'.repeat(161)], ['--node', 'x', '--node', 'y']])(
    'rejects invalid arguments before reading: %j', async (...args) => {
      const load = vi.fn(async () => graph);
      expect(await audit(args, load)).toMatchObject({ exit: 2, result: { error: { code: 'GRAPH_USAGE' } } });
      expect(load).not.toHaveBeenCalled();
    },
  );

  it('help is side-effect free and the executable entrypoint works', async () => {
    const load = vi.fn(async () => graph);
    const lines: string[] = [];
    expect(await run(['--help'], { load, write: text => lines.push(text) })).toBe(0);
    expect(load).not.toHaveBeenCalled();
    expect(lines[0]).toContain('Usage: npx tsx');
    const home = mkdtempSync(join(tmpdir(), 'graph-audit-home-'));
    try {
      const child = spawnSync(process.execPath, ['node_modules/tsx/dist/cli.mjs',
        'examples/upgrade/graph-upgrade-audit.ts', '--help'], {
        encoding: 'utf8', env: { HOME: home, ASHLR_HOME: home, PATH: process.env.PATH },
      });
      expect(child.status).toBe(0);
      expect(child.stdout).toContain('Usage: npx tsx');
      expect(child.stderr).toBe('');
    } finally { rmSync(home, { recursive: true, force: true }); }
  }, 20_000);
});
