import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, rmSync, truncateSync } from 'node:fs';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cmdWiki } from '../src/cli/wiki.js';
import { launchCloudTask, type CloudServiceDeps } from '../src/core/cloud/service.js';
import { wikiCloudSliceStats } from '../src/core/cloud/store.js';
import { refreshCloudTasks } from '../src/core/cloud/tracker.js';
import { writeDropJob } from '../src/core/fleet/drop-job-writer.js';
import { queryBrain, recordBrainRejection } from '../src/core/knowledge/wiki/brain.js';
import { projectWikiEcosystem } from '../src/core/knowledge/wiki/ecosystem.js';
import { wikiSliceStats } from '../src/core/knowledge/wiki/slice-stats.js';
import { querySystemMap, rankSystemMap } from '../src/core/knowledge/wiki/system-map.js';
import { mapFreshness } from '../src/core/knowledge/wiki/system-map-git.js';
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

describe('Wiki Brain', () => {
  it('links five source kinds through the CLI and reads exact provenance through enrolled-only MCP', async () => {
    const symbol = (await current(TARGET)).nodes.find(node => node.kind === 'symbol')!;
    const focus = symbol.id;
    const commit = symbol.anchor.commit;
    const digest = 'a'.repeat(64);
    const kinds = ['decision', 'lesson', 'pr', 'failure', 'owner-direction'];
    const toolName = 'phm_wiki_brain';
    expect(nativeToolSafety(toolName)).toBe('read');
    expect((await callNativeTool(toolName, { repo: wikiKey(repo.dir) })).isError).toBe(true);
    repo.enroll();
    const name = basename(repo.dir);
    expect((await callNativeTool(toolName, { repo: repo.dir })).isError).toBe(true);
    expect((await callNativeTool(toolName, { repo: name, write: true })).isError).toBe(true);
    const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      for (const kind of kinds) {
        const link = ['brain', name, '--link', focus, '--source-kind', kind, '--source-id', kind + ':entry-1', '--source-digest', digest, '--json'];
        expect(await cmdWiki(link)).toBe(0);
        expect(JSON.parse(String(output.mock.lastCall?.[0]))).toEqual({ status: 'recorded' });
        expect(await cmdWiki(link)).toBe(0);
        expect(JSON.parse(String(output.mock.lastCall?.[0]))).toEqual({ status: 'replayed' });
      }
      expect(await cmdWiki(['brain', name, '--focus=' + focus, '--json'])).toBe(0);
      const cli = JSON.parse(String(output.mock.lastCall?.[0]));
      const reply = await callNativeTool(toolName, { repo: wikiKey(repo.dir), focus });
      expect(reply.isError).toBeUndefined();
      expect(JSON.parse(reply.content[0]!.text)).toEqual(cli);
      expect(cli.commit).toBe(commit);
      expect(cli.links).toHaveLength(kinds.length);
      for (const kind of kinds) expect(cli.links).toContainEqual({
        nodeId: focus, file: TARGET, line: 1, observedCommit: commit, staleness: 'valid',
        source: { kind, id: kind + ':entry-1', digest },
      });
    } finally {
      output.mockRestore();
    }
  });

  it('distinguishes pinned validity, a changed matching node, removal, and non-ancestor history', async () => {
    const prior = git('rev-parse', 'HEAD');
    const branch = git('branch', '--show-current');
    const node = (await current(TARGET)).nodes.find(node => node.kind === 'symbol')!;
    repo.enroll();
    const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      expect(await cmdWiki(['brain', basename(repo.dir), '--link', node.id, '--source-kind', 'lesson',
        '--source-id', 'retro:123', '--source-digest', 'a'.repeat(64)])).toBe(0);
    } finally {
      output.mockRestore();
    }
    repo.writeFile(TARGET, 'export const value = 2;\n');
    const staleness = async () => (await queryBrain(repo.dir, { focus: node.id })).links[0]?.staleness;
    expect(await staleness()).toBe('valid');
    commit();
    expect(await staleness()).toBe('target-changed');
    repo.writeFile(TARGET, 'export const replacement = 2;\n');
    commit();
    expect(await staleness()).toBe('target-removed');
    git('switch', '--orphan', 'unrelated');
    repo.writeFile(TARGET, 'export const value = 1;\n');
    commit();
    expect(await staleness()).toBe('unknown-ancestry');
    git('switch', branch);
    expect((await queryBrain(repo.dir, { revision: prior })).links[0]?.staleness).toBe('valid');
  });

  it('projects a tracked merge only after the exact SHA is observed, then includes its receipt in the next Cloud launch', async () => {
    const identity = 'example/wiki-brain-fixture';
    git('remote', 'add', 'origin', 'https://github.com/' + identity + '.git');
    repo.enroll();
    const baseBranch = git('branch', '--show-current');
    const prompts: string[] = [];
    const deps: CloudServiceDeps = {
      checkout: { git: async (args, opts) => {
        if (args[0] === 'clone') execFileSync('git', ['clone', '--quiet', '--', repo.dir, args.at(-1)!], { cwd: opts.cwd });
        if (args[0] === 'checkout') execFileSync('git', ['-C', opts.cwd, 'pull', '--quiet', '--ff-only']);
        return { ok: true, stdout: '', stderr: '' };
      } },
      launcher: {
        seatArgv: () => ['/fake/claude'], platform: 'darwin', trustFolder: () => undefined,
        run: async argv => {
          prompts.push(argv.at(-1)!);
          return { code: 0, timedOut: false, output: 'Created cloud session: Wiki Brain\nView: https://claude.ai/code/session_wikibrain' };
        },
      },
    };
    const req = { repo: identity, baseBranch, origin: 'operator' as const, prompt: 'Review ' + TARGET };
    const initial = await launchCloudTask(req, deps);
    expect(initial).toMatchObject({ ok: true });
    expect(initial.task?.wikiSlice?.bytes).toBeGreaterThan(0);
    expect(initial.task?.wikiSlice?.bytes).toBeLessThanOrEqual(3072);
    const checkoutCommit = git('rev-parse', 'HEAD');
    expect(initial.task?.wikiSlice?.freshness).toEqual({
      commit: checkoutCommit, defaultCommit: checkoutCommit, ahead: 0, behind: 0,
    });
    expect(prompts[0]).toContain('0 behind, 0 ahead');
    expect(prompts[0]).not.toContain('Related Wiki Brain');
    repo.writeFile(TARGET, 'export const value = 7;\n');
    const mergeSha = commit();
    const task = initial.task!;
    const gh = async (args: string[]) => ({
      ok: true, stderr: '', stdout: args[1] === 'view' ? JSON.stringify({ mergeCommit: { oid: mergeSha } }) : JSON.stringify([{
        number: 7, url: 'https://github.com/' + identity + '/pull/7', state: 'MERGED', isDraft: false,
        title: task.title, body: null, headRefName: task.branch, baseRefName: task.baseBranch,
        headRepository: { name: 'wiki-brain-fixture' }, headRepositoryOwner: { login: 'example' }, isCrossRepository: false,
      }]),
    });
    expect(await refreshCloudTasks({ gh })).toEqual({ checked: 1, updated: 1 });
    expect(await refreshCloudTasks({ gh })).toEqual({ checked: 0, updated: 0 });
    expect(wikiCloudSliceStats()).toMatchObject({
      withSlice: { resolved: 1, merged: 1, mergeRate: 1 },
      withoutSlice: { resolved: 0, merged: 0, mergeRate: null },
    });
    const brain = await queryBrain(repo.dir);
    expect(brain.links).toEqual([expect.objectContaining({
      nodeId: 'file:' + TARGET, observedCommit: mergeSha, staleness: 'valid',
      source: { kind: 'pr', id: 'github:' + identity + '/pull/7', digest: expect.stringMatching(/^[a-f0-9]{64}$/) },
    })]);
    const second = await launchCloudTask(req, deps);
    expect(second.ok).toBe(true);
    expect(prompts[1]).toContain(TARGET + ' — PR #7 at ' + mergeSha.slice(0, 12));
    git('update-ref', 'refs/remotes/origin/' + baseBranch, mergeSha);
    repo.writeFile(TARGET, 'export const value = 11;\n');
    const rejected = commit();
    expect(await refreshCloudTasks({ gh: async args => {
      if (args[1] === 'view') return {
        ok: true, stderr: '', stdout: JSON.stringify({ headRefOid: rejected, statusCheckRollup: [{ name: 'typecheck', conclusion: 'FAILURE' }] }),
      };
      const matching = JSON.parse((await gh(args)).stdout);
      matching[0] = { ...matching[0], number: 8, url: 'https://github.com/' + identity + '/pull/8',
        state: 'CLOSED', headRefName: second.task!.branch };
      return { ok: true, stderr: '', stdout: JSON.stringify(matching) };
    } })).toEqual({ checked: 1, updated: 1 });
    expect((await queryBrain(repo.dir)).links).toContainEqual(expect.objectContaining({
      observedCommit: rejected, nodeId: 'file:' + TARGET, staleness: 'valid', lesson: expect.stringContaining('typecheck'),
    }));
  });
});

afterEach(() => fixture.cleanup());

it('indexes scoped repositories incrementally and pins cross-repo declaration and import evidence', async () => {
  git('remote', 'add', 'origin', 'https://github.com/example/consumer.git');
  const companion = fixture.makeRepo({ files: { 'package.json': '{"name":"@example/companion"}\n', 'main.ts': 'export const entry = 1;\n' } });
  execFileSync('git', ['-C', companion.dir, 'remote', 'add', 'origin', 'https://github.com/example/companion.git']);
  repo.writeFile('package.json', '{\n  "name": "consumer",\n  "dependencies": {\n    "@example/companion": "1.2.3"\n  }\n}\n');
  repo.writeFile('.mcp.json', '{"mcpServers":{"fixture":{"command":"npx","args":["@example/companion@1.2.3"]}}}\n');
  repo.writeFile(IMPORTER, 'import "@example/companion/subpath";\n');
  const revision = commit();
  const run = () => projectWikiEcosystem(['example/consumer', 'example/companion', 'example/missing'], [repo.dir, companion.dir]);
  expect(await run()).toMatchObject({
    repos: [
      { repo: 'example/companion', update: 'cold' },
      { repo: 'example/consumer', commit: revision, update: 'cold' },
      { repo: 'example/missing', commit: null },
    ],
    edges: [
      { from: 'example/consumer', to: 'example/companion', kind: 'npm-dependency', anchor: { file: 'package.json', line: 4, commit: revision } },
      { kind: 'mcp-companion', anchor: { file: '.mcp.json', line: 1, commit: revision } },
      { kind: 'package-import', anchor: { file: IMPORTER, line: 1, commit: revision } },
    ],
  });
  repo.writeFile(IMPORTER, 'export const replacement = true;\n');
  expect((await run()).edges).toHaveLength(3);
  commit();
  expect(await run()).toMatchObject({ repos: [{ update: 'unchanged' }, { update: 'incremental' }, { update: null }] });
  expect((await run()).edges).toHaveLength(2);
});

it('links workspace package identities and typed declarations, even to an unindexed GitHub target', async () => {
  git('remote', 'add', 'origin', 'https://github.com/example/consumer.git');
  const companion = fixture.makeRepo({ files: {
    'npm-mcp/package.json': '{"name":"@example/companion"}\n',
    'crates/companion/Cargo.toml': '[package]\nname = "companion-crate"\n',
    'pyproject.toml': '[project]\nname = "companion_py"\n',
  } });
  execFileSync('git', ['-C', companion.dir, 'remote', 'add', 'origin', 'https://github.com/example/companion.git']);
  repo.writeFile('package.json', '{\n  "dependencies": {"renamed": "npm:@example/companion@1"}\n}\n');
  repo.writeFile('.mcp.json', '{"mcpServers":{"fixture":{"command":"npx","args":["-y","--package=@example/companion","fixture"]}}}\n');
  repo.writeFile(IMPORTER, 'import "@example/companion/subpath";\n');
  repo.writeFile('Cargo.toml', '[dependencies]\nrenamed = { package = "companion-crate", version = "1" }\n');
  repo.writeFile('pyproject.toml', '[project]\ndependencies = [\n    "companion-py>=1",\n]\n');
  repo.writeFile('.gitmodules', '[submodule "dep"]\n  path = vendor/dep\n  url = ../companion.git\n');
  repo.writeFile('.github/workflows/check.yml', 'jobs:\n  external:\n    uses: example/missing/.github/workflows/check.yml@v1\n  not-a-dependency:\n    steps:\n      - run: |\n          uses: example/companion@v1\n');
  repo.writeFile('Formula/companion.rb', 'class Companion < Formula\n  url "https://github.com/example/companion/archive/v1.tar.gz"\nend\n');
  const revision = commit();
  const graph = await projectWikiEcosystem(['example/consumer', 'example/companion', 'example/missing'], [repo.dir, companion.dir]);
  expect(graph.edges).toHaveLength(8);
  expect(graph.edges).toEqual(expect.arrayContaining([
    ['npm-dependency', 'package.json', 2],
    ['mcp-companion', '.mcp.json', 1],
    ['package-import', IMPORTER, 1],
    ['cargo-dependency', 'Cargo.toml', 2],
    ['git-submodule', '.gitmodules', 3],
    ['python-dependency', 'pyproject.toml', 3],
    ['github-action', '.github/workflows/check.yml', 3, 'example/missing'],
    ['brew-formula', 'Formula/companion.rb', 2],
  ].map(([kind, file, line, to]) => ({
    from: 'example/consumer', to: to ?? 'example/companion', kind, anchor: { file, line, commit: revision },
  }))));
  expect(graph.truncated).toBe(false);
});

it('ranks pinned goal matches and uses unique incoming dependencies to break relevance ties', async () => {
  repo.writeFile('src/core/alpha.ts', 'export const shared = 1;\n');
  repo.writeFile('src/core/zeta.ts', 'export const shared = 1;\n');
  repo.writeFile(IMPORTER, 'import "../core/zeta.js";\n');
  const pinned = commit();
  repo.writeFile(IMPORTER, 'import "../core/alpha.js";\n');
  commit();
  expect((await rankSystemMap(repo.dir, pinned, 'shared')).map(node => node.file))
    .toEqual(['src/core/zeta.ts', 'src/core/alpha.ts']);
});

it('enriches the fleet drop prompt and joins only measured jobs with resolved PR delivery', async () => {
  git('remote', 'add', 'origin', 'https://github.com/example/phantom.git');
  repo.enroll();
  const pin = git('rev-parse', 'HEAD');
  expect(await mapFreshness(repo.dir, pin)).toEqual({ commit: pin, defaultCommit: null, ahead: null, behind: null });
  repo.writeFile(TARGET, 'export const newer = true;\n');
  const defaultCommit = commit();
  git('update-ref', 'refs/remotes/origin/main', defaultCommit);
  git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  git('checkout', '--detach', pin);
  const root = join(repo.dir, 'disposable-runs');
  const now = () => new Date('2026-01-01T00:00:00.000Z');
  const job = { id: 'WIKISERVED', repo: 'phantom', lane: 'claude', tier: 'work', body: 'Review ' + TARGET };
  const { file } = await writeDropJob(root, job, now);
  expect(readFileSync(file, 'utf8')).toContain(`Ranked Wiki map at ${git('rev-parse', 'HEAD')}`);
  expect(readFileSync(file, 'utf8')).toContain(`local origin/HEAD ${defaultCommit}: 1 behind, 0 ahead`);
  await writeDropJob(root, { ...job, id: 'WIKICONTROL', repo: 'locus' }, now);
  await writeDropJob(root, { ...job, id: 'WIKIUNRESOLVED' }, now);
  const ledger = join(root, 'metrics', 'jobs.jsonl');
  const rows = readFileSync(ledger, 'utf8').trim().split('\n').map(row => JSON.parse(row));
  expect(rows[0]).toMatchObject({ event: 'wiki_slice', job: 'RQ-PHX-WIKISERVED', wikiSlice: { nodeIds: expect.arrayContaining(['file:' + TARGET]) } });
  expect(rows[0].wikiSlice.bytes).toBeGreaterThan(0);
  expect(rows[0].wikiSlice.bytes).toBeLessThanOrEqual(3072);
  expect(rows[0].wikiSlice.freshness).toEqual({ commit: pin, defaultCommit, behind: 1, ahead: 0 });
  expect(rows[1].wikiSlice).toEqual({ bytes: 0, nodeIds: [] });
  const url = 'https://github.com/example/phantom/pull/8';
  const ts = '2026-01-01T00:05:00.000Z';
  for (const row of [
    { event: 'publish', job: 'RQ-PHX-WIKISERVED', url, ts },
    { event: 'merged', url, mergedAt: '2026-01-01T00:06:00.000Z' },
    { event: 'publish', source: 'metrics-outcomes-reconciler', jobId: 'RQ-PHX-WIKICONTROL',
      prUrl: 'https://github.com/example/locus/pull/9', outcome: 'CLOSED', closedAt: 'invalid', ts },
    { event: 'outcome', job: 'RQ-PHX-PRE-WIKI', state: 'MERGED', ts },
  ]) appendFileSync(ledger, JSON.stringify(row) + '\n');
  expect((await wikiSliceStats(root)).fleet).toMatchObject({
    window: { source: join('metrics', 'jobs.jsonl'), maxBytes: 16 * 1024 * 1024 },
    truncated: false, measuredJobs: 3, unmeasuredResolved: 1,
    withSlice: { resolved: 1, merged: 1, mergeRate: 1 },
    withoutSlice: { resolved: 1, merged: 0, mergeRate: 0 },
  });
  truncateSync(ledger, 16 * 1024 * 1024 + readFileSync(ledger).length);
  appendFileSync(ledger, '\n' + JSON.stringify({ event: 'outcome', job: 'RQ-PHX-WIKISERVED', state: 'MERGED', ts }) + '\n');
  expect((await wikiSliceStats(root)).fleet).toMatchObject({ truncated: true, measuredJobs: 0, unmeasuredResolved: 1 });
});

it('stores scrubbed rejection lessons against the exact PR head and applies existing validity checks', async () => {
  const base = git('rev-parse', 'HEAD');
  git('update-ref', 'refs/remotes/origin/master', base);
  repo.writeFile(TARGET, 'export const value = 8;\n');
  const head = commit();
  expect(await recordBrainRejection(repo.dir, 'example/wiki', 9, head, 'master', ['typecheck', 'token=ghp_' + 'a'.repeat(36)]))
    .toBe('recorded');
  const brain = await queryBrain(repo.dir, { revision: head });
  expect(brain.links).toEqual([expect.objectContaining({
    observedCommit: head, nodeId: 'file:' + TARGET, staleness: 'valid', lesson: expect.stringContaining('typecheck'),
  })]);
  expect(JSON.stringify(brain)).not.toContain('ghp_');
  expect((await queryBrain(repo.dir, { revision: base })).links[0]?.staleness).toBe('unknown-ancestry');
  repo.writeFile(TARGET, 'export const value = 9;\n');
  commit();
  expect((await queryBrain(repo.dir)).links[0]?.staleness).toBe('target-changed');
});

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
