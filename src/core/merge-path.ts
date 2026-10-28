/** Read-only evidence for required checks on recent pull request heads. */
import { execFile } from 'node:child_process';

export type MergePathResult = {
  repo: string;
  branch: string;
  signal: 'MERGE_PATH_BROKEN' | 'MERGE_PATH_OK' | 'MERGE_PATH_UNKNOWN';
  missingContexts: string[];
  requiredContexts: string[];
  observedContexts: string[];
  headsExamined: number;
};

type Read = (path: string) => Promise<unknown>;
type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid GitHub response');
  return value as ObjectValue;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('Invalid GitHub response');
  return value;
}
function name(value: unknown): string {
  if (typeof value !== 'string' || !value) throw new Error('Invalid GitHub response');
  return value;
}

class GitHubReadError extends Error {
  constructor(path: string, readonly notFound: boolean) { super(`GitHub read failed: ${path.split('?')[0]}`); }
}

/** Only GET requests are possible: no arbitrary gh arguments, input, or method flags. */
export function readGitHub(path: string): Promise<unknown> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._~/?=&%-]*$/u.test(path)) throw new Error('Invalid GitHub API path');
  return new Promise((resolve, reject) => {
    execFile('gh', ['api', path], { encoding: 'utf8', timeout: 15_000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' } }, (error, stdout, stderr) => {
      if (error) return reject(new GitHubReadError(path, /HTTP 404\b/u.test(stderr))); 
      try { resolve(JSON.parse(stdout) as unknown); } catch { reject(new Error('Invalid GitHub response')); }
    });
  });
}

async function pages(read: Read, path: string, key?: string): Promise<unknown[]> {
  const result: unknown[] = [];
  for (let page = 1; page <= 100; page++) {
    const value = await read(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    const rows = array(key ? object(value)[key] : value);
    result.push(...rows);
    if (rows.length < 100) return result;
  }
  throw new Error('GitHub pagination limit reached');
}

export async function probeMergePath(repo: string, requestedBranch?: string, read: Read = readGitHub): Promise<MergePathResult> {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repo)) throw new Error('Repo must be owner/name');
  const branch = requestedBranch || name(object(await read(`repos/${repo}`)).default_branch);
  const encoded = encodeURIComponent(branch);
  const base = `repos/${repo}`;
  const branchInfo = object(await read(`${base}/branches/${encoded}`));
  if (typeof branchInfo.protected !== 'boolean') throw new Error('Invalid GitHub branch response');
  const required = new Set<string>();
  if (branchInfo.protected) {
    let protection: ObjectValue | undefined;
    try { protection = object(await read(`${base}/branches/${encoded}/protection`)); }
    catch (error) { if (!(error instanceof GitHubReadError && error.notFound)) throw error; }
    if (protection?.required_status_checks != null) {
      const checks = object(protection.required_status_checks);
      for (const context of array(checks.contexts)) required.add(name(context));
      if (checks.checks !== undefined) for (const check of array(checks.checks)) required.add(name(object(check).context));
    }
  }
  // GitHub resolves branch matching and inherited, active rulesets at this endpoint.
  for (const rule of await pages(read, `${base}/rules/branches/${encoded}`)) {
    const item = object(rule);
    if (item.type !== 'required_status_checks') continue;
    for (const check of array(object(item.parameters).required_status_checks)) required.add(name(object(check).context));
  }
  const prs = array(await read(`${base}/pulls?state=all&base=${encoded}&sort=updated&direction=desc&per_page=20`));
  const heads = [...new Set(prs.map(pr => name(object(object(pr).head).sha)))];
  const observed = new Set<string>();
  for (const sha of heads) {
    const commit = encodeURIComponent(sha);
    for (const check of await pages(read, `${base}/commits/${commit}/check-runs`, 'check_runs')) observed.add(name(object(check).name));
    for (const status of await pages(read, `${base}/commits/${commit}/statuses`)) observed.add(name(object(status).context));
  }
  const missingContexts = [...required].filter(context => !observed.has(context)).sort();
  return {
    repo, branch,
    signal: heads.length === 0 && required.size > 0 ? 'MERGE_PATH_UNKNOWN' : missingContexts.length ? 'MERGE_PATH_BROKEN' : 'MERGE_PATH_OK',
    missingContexts: heads.length ? missingContexts : [],
    requiredContexts: [...required].sort(), observedContexts: [...observed].sort(), headsExamined: heads.length,
  };
}
