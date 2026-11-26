import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

import {
  readImmutablePrivateRecords, writeImmutablePrivateRecord,
  type ImmutablePrivateRecordCodec,
} from '../../util/immutable-private-record-store.js';
import { scrubSecrets } from '../../util/scrub.js';
import { checkedCitation } from './citations.js';
import { isWikiReadable } from './scan.js';
import { wikiIgnorePaths } from './steering.js';
import { wikiKey, wikiRoot } from './store.js';
import { extractMapFacts, mapMarks, safeMapPath, sourcePattern } from './system-map-facts.js';
import { mapBlobs, mapDiff, mapGit, mapTree, objectId } from './system-map-git.js';

const STEERING = '.ashlr/wiki.json';
const MAX_TARGETS = 32;
const MAX_LINKS = 24;
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const sha = z.string().regex(objectId);
export const brainSourceSchema = z.object({
  kind: z.enum(['decision', 'lesson', 'pr', 'failure', 'owner-direction']),
  id: z.string().regex(/^[a-z][a-z0-9.-]{0,31}:[A-Za-z0-9._:/-]{1,120}$/)
    .refine(id => scrubSecrets(id) === id),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type BrainSource = z.infer<typeof brainSourceSchema>;

const eligible = (file: string) => sourcePattern.test(file) && safeMapPath(file);

function nodeFile(id: string): string | null {
  if (id.length > 1200) return null;
  const file = id.startsWith('file:') ? id.slice(5) :
    /^(?:symbol|cli|route|mcp):(.+):[^:]+:[1-9]\d*$/.exec(id)?.[1];
  return file && eligible(file) ? file : null;
}

const targetSchema = z.object({
  nodeId: z.string(), file: z.string(), line: z.number().int().positive(), blob: sha,
}).strict().refine(target => nodeFile(target.nodeId) === target.file);
type Target = z.infer<typeof targetSchema>;
const recordSchema = z.object({
  observedCommit: sha,
  source: brainSourceSchema,
  origin: z.enum(['curated', 'cloud-merge']),
  targets: z.array(targetSchema).min(1).max(MAX_TARGETS),
  truncated: z.boolean(),
}).strict();
type Record = z.infer<typeof recordSchema>;

const serialize = (record: Record) => JSON.stringify(record) + '\n';
const recordId = (record: Record) => digest(JSON.stringify([
  record.origin, record.source.kind, record.source.id, record.source.digest, record.observedCommit,
  record.origin === 'curated' ? record.targets[0]?.nodeId : null,
]));
const codec: ImmutablePrivateRecordCodec<Record> = {
  parse: value => recordSchema.safeParse(value).data ?? null,
  serialize,
  recordId,
  recordFileName: record => recordId(record) + '.json',
  isRecordFileName: file => /^[a-f0-9]{64}\.json$/.test(file),
  stageToken: recordId,
  equivalent: (left, right) => serialize(left) === serialize(right),
};

function store(repo: string) {
  const anchorPath = wikiRoot();
  return {
    label: 'Wiki Brain evidence', anchorPath, rootPath: join(anchorPath, wikiKey(repo) + '-brain-v1'),
    lockFileName: '.brain.lock', maxRecordBytes: 64 * 1024,
    defaultMaxFiles: 2048, hardMaxFiles: 2048,
    defaultMaxBytes: 8 * 1024 * 1024, hardMaxBytes: 8 * 1024 * 1024,
    codecForRead: () => codec, codecForWrite: () => codec,
  };
}

export async function brainHead(repo: string): Promise<string | null> {
  const output = await mapGit(repo, ['rev-parse', '--show-prefix', '--verify', 'HEAD^{commit}']).catch(() => null);
  const [prefix, commit] = output?.toString('utf8').split('\n') ?? [];
  return prefix === '' && commit && objectId.test(commit) ? commit : null;
}

async function readTargets(repo: string, commit: string, ids: readonly string[]): Promise<Map<string, Target>> {
  const paths = [...new Set(ids.flatMap(id => nodeFile(id) ?? []))];
  const tree = new Map(await mapTree(repo, commit, [STEERING, ...paths]));
  const steering = tree.get(STEERING);
  let ignore: string[] = [];
  if (steering) await mapBlobs(repo, [steering], (_oid, source) => {
    if (source === null) throw new Error('Pinned steering unavailable.');
    ignore = wikiIgnorePaths(JSON.parse(source));
  });
  const blobs = new Map<string, string[]>();
  for (const file of paths) {
    const oid = tree.get(file);
    if (oid && isWikiReadable(file, ignore)) blobs.set(oid, [...blobs.get(oid) ?? [], file]);
  }
  const wanted = new Set(ids);
  const targets = new Map<string, Target>();
  await mapBlobs(repo, [...blobs.keys()], (blob, source) => {
    if (source === null) return;
    for (const file of blobs.get(blob)!) {
      const facts = extractMapFacts(source, file);
      const fileId = 'file:' + file;
      if (wanted.has(fileId) && checkedCitation({ file, line: 1 }, facts.lines)) {
        targets.set(fileId, { nodeId: fileId, file, line: 1, blob });
      }
      for (const { id, line } of mapMarks(file, facts)) {
        if (wanted.has(id)) {
          targets.set(id, { nodeId: id, file, line, blob });
        }
      }
    }
  });
  return targets;
}

async function save(repo: string, record: Record) {
  const config = store(repo);
  await mkdir(config.anchorPath, { recursive: true, mode: 0o700 });
  return writeImmutablePrivateRecord(config, record);
}

export async function linkBrainEvidence(repo: string, nodeId: string, source: BrainSource) {
  const observedCommit = await brainHead(repo);
  if (!observedCommit || !nodeFile(nodeId) || !brainSourceSchema.safeParse(source).success) return 'invalid';
  const target = (await readTargets(repo, observedCommit, [nodeId])).get(nodeId);
  return target ? save(repo, { observedCommit, source, origin: 'curated', targets: [target], truncated: false }) : 'invalid';
}

export async function recordBrainMerge(repo: string, githubRepo: string, pr: number, observedCommit: string) {
  if (!objectId.test(observedCommit) || !Number.isSafeInteger(pr) || pr < 1) return 'invalid';
  const parent = (await mapGit(repo, ['rev-parse', '--verify', observedCommit + '^1^{commit}'])).toString('utf8').trim();
  if (!objectId.test(parent)) return 'invalid';
  const paths = (await mapDiff(repo, parent, observedCommit))
    .filter(([file, blob]) => blob !== null && eligible(file)).map(([file]) => file).sort();
  const ids = paths.slice(0, MAX_TARGETS).map(file => 'file:' + file);
  if (!ids.length) return 'empty';
  const targets = [...(await readTargets(repo, observedCommit, ids)).values()];
  if (!targets.length) return 'empty';
  const id = 'github:' + githubRepo.toLowerCase() + '/pull/' + pr;
  const source = brainSourceSchema.parse({ kind: 'pr', id, digest: digest(JSON.stringify([id, observedCommit])) });
  return save(repo, { observedCommit, source, origin: 'cloud-merge', targets, truncated: paths.length > MAX_TARGETS });
}

type Staleness = 'valid' | 'target-changed' | 'target-removed' | 'unknown-ancestry';

export async function queryBrain(
  repo: string, options: { focus?: string; revision?: string; cloudFiles?: ReadonlySet<string> } = {},
) {
  const { focus, revision, cloudFiles } = options;
  const commit = revision === undefined ? await brainHead(repo) : objectId.test(revision) ? revision : null;
  const result = { schema: 'phantom.wiki.brain.v1', status: 'current', commit, truncated: false,
    links: [] as Array<Omit<Target, 'blob'> & Pick<Record, 'source' | 'observedCommit'> & { staleness: Staleness }> };
  if (!commit) return { ...result, status: 'unavailable' };
  const records = readImmutablePrivateRecords(store(repo));
  if (records.sourceState === 'degraded' && !records.limitExceeded) return { ...result, status: 'unavailable' };
  const candidates = records.records.filter(record => !cloudFiles || record.origin === 'cloud-merge')
    .sort((a, b) => recordId(a).localeCompare(recordId(b)))
    .flatMap(record => record.targets.filter(target => (!focus || target.nodeId === focus) && (!cloudFiles || cloudFiles.has(target.file)))
      .map(target => ({ record, target })));
  const selected = candidates.slice(0, MAX_LINKS);
  result.truncated = records.limitExceeded || candidates.length > MAX_LINKS ||
    selected.some(({ record }) => record.truncated);
  if (!selected.length) return result;
  const ancestry = new Map<string, Promise<boolean>>();
  const descends = (before: string) => {
    if (!ancestry.has(before)) ancestry.set(before, mapGit(repo, ['merge-base', '--is-ancestor', before, commit])
      .then(() => true, () => false));
    return ancestry.get(before)!;
  };
  const targets = await readTargets(repo, commit, selected.map(({ target }) => target.nodeId)).catch(() => null);
  let remaining = 24 * 1024 - Buffer.byteLength(JSON.stringify(result));
  for (const { record, target } of selected) {
    const current = targets?.get(target.nodeId);
    const staleness: Staleness = !targets || !await descends(record.observedCommit) ? 'unknown-ancestry' :
      !current ? 'target-removed' : current.blob === target.blob ? 'valid' : 'target-changed';
    const { nodeId, file, line } = target;
    const link = { nodeId, file, line, source: record.source, observedCommit: record.observedCommit, staleness };
    remaining -= Buffer.byteLength(JSON.stringify(link)) + 1;
    if (remaining < 0) {
      result.truncated = true;
      break;
    }
    result.links.push(link);
  }
  return result;
}
