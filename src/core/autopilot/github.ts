/**
 * PR autopilot, the observing half: one pull request's state from GitHub's
 * REST API through `gh api` (no GraphQL, so it also works where only REST is
 * reachable). Read-only except `rerunJob`. Every call is bounded by a timeout
 * that kills the child; gh's stderr is reduced to one scrubbed line.
 */
import { execFile } from 'node:child_process';

import { scrubSecrets } from '../util/scrub.js';
import type { CheckRun, Observation, PrView, ReviewItem } from './diagnose.js';

export type Gh = (args: string[]) => Promise<string>;

const GH_TIMEOUT_MS = 60_000;
const LOG_TAIL_CHARS = 8_000;

export const defaultGh: Gh = (args) => new Promise((resolve, reject) => {
  execFile('gh', args, { timeout: GH_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: 32 * 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' } }, (err, stdout, stderr) => {
    if (err) {
      const line = String(stderr || err.message).split('\n').find((l) => l.trim()) ?? 'gh failed';
      reject(new Error(scrubSecrets(`gh ${args.slice(0, 2).join(' ')}: ${line}`).slice(0, 300)));
    } else resolve(stdout);
  });
});

const REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/;
export function assertRepo(repo: string): string {
  if (!REPO.test(repo)) throw new Error(`Invalid repository "${repo}"; expected owner/name.`);
  return repo;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? v as Json : {});
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

async function api(gh: Gh, path: string): Promise<unknown> {
  return JSON.parse(await gh(['api', '-H', 'Accept: application/vnd.github+json', path]));
}

export async function readViewer(gh: Gh = defaultGh): Promise<string> {
  const login = str(obj(await api(gh, 'user'))['login']);
  if (!login) throw new Error('Could not read the signed-in GitHub login.');
  return login;
}

export async function readPr(repo: string, number: number, gh: Gh = defaultGh): Promise<PrView> {
  const raw = obj(await api(gh, `repos/${assertRepo(repo)}/pulls/${number}`));
  const head = obj(raw['head']);
  const base = obj(raw['base']);
  return {
    repo,
    number,
    state: raw['state'] === 'open' ? 'open' : 'closed',
    merged: raw['merged'] === true,
    draft: raw['draft'] === true,
    author: str(obj(raw['user'])['login']),
    headRef: str(head['ref']),
    headSha: str(head['sha']),
    headRepo: str(obj(head['repo'])['full_name']),
    baseRef: str(base['ref']),
    baseSha: str(base['sha']),
    mergeable: typeof raw['mergeable'] === 'boolean' ? raw['mergeable'] : null,
    mergeableState: str(raw['mergeable_state']),
  };
}

export async function readChecks(repo: string, ref: string, gh: Gh = defaultGh): Promise<CheckRun[]> {
  const out: CheckRun[] = [];
  for (let page = 1; page <= 5; page++) {
    const raw = obj(await api(gh, `repos/${assertRepo(repo)}/commits/${encodeURIComponent(ref)}/check-runs?filter=all&per_page=100&page=${page}`));
    const runs = Array.isArray(raw['check_runs']) ? raw['check_runs'] : [];
    for (const r of runs.map(obj)) {
      out.push({
        id: Number(r['id']),
        name: str(r['name']).slice(0, 160),
        status: str(r['status']),
        conclusion: typeof r['conclusion'] === 'string' ? r['conclusion'] : null,
        app: str(obj(r['app'])['slug']) || null,
      });
    }
    if (runs.length < 100) break;
  }
  return out;
}

/**
 * The tail of an Actions job log, scrubbed. When the log itself cannot be
 * downloaded (expired, or the log store is unreachable) the check run's
 * annotations stand in. Empty when neither can be read.
 */
export async function readJobLogTail(repo: string, jobId: number, gh: Gh = defaultGh): Promise<string> {
  try {
    const text = await gh(['api', `repos/${assertRepo(repo)}/actions/jobs/${jobId}/logs`]);
    if (text.trim()) return scrubSecrets(text.slice(-LOG_TAIL_CHARS * 2)).slice(-LOG_TAIL_CHARS);
  } catch { /* fall through to annotations */ }
  try {
    const raw = await api(gh, `repos/${assertRepo(repo)}/check-runs/${jobId}/annotations?per_page=50`);
    const lines = (Array.isArray(raw) ? raw : []).map(obj)
      .filter((a) => a['annotation_level'] !== 'notice')
      .map((a) => `${str(a['path'])}:${String(a['start_line'] ?? '')} ${str(a['annotation_level'])}: ${str(a['message'])}`);
    return scrubSecrets(lines.join('\n')).slice(-LOG_TAIL_CHARS);
  } catch {
    return '';
  }
}

/**
 * Only people with write access steer the fixer. The repository is public: a
 * comment from anyone else is text an attacker chose, and the fixer acts on it.
 */
export const TRUSTED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

/**
 * Review feedback from trusted people other than the viewer: review comments
 * on the current head, and change requests on it. Comments on older heads are
 * outdated (the code they point at moved) and are left for a person. Feedback
 * from untrusted authors is counted in `dropped`, never handed to the fixer.
 */
export async function readReviews(repo: string, pr: PrView, viewer: string, gh: Gh = defaultGh): Promise<{ items: ReviewItem[]; dropped: string[] }> {
  const items: ReviewItem[] = [];
  const dropped: string[] = [];
  const others = (login: string, association: unknown, id: unknown) => {
    if (!login || login.toLowerCase() === viewer.toLowerCase()) return false;
    if (TRUSTED_ASSOCIATIONS.has(str(association))) return true;
    dropped.push(`review item ${String(id)} by ${login} (${str(association) || 'no association'}) ignored: not a repository member or collaborator`);
    return false;
  };
  const comments = await api(gh, `repos/${assertRepo(repo)}/pulls/${pr.number}/comments?per_page=100`);
  for (const c of (Array.isArray(comments) ? comments : []).map(obj)) {
    const author = str(obj(c['user'])['login']);
    if (str(c['commit_id']) !== pr.headSha || c['in_reply_to_id'] || !others(author, c['author_association'], c['id'])) continue;
    items.push({ id: Number(c['id']), kind: 'comment', author, body: scrubSecrets(str(c['body'])).slice(0, 4000), path: str(c['path']) || null, line: typeof c['line'] === 'number' ? c['line'] : null, createdAt: str(c['created_at']) });
  }
  const reviews = await api(gh, `repos/${assertRepo(repo)}/pulls/${pr.number}/reviews?per_page=100`);
  for (const r of (Array.isArray(reviews) ? reviews : []).map(obj)) {
    const author = str(obj(r['user'])['login']);
    if (r['state'] !== 'CHANGES_REQUESTED' || str(r['commit_id']) !== pr.headSha || !others(author, r['author_association'], r['id'])) continue;
    items.push({ id: Number(r['id']), kind: 'changes-requested', author, body: scrubSecrets(str(r['body'])).slice(0, 4000), path: null, line: null, createdAt: str(r['submitted_at']) });
  }
  return { items: items.sort((a, b) => a.createdAt.localeCompare(b.createdAt)), dropped };
}

/** Newest completed conclusion per job name across the latest completed run of each workflow on `branch`. */
export async function readBaseHistory(repo: string, branch: string, gh: Gh = defaultGh): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  try {
    const raw = obj(await api(gh, `repos/${assertRepo(repo)}/actions/runs?branch=${encodeURIComponent(branch)}&status=completed&per_page=40`));
    const runs = (Array.isArray(raw['workflow_runs']) ? raw['workflow_runs'] : []).map(obj);
    const newestPerWorkflow = new Map<number, number>();
    for (const r of runs) {
      const wf = Number(r['workflow_id']);
      if (!newestPerWorkflow.has(wf)) newestPerWorkflow.set(wf, Number(r['id']));
    }
    for (const runId of [...newestPerWorkflow.values()].slice(0, 8)) {
      const jobs = obj(await api(gh, `repos/${assertRepo(repo)}/actions/runs/${runId}/jobs?per_page=100`));
      for (const j of (Array.isArray(jobs['jobs']) ? jobs['jobs'] : []).map(obj)) {
        const name = str(j['name']);
        if (name && !(name in out) && typeof j['conclusion'] === 'string') out[name] = j['conclusion'];
      }
    }
  } catch { /* history is a hint; without it failures are judged on the base head alone */ }
  return out;
}

export async function readPrFiles(repo: string, number: number, gh: Gh = defaultGh): Promise<string[]> {
  const files: string[] = [];
  try {
    for (let page = 1; page <= 10; page++) {
      const raw = await api(gh, `repos/${assertRepo(repo)}/pulls/${number}/files?per_page=100&page=${page}`);
      const list = (Array.isArray(raw) ? raw : []).map(obj);
      files.push(...list.map((f) => str(f['filename'])).filter(Boolean));
      if (list.length < 100) break;
    }
  } catch { return []; }
  return files;
}

export async function observe(repo: string, number: number, gh: Gh = defaultGh): Promise<Observation> {
  const [viewer, pr] = await Promise.all([readViewer(gh), readPr(repo, number, gh)]);
  const [headChecks, baseChecks, { items: reviews, dropped }, files] = await Promise.all([
    readChecks(repo, pr.headSha, gh),
    pr.baseSha ? readChecks(repo, pr.baseSha, gh) : Promise.resolve([]),
    readReviews(repo, pr, viewer, gh),
    readPrFiles(repo, number, gh),
  ]);
  const latest = new Map<string, CheckRun>();
  for (const c of headChecks) if (!latest.has(c.name) || c.id > latest.get(c.name)!.id) latest.set(c.name, c);
  const failing = [...latest.values()].filter((c) => c.status === 'completed' && c.conclusion !== null && !['success', 'neutral', 'skipped'].includes(c.conclusion) && c.app === 'github-actions');
  const logs: Record<number, string> = {};
  for (const c of failing.slice(0, 6)) logs[c.id] = await readJobLogTail(repo, c.id, gh);
  const baseHistory = failing.length ? await readBaseHistory(repo, pr.baseRef, gh) : {};
  return { pr, viewer, headChecks, baseChecks, baseHistory, files, logs, reviews, droppedReviews: dropped };
}

/** Open PRs in `repo` authored by `viewer` from branches in the same repository whose name starts with one of `prefixes`. */
export async function listOwnedPrs(repo: string, viewer: string, prefixes: readonly string[], gh: Gh = defaultGh): Promise<number[]> {
  const out: number[] = [];
  for (let page = 1; page <= 5; page++) {
    const raw = await api(gh, `repos/${assertRepo(repo)}/pulls?state=open&per_page=100&page=${page}`);
    const list = (Array.isArray(raw) ? raw : []).map(obj);
    for (const p of list) {
      const head = obj(p['head']);
      const ref = str(head['ref']);
      if (str(obj(p['user'])['login']).toLowerCase() !== viewer.toLowerCase()) continue;
      if (str(obj(head['repo'])['full_name']).toLowerCase() !== repo.toLowerCase()) continue;
      if (!prefixes.some((x) => x && ref.startsWith(x))) continue;
      out.push(Number(p['number']));
    }
    if (list.length < 100) break;
  }
  return out.sort((a, b) => a - b);
}

/** Re-run one Actions job (its check-run id is the job id). */
export async function rerunJob(repo: string, jobId: number, gh: Gh = defaultGh): Promise<void> {
  await gh(['api', '-X', 'POST', `repos/${assertRepo(repo)}/actions/jobs/${jobId}/rerun`]);
}
