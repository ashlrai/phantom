import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

import { checkedCitation } from './citations.js';
import { groupModules, resolveSpecifier } from './facts.js';
import { extractMapFacts, mapFactsKey, mapFactsSchema, mapMarks, safeMapPath, sourcePattern } from './system-map-facts.js';
import { mapBlobs, mapDiff, mapGit, mapTree, objectId } from './system-map-git.js';
import { isTestFile, isWikiReadable } from './scan.js';
import { wikiIgnorePaths } from './steering.js';
import { wikiKey, wikiRoot } from './store.js';
import type { WikiCitation } from './types.js';

const STEERING = '.ashlr/wiki.json';
const MAX_CACHE_BYTES = 64 * 1024 * 1024;
const MAX_FILES = 40_000;
const SHA = z.string().regex(objectId);
const snapshotSchema = z.object({
  version: z.literal(1),
  commit: SHA,
  steering: SHA.nullable(),
  ignore: z.array(z.string()),
  files: z.array(z.tuple([z.string(), SHA, mapFactsSchema.nullable()])).max(MAX_FILES),
});
type Snapshot = z.infer<typeof snapshotSchema>;
type Facts = z.infer<typeof mapFactsSchema>;
type Update = { mode: 'cold' | 'unchanged' | 'incremental'; blobsRead: number; filesParsed: number };
type Refresh = { snapshot: Snapshot; update: Update } | { requestedCommit: string | null; indexedCommit: string | null };

async function readSnapshot(file: string): Promise<Snapshot | null> {
  try {
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_CACHE_BYTES || (process.platform !== 'win32' && stat.mode & 0o077)) return null;
      const data = Buffer.alloc(stat.size);
      if ((await handle.read(data, { length: data.length })).bytesRead !== data.length) return null;
      return snapshotSchema.safeParse(JSON.parse(data.toString('utf8'))).data ?? null;
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

async function saveSnapshot(file: string, snapshot: Snapshot): Promise<void> {
  const data = JSON.stringify(snapshot);
  if (Buffer.byteLength(data) > MAX_CACHE_BYTES) throw new Error('System map snapshot exceeds its storage budget.');
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, data, { flag: 'wx', mode: 0o600 });
  try { await rename(temp, file); } finally { await rm(temp, { force: true }); }
}

const eligible = (file: string) => sourcePattern.test(file) && safeMapPath(file);
const factsKey = (file: string, oid: string) => `${oid}:${path.posix.extname(file)}:${mapFactsKey(file)}`;

async function refresh(repo: string, revision?: string): Promise<Refresh> {
  const cacheFile = path.join(wikiRoot(), wikiKey(repo), 'system-map-v1.json');
  const previous = await readSnapshot(cacheFile);
  let requestedCommit: string | null = null;
  try {
    if (revision && !objectId.test(revision)) throw new Error('Expected a commit ID.');
    const [prefix, commit] = (await mapGit(repo, ['rev-parse', '--show-prefix', '--verify', (revision ?? 'HEAD') + '^{commit}'])).toString('utf8').split('\n');
    if (prefix !== '' || !commit || !objectId.test(commit)) throw new Error('Expected a committed repository root.');
    requestedCommit = commit;
    const update: Update = { mode: 'cold', blobsRead: 0, filesParsed: 0 };
    if (previous?.commit === commit) return { snapshot: previous, update: { ...update, mode: 'unchanged' } };

    const entries = new Map<string, string>();
    if (previous) {
      const changes = await mapDiff(repo, previous.commit, commit).catch(() => null);
      if (changes) {
        update.mode = 'incremental';
        for (const [file, oid] of previous.files) entries.set(file, oid);
        if (previous.steering) entries.set(STEERING, previous.steering);
        for (const [file, oid] of changes) {
          if (oid && (file === STEERING || eligible(file))) entries.set(file, oid);
          else entries.delete(file);
        }
      }
    }
    if (update.mode === 'cold') {
      for (const [file, oid] of await mapTree(repo, commit)) if (file === STEERING || eligible(file)) entries.set(file, oid);
    }
    const steering = entries.get(STEERING) ?? null;
    entries.delete(STEERING);
    if (entries.size > MAX_FILES) throw new Error('System map file budget exceeded.');
    let ignore: string[] = [];
    if (steering && previous?.steering === steering) ignore = previous.ignore;
    else if (steering) await mapBlobs(repo, [steering], (oid, source) => {
      if (source === null || oid !== steering) throw new Error('Invalid pinned wiki steering.');
      ignore = wikiIgnorePaths(JSON.parse(source));
    });

    const known = new Map<string, Facts>();
    for (const [file, oid, facts] of previous?.files ?? []) if (facts) known.set(factsKey(file, oid), facts);
    const needed = new Map<string, Map<string, string>>();
    const files: Snapshot['files'] = [];
    for (const file of [...entries.keys()].sort()) {
      const oid = entries.get(file)!;
      files.push([file, oid, null]);
      const key = factsKey(file, oid);
      if (!isWikiReadable(file, ignore) || known.has(key)) continue;
      const pending = needed.get(oid) ?? new Map<string, string>();
      pending.set(key, file);
      needed.set(oid, pending);
    }
    await mapBlobs(repo, [...needed.keys()], (oid, source) => {
      update.blobsRead++;
      for (const [key, file] of needed.get(oid)!) {
        const facts = source === null ? { lines: 0, marks: [], imports: [], packageImports: [], limited: true } : extractMapFacts(source, file);
        known.set(key, facts);
        if (source !== null) update.filesParsed++;
      }
    });
    for (const row of files) if (isWikiReadable(row[0], ignore)) row[2] = known.get(factsKey(row[0], row[1])) ?? null;
    const snapshot: Snapshot = { version: 1, commit, steering, ignore, files };
    await saveSnapshot(cacheFile, snapshot);
    return { snapshot, update };
  } catch {
    return { requestedCommit, indexedCommit: previous?.commit ?? null };
  }
}

type Anchor = WikiCitation & { commit: string };
type Node = { id: string; label: string; kind: 'module' | 'file' | 'test' | Facts['marks'][number][0]; anchor: Anchor };
type Edge = { from: string; to: string; kind: 'contains' | 'imports'; anchor: Anchor; count?: number };
const MAX_NODES = 80;
const MAX_EDGES = 120;
const MAX_REPLY_BYTES = 24 * 1024;

const subsystems: ReadonlyArray<[string, RegExp]> = [
  ['CLI', /^src\/cli\//],
  ['Daemon', /^src\/core\/daemon\//],
  ['Fleet and queue', /^src\/(?:fleet\/|core\/(?:fleet|queue|driver)\/)/],
  ['Memory and knowledge', /^src\/core\/(?:memory|knowledge|deepwiki|learn|intent)\//],
  ['MCP', /^src\/(?:mcp\/|core\/mcp[-/])/],
  ['Console and HTTP', /^src\/(?:web-ui\/|core\/(?:verse|web)\/)/],
  ['Tests and verification', /^(?:test\/|scripts\/)/],
  ['Governance', /^src\/core\/(?:authority|policy|sandbox)\//],
  ['Release and CI', /^(?:\.github\/|src\/core\/release\/)/],
  ['Desktop', /^desktop\//],
  ['Comms and agents', /^src\/core\/(?:comms|agents)\//],
  ['Resources and routing', /^src\/core\/(?:resources|routing|router)\//],
  ['Universe and improvement', /^src\/core\/(?:universe|vision|improve|research)\//],
  ['Other core', /^src\/core\//],
];

function mapGroups(files: ReadonlyMap<string, Facts>): Map<string, string[]> {
  const paths = [...files.keys()];
  if (!files.has('src/cli/index.ts') || !files.has('src/core/verse/verse-api.ts')) return groupModules(paths);
  const groups = new Map<string, string[]>();
  for (const file of paths) {
    const group = subsystems.find(([, prefix]) => prefix.test(file))?.[0] ?? file.split('/')[0]!;
    const members = groups.get(group) ?? [];
    members.push(file);
    groups.set(group, members);
  }
  return groups;
}

function project(snapshot: Snapshot, update: Update, focus?: string) {
  const { commit } = snapshot;
  const files = new Map<string, Facts>();
  let skipped = 0;
  let limited = 0;
  let ignored = 0;
  for (const [file, , facts] of snapshot.files) {
    if (!facts) ignored++;
    else {
      if (facts.limited) limited++;
      if (checkedCitation({ file, line: 1 }, facts.lines)) files.set(file, facts);
      else skipped++;
    }
  }
  const groups = mapGroups(files);
  const membership = new Map<string, string>();
  const modules = new Map<string, Node>();
  const anchor = (file: string, line: number): Anchor => ({ commit, file, line });
  const fileNode = (file: string): Node => ({ id: `file:${file}`, kind: isTestFile(file) ? 'test' : 'file', label: file, anchor: anchor(file, 1) });
  for (const [group, members] of groups) {
    const id = `module:${group}`;
    modules.set(id, { id, kind: 'module', label: group, anchor: anchor(members[0]!, 1) });
    for (const file of members) membership.set(file, id);
  }
  const known = new Set(files.keys());
  const nodes = new Map<string, Node>();
  const edges: Edge[] = [];
  const aggregate = new Map<string, Edge>();
  const add = (node: Node) => nodes.set(node.id, node);
  const contains = (from: Node, to: Node) => {
    add(from); add(to);
    edges.push({ from: from.id, to: to.id, kind: 'contains', anchor: to.anchor });
  };

  const selectedModule = focus ? modules.get(focus) : undefined;
  const markedFile = /^(?:symbol|cli|mcp|route):(.+):[^:]+:\d+$/.exec(focus ?? '')?.[1];
  const selectedPath = markedFile ?? focus?.replace(/^file:/, '');
  const selectedFacts = selectedPath ? files.get(selectedPath) : undefined;
  let currentFocus: string | null = null;
  if (!focus) for (const node of modules.values()) add(node);
  if (selectedModule) {
    add(selectedModule);
    currentFocus = selectedModule.id;
    for (const file of groups.get(selectedModule.label)!) contains(selectedModule, fileNode(file));
  }
  if (selectedPath && selectedFacts) {
    const file = fileNode(selectedPath);
    add(file);
    if (!markedFile) currentFocus = file.id;
    for (const { id, kind, label, line } of mapMarks(selectedPath, selectedFacts)) {
      if (markedFile && focus !== id) continue;
      if (markedFile) currentFocus = id;
      contains(file, { id, kind, label, anchor: anchor(selectedPath, line) });
    }
    if (currentFocus) contains(modules.get(membership.get(selectedPath)!)!, file);
  }
  let unresolvedImports = 0;
  for (const [file, facts] of files) for (const [specifier, line] of facts.imports) {
    const target = resolveSpecifier(file, specifier, known);
    if (!target) { unresolvedImports++; continue; }
    if (!checkedCitation({ file, line }, facts.lines)) continue;
    if (currentFocus && selectedFacts) {
      if (file !== selectedPath && target !== selectedPath) continue;
      const from = fileNode(file), to = fileNode(target);
      add(from); add(to);
      edges.push({ from: from.id, to: to.id, kind: 'imports', anchor: anchor(file, line) });
    } else if (!focus || selectedModule) {
      const from = membership.get(file)!, to = membership.get(target)!;
      if (from === to || (selectedModule && from !== focus && to !== focus)) continue;
      const key = JSON.stringify([from, to]);
      const edge = aggregate.get(key);
      if (edge) edge.count!++;
      else aggregate.set(key, { from, to, kind: 'imports', anchor: anchor(file, line), count: 1 });
      add(modules.get(from)!); add(modules.get(to)!);
    }
  }
  edges.push(...aggregate.values());
  const ranked = currentFocus ? [nodes.get(currentFocus)!, ...[...nodes.values()].filter(node => node.id !== currentFocus)] : [...nodes.values()];
  const result = {
    schema: 'phantom.wiki.map.v1', status: focus && !currentFocus ? 'not-found' : 'current',
    commit, focus: currentFocus, update, coverage: { files: files.size, ignored, skipped, limited, unresolvedImports },
    nodes: [] as Node[], edges: [] as Edge[], truncated: false,
  };
  let remaining = MAX_REPLY_BYTES - Buffer.byteLength(JSON.stringify(result));
  const included = new Set<string>();
  for (const node of (result.status === 'current' ? ranked : []).slice(0, MAX_NODES)) {
    remaining -= Buffer.byteLength(JSON.stringify(node)) + 1;
    if (remaining < 0) break;
    result.nodes.push(node); included.add(node.id);
  }
  for (const edge of edges.slice(0, MAX_EDGES)) {
    if (!included.has(edge.from) || !included.has(edge.to)) continue;
    remaining -= Buffer.byteLength(JSON.stringify(edge)) + 1;
    if (remaining < 0) break;
    result.edges.push(edge);
  }
  result.truncated = result.status === 'current' && (result.nodes.length < nodes.size || result.edges.length < edges.length);
  return result;
}

const inFlight = new Map<string, Promise<Refresh>>();

export async function querySystemMap(repo: string, focus?: string) {
  let pending = inFlight.get(repo);
  if (!pending) {
    pending = refresh(repo).finally(() => inFlight.delete(repo));
    inFlight.set(repo, pending);
  }
  const result = await pending;
  if ('snapshot' in result) return project(result.snapshot, result.update, focus);
  return { schema: 'phantom.wiki.map.v1', status: 'unavailable', ...result } as const;
}

const goalTerms = (text: string) => text.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().match(/[a-z0-9]{3,}/g) ?? [];

export async function rankSystemMap(repo: string, revision: string, goal: string) {
  const terms = new Set(goalTerms(goal.slice(0, 8192)).slice(0, 128));
  if (!terms.size) return [];
  const result = await refresh(repo, revision);
  if (!('snapshot' in result)) return [];
  const files = new Map(result.snapshot.files.flatMap(([file, , facts]) => facts?.lines ? [[file, facts] as const] : []));
  const known = new Set(files.keys());
  const incoming = new Map<string, number>();
  for (const [file, facts] of files) {
    const imports = new Set(facts.imports.map(([specifier]) => resolveSpecifier(file, specifier, known)));
    for (const target of imports) if (target && target !== file) incoming.set(target, (incoming.get(target) ?? 0) + 1);
  }
  const hits = (label: string) => [...new Set(goalTerms(label))].filter(term => terms.has(term)).length;
  return [...files.entries()].flatMap(([file, facts]) => {
    const pathHits = hits(file);
    const mark = [...mapMarks(file, facts)].map(node => ({ ...node, score: hits(node.label) }))
      .sort((a, b) => b.score - a.score || a.line - b.line)[0];
    const direct = goal.includes(file) ? 20 : 0;
    const relevance = 2 * pathHits + 3 * (mark?.score ?? 0) + direct;
    return relevance ? [{
      file, nodeId: mark?.score ? mark.id : `file:${file}`, line: mark?.score ? mark.line : 1,
      score: relevance + Math.log2(1 + (incoming.get(file) ?? 0)),
    }] : [];
  }).sort((a, b) => b.score - a.score || a.file.localeCompare(b.file)).slice(0, 12);
}

export async function systemMapPackageUses(repo: string) {
  const result = await refresh(repo);
  if (!('snapshot' in result)) return null;
  const uses = new Map<string, { file: string; line: number }>();
  for (const [file, , facts] of result.snapshot.files) {
    if (!facts) continue;
    for (const [name, line] of facts.packageImports) {
      if (!uses.has(name) && checkedCitation({ file, line }, facts.lines)) {
        uses.set(name, { file, line });
      }
    }
  }
  return { commit: result.snapshot.commit, update: result.update.mode, uses };
}
