import { displaySurfaceTarget, evaluateStandingAuthority } from '../../authority/effective-config.js';
import { mirrorPathFor } from '../../fleet/mirrors.js';
import { nameWithOwnerFromRemote, repoIdentityOfPath } from '../../fleet/repo-identity.js';
import { scrubSecrets } from '../../util/scrub.js';
import { wikiCandidateRepos } from './status.js';
import { systemMapPackageUses } from './system-map.js';
import { mapBlobs, mapGit, mapTree } from './system-map-git.js';

type Anchor = { commit: string; file: string; line: number };
type Edge = { from: string; to: string; kind: 'npm-dependency' | 'mcp-companion' | 'package-import'; anchor: Anchor };
type Manifest = { name: string | null; dependencies: Map<string, Anchor>; companions: Map<string, Anchor> };
const PACKAGE = /^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/;

function manifestFacts(commit: string, contents: ReadonlyMap<string, string>): Manifest {
  const result: Manifest = { name: null, dependencies: new Map(), companions: new Map() };
  const read = (file: string, useKeys: boolean,
    visit: (doc: Record<string, unknown>, lineOf: (value: string) => Anchor | undefined) => void) => {
    const source = contents.get(file);
    if (!source) return;
    try {
      const doc: unknown = JSON.parse(source);
      if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return;
      const locations = new Map<string, number>();
      let line = 1, newline = source.indexOf('\n');
      for (const token of source.matchAll(/"(?:[^"\\]|\\.)*"/g)) {
        const end = token.index + token[0].length;
        while (newline >= 0 && newline < token.index) { line++; newline = source.indexOf('\n', newline + 1); }
        if ((/^\s*:/.test(source.slice(end)) === useKeys) && !locations.has(token[0])) locations.set(token[0], line);
      }
      visit(doc as Record<string, unknown>, value => {
        const line = locations.get(JSON.stringify(value));
        return line ? { commit, file, line } : undefined;
      });
    } catch { /* malformed declarations are not evidence */ }
  };
  read('package.json', true, (doc, lineOf) => {
    if (typeof doc.name === 'string' && PACKAGE.test(doc.name) && scrubSecrets(doc.name) === doc.name) result.name = doc.name;
    for (const key of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      const deps = doc[key];
      if (!deps || typeof deps !== 'object' || Array.isArray(deps)) continue;
      for (const name of Object.keys(deps)) {
        const anchor = lineOf(name);
        if (anchor) result.dependencies.set(name, anchor);
      }
    }
  });
  read('.mcp.json', false, (doc, lineOf) => {
    if (!doc.mcpServers || typeof doc.mcpServers !== 'object') return;
    for (const server of Object.values(doc.mcpServers) as unknown[]) {
      if (!server || typeof server !== 'object' || !('command' in server) || server.command !== 'npx' ||
          !('args' in server) || !Array.isArray(server.args)) continue;
      for (const arg of server.args as unknown[]) {
        if (typeof arg !== 'string') continue;
        const pkg = /^(?<name>(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+)@[^\s]+$/.exec(arg)?.groups?.name;
        const anchor = pkg && lineOf(arg);
        if (pkg && anchor) result.companions.set(pkg, anchor);
      }
    }
  });
  return result;
}

async function inspect(name: string, paths: readonly string[]) {
  const mirrors = mirrorPathFor(name);
  const candidates = [...new Set([mirrors, ...paths.filter(repo => repoIdentityOfPath(repo)?.toLowerCase() === name.toLowerCase())])];
  for (const repo of candidates) {
    try {
      const remote = (await mapGit(repo, ['config', '--local', '--get', 'remote.origin.url'])).toString().trim();
      if (nameWithOwnerFromRemote(remote)?.toLowerCase() !== name.toLowerCase()) continue;
      const graph = await systemMapPackageUses(repo);
      if (!graph) continue;
      const tree = await mapTree(repo, graph.commit, ['package.json', '.mcp.json']);
      const contents = new Map<string, string>();
      await mapBlobs(repo, [...new Set(tree.map(([, blob]) => blob))], (oid, source) => {
        if (source !== null) for (const [file, blob] of tree) if (oid === blob) contents.set(file, source);
      });
      return { commit: graph.commit, update: graph.update, manifest: manifestFacts(graph.commit, contents), imports: graph.uses };
    } catch { /* try the next local checkout; never fetch */ }
  }
  return null;
}

export async function projectWikiEcosystem(scope: readonly string[], paths: readonly string[]) {
  const entries = [];
  const names = [...new Set(scope)].sort();
  for (let i = 0; i < names.length; i += 2) {
    const batch = await Promise.all(names.slice(i, i + 2).map(async repo => ({ repo, facts: await inspect(repo, paths) })));
    entries.push(...batch);
  }
  const packages = new Map<string, string | null>();
  for (const { repo, facts } of entries) {
    const name = facts?.manifest.name;
    if (name) packages.set(name, packages.has(name) ? null : repo);
  }
  const result = {
    schema: 'phantom.wiki.ecosystem.v1',
    status: entries.length ? 'current' : 'unavailable',
    repos: entries.map(({ repo, facts }) => ({ repo, commit: facts?.commit ?? null, update: facts?.update ?? null })),
    edges: [] as Edge[],
    truncated: false,
  };
  let remaining = 24 * 1024 - Buffer.byteLength(JSON.stringify(result));
  for (const { repo, facts } of entries) {
    if (!facts) continue;
    const append = (kind: Edge['kind'], name: string, anchor: Anchor) => {
      const to = packages.get(name);
      if (!to || to === repo) return;
      const edge = { from: repo, to, kind, anchor };
      remaining -= Buffer.byteLength(JSON.stringify(edge)) + 1;
      if (remaining < 0 || result.edges.length >= 100) result.truncated = true;
      else result.edges.push(edge);
    };
    for (const [name, anchor] of facts.manifest.dependencies) append('npm-dependency', name, anchor);
    for (const [name, anchor] of facts.manifest.companions) append('mcp-companion', name, anchor);
    for (const [name, anchor] of facts.imports) append('package-import', name, { ...anchor, commit: facts.commit });
  }
  return result;
}

export async function queryWikiEcosystem() {
  const evaluation = evaluateStandingAuthority({ mode: 'cached', surface: displaySurfaceTarget() });
  const scope = evaluation.grantState === 'active' ? evaluation.grant?.repos ?? [] : [];
  return projectWikiEcosystem(scope.map(repo => repo.nameWithOwner), wikiCandidateRepos());
}
