import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cmdWiki } from '../src/cli/wiki.js';
import { querySystemMap } from '../src/core/knowledge/wiki/system-map.js';
import { wikiKey, wikiRoot } from '../src/core/knowledge/wiki/store.js';
import { callNativeTool, nativeToolSafety } from '../src/core/mcp-native.js';
import { makeFixture, type DisposableRepo, type H1Fixture } from './helpers/h1-fixture.js';

const IMPORTER = 'src/cli/index.ts';
const TARGET = 'src/core/dep.ts';
const SOURCE = [
  '// import "../misleading.js";',
  'import { value } from "../core/dep.js";',
  "      case 'known-verb':",
  'export const entry = value;',
  '',
].join('\n');
let fixture: H1Fixture;
let repo: DisposableRepo;

function git(...args: string[]): string {
  return execFileSync('git', ['-C', repo.dir, ...args], { encoding: 'utf8' }).trimEnd();
}

async function current(focus?: string) {
  const result = await querySystemMap(repo.dir, focus);
  if (result.status !== 'current' || !('nodes' in result)) throw new Error(JSON.stringify(result));
  return result;
}

function commit(): string {
  git('add', '-A');
  git('commit', '-m', 'update fixture');
  return git('rev-parse', 'HEAD');
}

beforeEach(() => {
  fixture = makeFixture();
  repo = fixture.makeRepo({ files: {
    [IMPORTER]: SOURCE,
    [TARGET]: 'export const value = 1;\n',
    'src/core/mcp-native.ts': "  { name: 'phm_fixture', description: 'not indexed' },\n",
    'src/core/verse/verse-api.ts': "  if (path === '/api/verse/fixture') return true;\n",
    'test/entry.test.ts': 'import "../src/cli/index.js";\n',
  } });
});

afterEach(() => fixture.cleanup());

describe('commit-pinned wiki map', () => {
  it('anchors graph output in Git objects, with subsystem, file, symbol, CLI, route, MCP and test navigation', async () => {
    repo.writeFile(IMPORTER, 'export const dirty = true;\n');
    repo.writeFile('untracked.ts', 'export const untracked = true;\n');
    const overview = await current();
    expect(overview.update).toEqual({ mode: 'cold', blobsRead: 5, filesParsed: 5 });
    expect(overview.nodes.map(node => node.label)).toEqual(expect.arrayContaining(['CLI', 'Other core', 'MCP', 'Console and HTTP', 'Tests and verification']));
    const detail = await current(IMPORTER);
    expect(detail.update).toEqual({ mode: 'unchanged', blobsRead: 0, filesParsed: 0 });
    expect(detail.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'cli', label: 'known-verb', anchor: { commit: detail.commit, file: IMPORTER, line: 3 } }),
      expect.objectContaining({ kind: 'symbol', label: 'entry', anchor: { commit: detail.commit, file: IMPORTER, line: 4 } }),
      expect.objectContaining({ kind: 'test', label: 'test/entry.test.ts' }),
    ]));
    expect(detail.edges).toContainEqual(expect.objectContaining({ from: `file:${IMPORTER}`, to: `file:${TARGET}`, kind: 'imports', anchor: { commit: detail.commit, file: IMPORTER, line: 2 } }));
    expect(detail.coverage.unresolvedImports).toBe(0);
    const symbol = detail.nodes.find(node => node.label === 'entry')!;
    expect((await current(symbol.id)).focus).toBe(symbol.id);
    expect((await current('src/core/verse/verse-api.ts')).nodes).toContainEqual(expect.objectContaining({ kind: 'route', label: '/api/verse/fixture' }));
    expect((await current('src/core/mcp-native.ts')).nodes).toContainEqual(expect.objectContaining({ kind: 'mcp', label: 'phm_fixture' }));
    for (const graph of [overview, detail]) for (const { anchor } of [...graph.nodes, ...graph.edges]) {
      const blob = git('show', `${anchor.commit}:${anchor.file}`);
      expect(blob.split('\n').length).toBeGreaterThanOrEqual(anchor.line);
    }
    expect(JSON.stringify(detail)).not.toMatch(/dirty|untracked|misleading/);
  });

  it('reuses unchanged facts and re-resolves imports on edit, rename, delete and add', async () => {
    await current(IMPORTER);
    repo.writeFile(TARGET, '\nexport const value = 2;\n');
    expect((await current(IMPORTER)).update.filesParsed).toBe(0);
    const head = commit();
    const edited = await current(TARGET);
    expect(edited.commit).toBe(head);
    expect(edited.update).toEqual({ mode: 'incremental', blobsRead: 1, filesParsed: 1 });
    expect(edited.nodes).toContainEqual(expect.objectContaining({ label: 'value', anchor: { commit: head, file: TARGET, line: 2 } }));
    git('mv', TARGET, 'src/core/renamed.ts');
    commit();
    const renamed = await current(IMPORTER);
    expect(renamed.update).toEqual({ mode: 'incremental', blobsRead: 0, filesParsed: 0 });
    expect(renamed.coverage.unresolvedImports).toBe(1);
    rmSync(join(repo.dir, 'src/core/renamed.ts'));
    repo.writeFile(TARGET, 'export const value = 3;\n');
    commit();
    const incremental = await current(IMPORTER);
    expect(incremental.update).toEqual({ mode: 'incremental', blobsRead: 1, filesParsed: 1 });
    expect(incremental.coverage.unresolvedImports).toBe(0);
    rmSync(join(wikiRoot(), wikiKey(repo.dir), 'system-map-v1.json'));
    const cold = await current(IMPORTER);
    expect(cold).toEqual({ ...incremental, update: cold.update });
  });

  it('honors committed steering, refuses incomplete refreshes, and bounds responses', async () => {
    repo.writeFile('.ashlr/wiki.json', JSON.stringify({ ignorePaths: [TARGET] }));
    repo.writeFile('src/many.ts', Array.from({ length: 200 }, (_, i) => `export const item${i} = 1;\n`).join(''));
    const head = commit();
    const detail = await current('src/many.ts');
    expect(detail.coverage.ignored).toBe(1);
    expect(detail.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(detail))).toBeLessThanOrEqual(24 * 1024);
    expect(detail.edges.every(edge => [edge.from, edge.to].every(id => detail.nodes.some(node => node.id === id)))).toBe(true);
    expect((await querySystemMap(repo.dir, TARGET)).status).toBe('not-found');
    repo.writeFile('.ashlr/wiki.json', '{');
    const broken = commit();
    expect(await querySystemMap(repo.dir)).toEqual({ schema: 'phantom.wiki.map.v1', status: 'unavailable', requestedCommit: broken, indexedCommit: head });
    rmSync(join(repo.dir, '.ashlr/wiki.json'));
    commit();
    expect((await current(TARGET)).update).toEqual({ mode: 'incremental', blobsRead: 1, filesParsed: 1 });
  });

  it('serves JSON from both the CLI and the enrolled-only native MCP tool without redacting Git SHAs', async () => {
    const repoName = basename(repo.dir);
    expect(nativeToolSafety('phm_wiki_map')).toBe('read');
    expect((await callNativeTool('phm_wiki_map', { repo: repoName })).isError).toBe(true);
    repo.enroll();
    expect((await callNativeTool('phm_wiki_map', { repo: repo.dir })).isError).toBe(true);
    expect((await callNativeTool('phm_wiki_map', { repo: repoName, path: repo.dir })).isError).toBe(true);
    const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      expect(await cmdWiki(['map', repoName, `--focus=${IMPORTER}`, '--json'])).toBe(0);
      const cli = JSON.parse(String(output.mock.lastCall?.[0]));
      const tool = await callNativeTool('phm_wiki_map', { repo: wikiKey(repo.dir), focus: IMPORTER });
      expect(tool.isError).toBeUndefined();
      const mcp = JSON.parse(tool.content[0]!.text);
      expect(mcp).toEqual({ ...cli, update: { mode: 'unchanged', blobsRead: 0, filesParsed: 0 } });
      expect(mcp.commit).toBe(git('rev-parse', 'HEAD'));
    } finally {
      output.mockRestore();
    }
  });
});
