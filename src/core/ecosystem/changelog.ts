/** Read-only, deterministic ecosystem change evidence. No model calls or clock reads. */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ECOSYSTEM_CHANGELOG_REPOSITORIES, ECOSYSTEM_TIER_RANK,
  type EcosystemChangelogRepository,
} from './map.js';
import { ECOSYSTEM_CHANGELOG_LINKS, type EcosystemChangelogLink } from './changelog-links.js';

export type ChangelogSource = 'changelog' | 'release' | 'pull-request';
export interface EcosystemChange {
  id: string;
  repository: string;
  source: ChangelogSource;
  title: string;
  body: string;
  date: string | null;
  url: string;
  version?: string;
  number?: number;
  prerelease?: boolean;
  unreleased?: boolean;
  crossRepo: boolean;
  relatedPullRequests: string[];
}
export interface ChangelogSourceStatus {
  source: ChangelogSource;
  status: 'complete' | 'missing' | 'error' | 'truncated';
  /** Fixed diagnostic codes only. Transport errors may contain credentials. */
  reason?: 'unavailable' | 'invalid-response' | 'not-public' | 'page-limit';
}
export interface EcosystemChangelog {
  schemaVersion: 1;
  complete: boolean;
  repositories: Array<EcosystemChangelogRepository & {
    sources: ChangelogSourceStatus[];
    changes: EcosystemChange[];
  }>;
}
export interface CollectEcosystemChangelogOptions {
  /** Parent of the local repository directories, never inferred from HOME. */
  root: string;
  repositories?: readonly EcosystemChangelogRepository[];
  manualLinks?: readonly EcosystemChangelogLink[];
  /** Per source and repo. Exhausting this bound is explicitly incomplete. */
  maxPages?: number;
  /** Injectable public GitHub REST reader for offline fixtures. */
  github?: (endpoint: string) => Promise<unknown>;
}

const MAX_BYTES = 4 * 1024 * 1024;
const SOURCES: readonly ChangelogSource[] = ['changelog', 'release', 'pull-request'];
const REPOSITORY = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9._-]*$/i;
const DIRECTORY = /^[a-z0-9][a-z0-9._-]*$/i;
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const clean = (value: string): string => value.replace(/\r\n?/g, '\n').replace(/[\u2010-\u2015]/g, ' - ').trim();
class InvalidResponse extends Error {}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InvalidResponse();
  return value as Record<string, unknown>;
}
function string(value: unknown): string {
  if (typeof value !== 'string') throw new InvalidResponse();
  return clean(value);
}
function positive(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new InvalidResponse();
  return Number(value);
}
function timestamp(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new InvalidResponse();
  }
  // Date.parse normalizes February 30 instead of rejecting it. Check the local
  // calendar day separately so valid timezone offsets remain supported.
  const day = value.slice(0, 10);
  if (new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day) throw new InvalidResponse();
  return new Date(value).toISOString();
}

/** Fixed public host, GET only, argv execution, bounded time/output, no token handling. */
export function readPublicChangelogApi(endpoint: string): Promise<unknown> {
  // Do not permit injected hosts, arbitrary endpoints, or gh placeholder expansion.
  if (!/^repos\/[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9._-]*(?:\/(?:releases|pulls)\?(?:state=closed&sort=updated&direction=desc&)?per_page=100&page=[1-9]\d*)?$/i.test(endpoint)) {
    return Promise.reject(new Error('Unsupported changelog endpoint'));
  }
  return new Promise((resolve, reject) => {
    execFile('gh', ['api', '--hostname', 'github.com', '--method', 'GET', endpoint], {
      encoding: 'utf8', timeout: 15_000, maxBuffer: MAX_BYTES, windowsHide: true,
    }, (error, stdout) => {
      if (error) { reject(new Error('Public GitHub source unavailable')); return; }
      try { resolve(JSON.parse(stdout)); } catch { reject(new InvalidResponse()); }
    });
  });
}

function change(repository: string, source: ChangelogSource, key: string, title: string, body: string, date: string | null, url: string): EcosystemChange {
  return { id: `${repository}:${source}:${key}`, repository, source, title, body, date, url, crossRepo: false, relatedPullRequests: [] };
}

/** Keep version sections intact, including nested headings and fenced examples. */
export function parseEcosystemChangelog(repository: string, markdown: string): EcosystemChange[] {
  const sections: Array<{ heading: string; body: string[] }> = [];
  let fence: { marker: string; length: number } | undefined;
  for (const line of clean(markdown).split('\n')) {
    const delimiter = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    const inFence = !!fence;
    if (delimiter) {
      if (!fence) fence = { marker: delimiter[1][0], length: delimiter[1].length };
      else if (delimiter[1][0] === fence.marker && delimiter[1].length >= fence.length && !delimiter[2].trim()) fence = undefined;
    }
    if (!inFence && /^##\s+/.test(line)) sections.push({ heading: line, body: [] });
    else sections.at(-1)?.body.push(line);
  }
  // A section's identity is its normalized heading, not just its version:
  // Phantom keeps many pending milestone sections under one `[Unreleased]`
  // version whose bodies legitimately differ. Distinct headings get deterministic
  // `~N` keys in document order; identical headings keep the same key so
  // conflicting bodies still fail in unique().
  const keys = new Map<string, string>();
  const perVersion = new Map<string, number>();
  const entries = sections.flatMap(({ heading, body }) => {
    const match = /^##\s+(?:\[([^\]]+)\](?:\([^)]*\))?|([^\s(]+))(.*)$/.exec(heading);
    if (!match) return [];
    const version = match[1] ?? match[2];
    const pendingHeading = /^unreleased$/i.test(version);
    const unreleased = pendingHeading || /\bunreleased\b/i.test(match[3]);
    if (!pendingHeading && !/^v?\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(version)) return [];
    const day = /\b\d{4}-\d{2}-\d{2}\b/.exec(match[3])?.[0];
    const date = !unreleased && day ? timestamp(`${day}T00:00:00Z`) : null;
    const title = clean(heading.replace(/^##\s+/, ''));
    const identity = `${version}\n${title}`;
    let key = keys.get(identity);
    if (key === undefined) {
      const ordinal = (perVersion.get(version) ?? 0) + 1;
      perVersion.set(version, ordinal);
      key = ordinal === 1 ? version : `${version}~${ordinal}`;
      keys.set(identity, key);
    }
    return [{
      ...change(repository, 'changelog', key, title, clean(body.join('\n')), date,
        `https://github.com/${repository}/blob/HEAD/CHANGELOG.md`),
      version, unreleased,
    }];
  });
  return unique(entries);
}

function releaseChange(repository: string, value: unknown): EcosystemChange[] {
  const record = object(value);
  if (typeof record.draft !== 'boolean') throw new InvalidResponse();
  if (record.draft) return [];
  const id = positive(record.id);
  const version = string(record.tag_name);
  if (!version || typeof record.prerelease !== 'boolean') throw new InvalidResponse();
  return [{
    ...change(repository, 'release', String(id), record.name == null ? version : string(record.name) || version,
      record.body == null ? '' : string(record.body), timestamp(record.published_at),
      `https://github.com/${repository}/releases/tag/${encodeURIComponent(version)}`),
    version, prerelease: record.prerelease,
  }];
}
function pullChange(repository: string, value: unknown): EcosystemChange[] {
  const record = object(value);
  if (record.merged_at === null) return [];
  const number = positive(record.number);
  return [{
    ...change(repository, 'pull-request', String(number), string(record.title),
      record.body == null ? '' : string(record.body), timestamp(record.merged_at),
      `https://github.com/${repository}/pull/${number}`),
    number,
  }];
}
function unique(entries: EcosystemChange[]): EcosystemChange[] {
  const byId = new Map<string, EcosystemChange>();
  for (const entry of entries) {
    const previous = byId.get(entry.id);
    // Conflicting copies must not let API arrival order choose the result.
    if (previous && JSON.stringify(previous) !== JSON.stringify(entry)) throw new InvalidResponse();
    byId.set(entry.id, entry);
  }
  return [...byId.values()];
}

function reference(value: string): { repository: string; ref: string } | null {
  const match = /^(?:https:\/\/github\.com\/([a-z0-9-]+\/[a-z0-9._-]+)\/pull\/([1-9]\d*)|([a-z0-9-]+\/[a-z0-9._-]+)#([1-9]\d*))$/i.exec(value);
  if (!match) return null;
  const repository = (match[1] ?? match[3]).toLowerCase();
  const number = Number(match[2] ?? match[4]);
  if (!REPOSITORY.test(repository) || !Number.isSafeInteger(number)) return null;
  return { repository, ref: `${repository}#${number}` };
}
function references(text: string, known: ReadonlySet<string>): string[] {
  const refs = new Set<string>();
  // URL tokens are consumed whole so another host cannot masquerade as GitHub.
  const tokens = text.match(/https?:\/\/[^\s<>"'`\])]+|(?<![\w./-])[a-z0-9-]+\/[a-z0-9._-]+#[1-9]\d*\b/gi) ?? [];
  for (const token of tokens) {
    const parsed = reference(token.replace(/[.,;:!?]+$/, '').replace(/(#(?:issuecomment|discussion_r|pullrequestreview)-?\d+|\/files|\/commits)$/, ''));
    if (parsed && known.has(parsed.repository)) refs.add(parsed.ref);
  }
  return [...refs].sort(compare);
}
function linkChanges(changes: EcosystemChange[], repositories: ReadonlySet<string>, manual: readonly EcosystemChangelogLink[]): void {
  const graph = new Map<string, Set<string>>();
  function connect(from: string, to: string): void {
    if (from.split('#')[0] === to.split('#')[0]) return;
    for (const [a, b] of [[from, to], [to, from]]) {
      const edges = graph.get(a) ?? new Set<string>();
      edges.add(b);
      graph.set(a, edges);
    }
  }
  for (const entry of changes) {
    if (entry.source !== 'pull-request') continue;
    for (const target of references(`${entry.title}\n${entry.body}`, repositories)) connect(`${entry.repository}#${entry.number}`, target);
  }
  for (const { from, to } of manual) connect(reference(from)!.ref, reference(to)!.ref);
  for (const entry of changes) {
    const refs = new Set(references(`${entry.title}\n${entry.body}`, repositories));
    if (entry.number !== undefined) refs.add(`${entry.repository}#${entry.number}`);
    // Local references in release notes can carry a PR's cross-repo relationship.
    for (const match of `${entry.title}\n${entry.body}`.matchAll(/(?<![\w/])#([1-9]\d*)\b/g)) refs.add(`${entry.repository}#${match[1]}`);
    const related = new Set<string>();
    for (const ref of refs) {
      if (ref.split('#')[0] !== entry.repository) related.add(ref);
      else for (const target of graph.get(ref) ?? []) related.add(target);
    }
    entry.relatedPullRequests = [...related].sort(compare);
    entry.crossRepo = related.size > 0;
  }
}

/**
 * Reads each local CHANGELOG.md plus published releases and merged PRs. Missing
 * files and failed requests remain visible. Public visibility is checked before
 * any source content is admitted. A source failure never erases other sources.
 */
export async function collectEcosystemChangelog(options: CollectEcosystemChangelogOptions): Promise<EcosystemChangelog> {
  const repositories = (options.repositories ?? ECOSYSTEM_CHANGELOG_REPOSITORIES).map((repo) => ({ ...repo, repository: repo.repository.toLowerCase() }));
  const known = new Set(repositories.map((repo) => repo.repository));
  const maxPages = options.maxPages ?? 10;
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 100 || known.size !== repositories.length || repositories.some((repo) =>
    !REPOSITORY.test(repo.repository) || !DIRECTORY.test(repo.directory) || !Object.hasOwn(ECOSYSTEM_TIER_RANK, repo.tier))) {
    throw new Error('Invalid ecosystem changelog configuration');
  }
  const manual = options.manualLinks ?? ECOSYSTEM_CHANGELOG_LINKS;
  for (const link of manual) {
    const from = reference(link.from);
    const to = reference(link.to);
    if (!from || !to || !known.has(from.repository) || !known.has(to.repository) || from.repository === to.repository) throw new Error('Invalid manual cross-repo link');
  }
  repositories.sort((a, b) => ECOSYSTEM_TIER_RANK[a.tier] - ECOSYSTEM_TIER_RANK[b.tier] || compare(a.repository, b.repository));
  const github = options.github ?? readPublicChangelogApi;
  const result: EcosystemChangelog = { schemaVersion: 1, complete: true, repositories: [] };
  for (const repo of repositories) {
    const collected: EcosystemChangelog['repositories'][number] = { ...repo, sources: [], changes: [] };
    result.repositories.push(collected);
    try {
      const metadata = object(await github(`repos/${repo.repository}`));
      if (metadata.private !== false || typeof metadata.full_name !== 'string' || metadata.full_name.toLowerCase() !== repo.repository) {
        collected.sources = SOURCES.map((source) => ({ source, status: 'error', reason: 'not-public' }));
        continue;
      }
    } catch {
      collected.sources = SOURCES.map((source) => ({ source, status: 'error', reason: 'unavailable' }));
      continue;
    }
    try {
      const contents = await readFile(join(options.root, repo.directory, 'CHANGELOG.md'), 'utf8');
      if (Buffer.byteLength(contents) > MAX_BYTES) throw new InvalidResponse();
      const parsed = parseEcosystemChangelog(repo.repository, contents);
      if (!parsed.length && contents.trim()) throw new InvalidResponse();
      collected.changes.push(...parsed);
      collected.sources.push({ source: 'changelog', status: 'complete' });
    } catch (error) {
      collected.sources.push({ source: 'changelog', status: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'error', reason: error instanceof InvalidResponse ? 'invalid-response' : 'unavailable' });
    }
    for (const source of ['release', 'pull-request'] as const) {
      let entries: EcosystemChange[] = [];
      let complete = false;
      try {
        for (let page = 1; page <= maxPages; page++) {
          const path = source === 'release' ? 'releases?' : 'pulls?state=closed&sort=updated&direction=desc&';
          const response = await github(`repos/${repo.repository}/${path}per_page=100&page=${page}`);
          if (!Array.isArray(response) || response.length > 100) throw new InvalidResponse();
          entries.push(...response.flatMap((record) => source === 'release' ? releaseChange(repo.repository, record) : pullChange(repo.repository, record)));
          if (response.length < 100) { complete = true; break; }
        }
        entries = unique(entries);
        collected.sources.push(complete ? { source, status: 'complete' } : { source, status: 'truncated', reason: 'page-limit' });
        collected.changes.push(...entries);
      } catch (error) {
        // Discard this source's partial pages; callers can still use other sources.
        collected.sources.push({ source, status: 'error', reason: error instanceof InvalidResponse ? 'invalid-response' : 'unavailable' });
      }
    }
    collected.changes.sort((a, b) => compare(b.date ?? '', a.date ?? '') || SOURCES.indexOf(a.source) - SOURCES.indexOf(b.source) || compare(a.id, b.id));
  }
  linkChanges(result.repositories.flatMap((repo) => repo.changes), known, manual);
  result.complete = result.repositories.every((repo) => repo.sources.every((source) => source.status === 'complete'));
  return result;
}
