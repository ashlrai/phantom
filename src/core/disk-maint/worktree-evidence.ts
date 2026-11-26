import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { parseLedgerTs } from '../metrics/loop.js';
import { readSource } from '../fleet/runs-parked-queue.js';
import { withDaemonGitHardening } from '../sandbox/safe-git.js';
import type { MaintRoots } from './protect.js';

const run = promisify(execFile);
const MAX_CACHE = 2 * 1024 * 1024;
const TTL = 5 * 60_000;
const MAIN_REPO = 'ashlrai/phantom';
const PR_URL = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/([1-9]\d{0,8})$/;
const JOB = 'RQ-[A-Za-z0-9][A-Za-z0-9._-]{0,124}';
const BRIDGE_TITLE = new RegExp(`^bridge\\((${JOB})\\)(?=:|\\s|$)`);
const BRIDGE_PR_TITLE = new RegExp(`^bridge: (${JOB})$`);
const BRIDGE_BRANCH = new RegExp(`^codex-bridge/(${JOB})$`);
export const isPullUrl = (url: string): boolean => PR_URL.test(url);
export const isCommitId = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);

export type BridgeVerdict = { at: number; prHead?: string };
export type BridgeCommit = BridgeVerdict & { prUrl?: string; mergeSha?: string };
type PullVerdict = BridgeVerdict & { url: string; state: 'OPEN' | 'CLOSED' | 'MERGED'; mergeSha?: string };
type PullSnapshot = { pulls: PullVerdict[]; bridges?: Record<string, BridgeVerdict> };
export type LookupWorktreePulls = (urls: readonly string[], bridges: boolean) => Promise<PullSnapshot | null>;
export interface WorktreeEvidenceDeps {
  lookupWorktreePulls?: LookupWorktreePulls;
  readWorktreeBridgeCommits?: (roots: MaintRoots) => Promise<Map<string, BridgeCommit>>;
  worktreePullCacheOnly?: boolean;
}

async function readCache<T>(path: string): Promise<T | null> {
  try {
    const source = await readSource(path, MAX_CACHE, false);
    return source.state === 'healthy' ? JSON.parse(source.text) as T : null;
  } catch { return null; }
}

async function writeCache(path: string, value: unknown): Promise<void> {
  const temporary = join(dirname(path), `.disk-maint-${randomUUID()}.tmp`);
  const content = JSON.stringify(value);
  if (Buffer.byteLength(content) > MAX_CACHE) return;
  try {
    await writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
  } catch { await rm(temporary, { force: true }).catch(() => {}); }
}

function validAt(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function validBridge(value: BridgeVerdict | undefined): value is BridgeVerdict {
  return !!value && validAt(value.at) && (value.prHead === undefined || isCommitId(value.prHead));
}

function validPull(value: PullVerdict | undefined): value is PullVerdict {
  return !!value && validBridge(value) && ['OPEN', 'CLOSED', 'MERGED'].includes(value.state) &&
    typeof value.url === 'string' && isPullUrl(value.url);
}

type GhPull = {
  url?: string; state?: PullVerdict['state']; mergedAt?: string; closedAt?: string; createdAt?: string;
  headRefOid?: string; headRefName?: string; title?: string; baseRefName?: string; mergeCommit?: { oid?: string };
};

function githubPull(row: GhPull | null | undefined): PullVerdict | null {
  if (!row?.url || !isPullUrl(row.url) || !row.state || !['OPEN', 'CLOSED', 'MERGED'].includes(row.state)) return null;
  const at = parseLedgerTs(row.state === 'MERGED' ? row.mergedAt : row.state === 'CLOSED' ? row.closedAt : row.createdAt);
  if (at === null) return null;
  return { url: row.url, at, state: row.state, prHead: isCommitId(row.headRefOid) ? row.headRefOid : undefined,
    mergeSha: isCommitId(row.mergeCommit?.oid) ? row.mergeCommit.oid : undefined };
}

const lookupGithub: LookupWorktreePulls = async (urls, bridges) => {
  const fields = 'url state mergedAt closedAt createdAt headRefOid mergeCommit{oid}';
  const aliases = urls.map((url, index) => {
    const [, owner, name, number] = PR_URL.exec(url)!;
    return `p${index}:repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(name)}){pullRequest(number:${number}){${fields}}}`;
  });
  if (bridges) aliases.push(`bridge:repository(owner:"ashlrai",name:"phantom"){pullRequests(first:100,states:MERGED,orderBy:{field:UPDATED_AT,direction:DESC}){nodes{${fields} headRefName title baseRefName}}}`);
  try {
    const request = run('gh', ['api', 'graphql', '--hostname', 'github.com', '--input', '-'],
      { timeout: 5_000, maxBuffer: 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: '1' } });
    request.child.stdin?.on('error', () => {});
    request.child.stdin?.end(JSON.stringify({ query: `{${aliases.join(' ')}}` }));
    const { stdout } = await request;
    const response = JSON.parse(stdout) as { data?: Record<string, { pullRequest?: GhPull; pullRequests?: { nodes?: GhPull[] } }>; errors?: unknown };
    if (!response.data || response.errors) return null;
    const pulls = urls.flatMap((url, index) => {
      const pull = githubPull(response.data?.[`p${index}`]?.pullRequest);
      return pull?.url.toLowerCase() === url.toLowerCase() ? [{ ...pull, url }] : [];
    });
    const merged = response.data.bridge?.pullRequests?.nodes;
    const bridgeIndex: Record<string, BridgeVerdict> = Object.create(null) as Record<string, BridgeVerdict>;
    if (Array.isArray(merged)) for (const row of merged) {
      const pull = githubPull(row);
      if (pull?.state !== 'MERGED' || row.baseRefName !== 'master' ||
        !pull.url.toLowerCase().startsWith(`https://github.com/${MAIN_REPO}/pull/`)) continue;
      const title = (BRIDGE_TITLE.exec(row.title ?? '') ?? BRIDGE_PR_TITLE.exec(row.title ?? ''))?.[1];
      const head = BRIDGE_BRANCH.exec(row.headRefName ?? '')?.[1];
      if (title && head && title !== head) continue;
      const job = title ?? head;
      if (job && (!bridgeIndex[job] || pull.at > bridgeIndex[job].at)) bridgeIndex[job] = { at: pull.at, prHead: pull.prHead };
    }
    return { pulls, ...(Array.isArray(merged) ? { bridges: bridgeIndex } : {}) };
  } catch { return null; }
};

type CachedPull = { checkedAt: number; value: PullVerdict };
type PullCache = { version: 1; pulls: CachedPull[]; bridges?: { checkedAt: number; value: Record<string, BridgeVerdict> } };

export async function readWorktreePulls(roots: MaintRoots, urls: readonly string[], needBridges: boolean,
  lookup: LookupWorktreePulls = lookupGithub, cacheOnly = false): Promise<PullSnapshot> {
  if (urls.length === 0 && !needBridges) return { pulls: [] };
  const path = join(roots.runsDir, 'disk-maint-pulls.json');
  const now = Date.now();
  const fresh = (at: number) => validAt(at) && at <= now && now - at < TTL;
  const cache = await readCache<PullCache>(path);
  const entries = new Map<string, CachedPull>();
  if (cache?.version === 1 && Array.isArray(cache.pulls)) {
    for (const item of cache.pulls) if (item && fresh(item.checkedAt) && validPull(item.value)) entries.set(item.value.url, item);
  }
  let bridges = cache?.version === 1 && cache.bridges && fresh(cache.bridges.checkedAt) ? cache.bridges : undefined;
  const missing = [...new Set(urls)].filter(url => !entries.has(url)).slice(0, 1000);
  const fetchBridges = needBridges && !bridges;
  if (!cacheOnly && (missing.length || fetchBridges)) {
    const fetched = await lookup(missing, fetchBridges).catch(() => null);
    if (fetched) {
      const requested = new Set(missing);
      for (const pull of fetched.pulls) {
        if (validPull(pull) && requested.has(pull.url)) entries.set(pull.url, { value: pull, checkedAt: now });
      }
      if (fetchBridges && fetched.bridges) bridges = { checkedAt: now, value: fetched.bridges };
      await writeCache(path, { version: 1, pulls: [...entries.values()], bridges });
    }
  }
  const result: PullSnapshot = { pulls: urls.flatMap(url => entries.get(url)?.value ?? []) };
  if (needBridges && bridges?.value) {
    result.bridges = Object.fromEntries(Object.entries(bridges.value).filter(([, verdict]) => validBridge(verdict)));
  }
  return result;
}

export async function readWorktreeBridgeCommits(roots: MaintRoots): Promise<Map<string, BridgeCommit>> {
  const repo = process.env.ASHLR_LANDED_REPO || join(dirname(roots.wtDir), 'phantom');
  const path = join(roots.runsDir, 'disk-maint-bridges.json');
  const env = { ...withDaemonGitHardening(Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')))),
    GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1' };
  const git = async (...args: string[]) => (await run('git', ['-C', repo, ...args], {
    timeout: 3_000, maxBuffer: 8 * 1024 * 1024, env,
  })).stdout;
  try {
    const revision = (await git('rev-parse', '--verify', 'refs/remotes/origin/master^{commit}')).trim();
    if (!isCommitId(revision)) return new Map();
    const cache = await readCache<{ version: number; revision: string; jobs: Record<string, BridgeCommit> }>(path);
    if (cache?.version === 1 && cache.revision === revision && cache.jobs) {
      return new Map(Object.entries(cache.jobs).filter(([, verdict]) => validBridge(verdict)));
    }
    const history = await git('log', '-n', '20000', '--first-parent', '--format=%ct%x09%H%x09%s', revision, '--');
    const jobs = new Map<string, BridgeCommit>();
    for (const line of history.split('\n')) {
      const [timestamp, mergeSha, title] = line.split('\t', 3);
      if (!title || !isCommitId(mergeSha)) continue;
      const job = BRIDGE_TITLE.exec(title)?.[1];
      const at = Number(timestamp) * 1000;
      const pr = / \(#([1-9]\d{0,8})\)$/.exec(title)?.[1];
      if (job && validAt(at) && !jobs.has(job)) jobs.set(job, {
        at, mergeSha, prUrl: pr ? `https://github.com/${MAIN_REPO}/pull/${pr}` : undefined,
      });
    }
    await writeCache(path, { version: 1, revision, jobs: Object.fromEntries(jobs) });
    return jobs;
  } catch { return new Map(); }
}
