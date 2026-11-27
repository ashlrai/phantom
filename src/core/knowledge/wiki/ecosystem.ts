import { displaySurfaceTarget, evaluateStandingAuthority } from '../../authority/effective-config.js';
import { mirrorPathFor } from '../../fleet/mirrors.js';
import { nameWithOwnerFromRemote, repoIdentityOfPath } from '../../fleet/repo-identity.js';
import { scrubSecrets } from '../../util/scrub.js';
import { wikiCandidateRepos } from './status.js';
import { systemMapPackageUses } from './system-map.js';
import { mapBlobs, mapGit, mapTree } from './system-map-git.js';
import { ecosystemDeclarations, type Anchor, type Declaration } from './ecosystem-declarations.js';

type Edge = { from: string; to: string; kind: 'npm-dependency' | 'mcp-companion' | 'package-import' | Declaration['kind']; anchor: Anchor };
type Manifest = { names: Set<string>; dependencies: Map<string, Anchor>; companions: Map<string, Anchor> };
const PACKAGE = /^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/;
const CORE_MANIFESTS = ['package.json', '.mcp.json', '.gitmodules', 'Cargo.toml', 'desktop/src-tauri/Cargo.toml', 'pyproject.toml'];
const EXTRA_PATHS = ['npm', 'npm-mcp', 'packages', 'crates', '.github/workflows', 'Formula', 'HomebrewFormula'];
const EXTRA_MANIFESTS = /^(?:(?:npm|npm-mcp)\/package\.json|packages\/[\w.-]+\/package\.json|crates\/[\w.-]+\/Cargo\.toml|\.github\/workflows\/[\w.-]+\.ya?ml|(?:Formula|HomebrewFormula)\/[\w.-]+\.rb)$/;
const MAX_EXTRA_MANIFESTS = 128;

function manifestFacts(commit: string, contents: ReadonlyMap<string, string>): Manifest {
  const result: Manifest = { names: new Set(), dependencies: new Map(), companions: new Map() };
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
  for (const file of contents.keys()) {
    if (!file.endsWith('package.json')) continue;
    read(file, true, (doc, lineOf) => {
      if (typeof doc.name === 'string' && PACKAGE.test(doc.name) && scrubSecrets(doc.name) === doc.name) result.names.add(doc.name);
      for (const key of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
        const deps = doc[key];
        if (!deps || typeof deps !== 'object' || Array.isArray(deps)) continue;
        for (const [name, spec] of Object.entries(deps)) {
          const alias = typeof spec === 'string' ? /^npm:((?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+)(?:@[^\s]+)?$/.exec(spec)?.[1] : undefined;
          const anchor = lineOf(name);
          if (anchor && !result.dependencies.has(alias ?? name)) result.dependencies.set(alias ?? name, anchor);
        }
      }
    });
  }
  read('.mcp.json', false, (doc, lineOf) => {
    if (!doc.mcpServers || typeof doc.mcpServers !== 'object') return;
    for (const server of Object.values(doc.mcpServers) as unknown[]) {
      if (!server || typeof server !== 'object' || !('command' in server) || server.command !== 'npx' ||
          !('args' in server) || !Array.isArray(server.args)) continue;
      const args = server.args as unknown[];
      let explicitPackage = false;
      for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (typeof arg !== 'string') break;
        const takesPackage = arg === '-p' || arg === '--package';
        const equalPackage = arg.startsWith('--package=');
        if (arg === '-y' || arg === '--yes') continue;
        const spec = takesPackage ? args[++i] : equalPackage ? arg.slice('--package='.length) : arg;
        if (typeof spec !== 'string' || (!takesPackage && !equalPackage && explicitPackage)) break;
        const pkg = /^(?<name>(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+)(?:@[^\s]+)?$/.exec(spec)?.groups?.name;
        const anchor = pkg && lineOf(equalPackage ? arg : spec);
        if (pkg && anchor) result.companions.set(pkg, anchor);
        if (!takesPackage && !equalPackage) break;
        explicitPackage = true;
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
      const found = await mapTree(repo, graph.commit, [...CORE_MANIFESTS, ...EXTRA_PATHS]);
      const extra = found.filter(([file]) => EXTRA_MANIFESTS.test(file));
      const tree = [...found.filter(([file]) => CORE_MANIFESTS.includes(file)), ...extra.slice(0, MAX_EXTRA_MANIFESTS)];
      const contents = new Map<string, string>();
      const filesByBlob = new Map<string, string[]>();
      for (const [file, blob] of tree) {
        const files = filesByBlob.get(blob) ?? [];
        files.push(file);
        filesByBlob.set(blob, files);
      }
      await mapBlobs(repo, [...new Set(tree.map(([, blob]) => blob))], (oid, source) => {
        if (source !== null) for (const file of filesByBlob.get(oid) ?? []) contents.set(file, source);
      });
      const manifest = manifestFacts(graph.commit, contents);
      for (const file of contents.keys()) if (file.endsWith('package.json') || file === '.mcp.json') contents.delete(file);
      return { commit: graph.commit, update: graph.update, manifest, imports: graph.uses,
        declarations: ecosystemDeclarations(name, graph.commit, contents), truncated: extra.length > MAX_EXTRA_MANIFESTS };
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
  const identify = (name: string, repo: string) => {
    if (!packages.has(name)) packages.set(name, repo);
    else if (packages.get(name) !== repo) packages.set(name, null);
  };
  for (const { repo, facts } of entries) {
    identify('github:' + repo.toLowerCase(), repo);
    for (const name of facts?.manifest.names ?? []) identify(name, repo);
    for (const identity of facts?.declarations.identities ?? []) identify(identity, repo);
  }
  const result = {
    schema: 'phantom.wiki.ecosystem.v1',
    status: entries.length ? 'current' : 'unavailable',
    repos: entries.map(({ repo, facts }) => ({ repo, commit: facts?.commit ?? null, update: facts?.update ?? null })),
    edges: [] as Edge[],
    truncated: entries.some(({ facts }) => facts?.truncated === true),
  };
  let remaining = 24 * 1024 - Buffer.byteLength(JSON.stringify(result));
  for (const { repo, facts } of entries) {
    if (!facts) continue;
    const seen = new Set<string>();
    const append = (kind: Edge['kind'], name: string, anchor: Anchor) => {
      const to = packages.get(name);
      if (!to || to === repo) return;
      const key = kind + ':' + to;
      if (seen.has(key)) return;
      seen.add(key);
      const edge = { from: repo, to, kind, anchor };
      remaining -= Buffer.byteLength(JSON.stringify(edge)) + 1;
      if (remaining < 0 || result.edges.length >= 100) result.truncated = true;
      else result.edges.push(edge);
    };
    for (const [name, anchor] of facts.manifest.dependencies) append('npm-dependency', name, anchor);
    for (const [name, anchor] of facts.manifest.companions) append('mcp-companion', name, anchor);
    for (const [name, anchor] of facts.imports) append('package-import', name, { ...anchor, commit: facts.commit });
    for (const { kind, target, anchor } of facts.declarations.edges) append(kind, target, anchor);
  }
  return result;
}

export async function queryWikiEcosystem() {
  const evaluation = evaluateStandingAuthority({ mode: 'cached', surface: displaySurfaceTarget() });
  const scope = evaluation.grantState === 'active' ? evaluation.grant?.repos ?? [] : [];
  return projectWikiEcosystem(scope.map(repo => repo.nameWithOwner), wikiCandidateRepos());
}
