import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { defaultCloudGh } from '../cloud/tracker.js';
import type { CloudGh } from '../cloud/pr-actions.js';

type Row = Record<string, unknown>;
export interface LeaderFacts {
  schema: 'leader.facts.v1'; generated_at: string;
  sources: { queue: 'ok' | 'unknown'; jobs: 'ok' | 'unknown' | 'partial' };
  jobs: { id: string; repo: string | null; publish_result: string | null; pr_url: string | null; pr_state: 'open' | 'merged' | 'closed' | null; merged_at: string | null }[];
  repos: { repo: string; merged_24h: number | null; latest_release_tag: string | null }[];
}
const object = (v: unknown): v is Row => !!v && typeof v === 'object' && !Array.isArray(v);
const repoName = (s: string) => /^[\w.-]+(?:\/[\w.-]+)?$/.test(s) ? (s.includes('/') ? s : `ashlrai/${s}`) : null;
const urlPattern = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/([1-9]\d*)$/;
const date = (v: unknown) => typeof v === 'string' && Number.isFinite(Date.parse(v)) ? Date.parse(v) : NaN;
async function api(gh: CloudGh, args: string[]): Promise<unknown> {
  try { const result = await gh(args); return result.ok ? JSON.parse(result.stdout) as unknown : null; } catch { return null; }
}

/** Refresh the snapshot from local evidence and read-only GitHub queries. Null means unobserved. */
export async function writeLeaderFacts(root: string, gh: CloudGh = defaultCloudGh, now = Date.now()): Promise<LeaderFacts> {
  const read = async (path: string) => { try { return await readFile(join(root, path), 'utf8'); } catch { return null; } };
  const [queue, ledger] = await Promise.all([read('queue/router-queue.md'), read('metrics/jobs.jsonl')]);
  const candidates = new Map<string, string | null>();
  for (const line of (queue ?? '').split(/\r?\n/)) {
    if (!/(?:^|\s)src=leader(?=\s|[,;)]|$)/.test(line)) continue;
    const id = /^\s*-\s+\S+\s+(RQ-[\w-]+)/.exec(line)?.[1];
    const repo = /(?:^|[\s(,])repo=([\w./-]+)/.exec(line)?.[1];
    if (id) candidates.set(id, repo ? repoName(repo) : null);
  }
  const rows = new Map<string, Row[]>(); let damaged = false;
  for (const line of (ledger ?? '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row: unknown = JSON.parse(line);
      if (!object(row)) { damaged = true; continue; }
      const id = row.job ?? row.job_id ?? row.jobId;
      if (typeof id === 'string' && candidates.has(id) && Number.isFinite(date(row.ts ?? row.at ?? row.timestamp))) {
        const list = rows.get(id) ?? []; list.push(row); rows.set(id, list);
      }
    } catch { damaged = true; }
  }
  const jobs: LeaderFacts['jobs'] = [];
  for (const [id, repo] of candidates) {
    const events = (rows.get(id) ?? []).sort((a, b) => date(a.ts ?? a.at ?? a.timestamp) - date(b.ts ?? b.at ?? b.timestamp));
    if (events.length && !events.some(row => { const t = date(row.ts ?? row.at ?? row.timestamp); return t >= now - 48 * 3600000 && t <= now; })) continue;
    const publish = [...events].reverse().find(row => row.event === 'publish' && date(row.ts ?? row.at ?? row.timestamp) <= now);
    const rawUrl = publish?.url ?? publish?.pr_url ?? publish?.prUrl;
    const match = typeof rawUrl === 'string' ? urlPattern.exec(rawUrl) : null;
    const pr_url = match && (!repo || match[1] === repo) ? rawUrl as string : null;
    const result = publish?.result ?? publish?.outcome ?? publish?.state;
    const job: LeaderFacts['jobs'][number] = { id, repo, publish_result: typeof result === 'string' ? result : pr_url ? 'published' : null, pr_url, pr_state: null, merged_at: null };
    if (pr_url && match) {
      const pr = await api(gh, ['api', `repos/${match[1]}/pulls/${match[2]}`]);
      if (object(pr) && (pr.state === 'open' || pr.state === 'closed') && (pr.merged_at === null || Number.isFinite(date(pr.merged_at)))) {
        job.pr_state = pr.merged_at ? 'merged' : pr.state; job.merged_at = typeof pr.merged_at === 'string' ? pr.merged_at : null;
      }
    }
    jobs.push(job);
  }
  const repos: LeaderFacts['repos'] = [];
  for (const repo of [...new Set(jobs.map(j => j.repo).filter((r): r is string => r !== null))].sort()) {
    const start = new Date(now - 24 * 3600000).toISOString(), end = new Date(now).toISOString();
    const [search, release] = await Promise.all([
      api(gh, ['api', 'search/issues', '-X', 'GET', '-f', `q=repo:${repo} is:pr is:merged merged:${start}..${end}`, '-f', 'per_page=1']),
      api(gh, ['api', `repos/${repo}/releases/latest`]),
    ]);
    repos.push({ repo, merged_24h: object(search) && search.incomplete_results === false && Number.isSafeInteger(search.total_count) && (search.total_count as number) >= 0 ? search.total_count as number : null,
      latest_release_tag: object(release) && typeof release.tag_name === 'string' && release.tag_name ? release.tag_name : null });
  }
  const facts: LeaderFacts = { schema: 'leader.facts.v1', generated_at: new Date(now).toISOString(), sources: { queue: queue === null ? 'unknown' : 'ok', jobs: ledger === null ? 'unknown' : damaged ? 'partial' : 'ok' }, jobs, repos };
  const dir = join(root, 'leader'); await mkdir(dir, { recursive: true });
  const temp = join(dir, `.facts.${randomUUID()}.tmp`);
  try { await writeFile(temp, `${JSON.stringify(facts, null, 2)}\n`, { mode: 0o600, flag: 'wx' }); await rename(temp, join(dir, 'facts.json')); } finally { await unlink(temp).catch(() => {}); }
  return facts;
}
