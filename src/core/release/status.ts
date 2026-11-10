import { execFile } from 'node:child_process';
import { AUTONOMY_REPOS } from './autonomy-audit.js';

export interface ReleaseStatusRow {
  repo: string;
  defaultBranch: string | null;
  latestTag: string | null;
  hasAssets: boolean | null;
  unreleasedCommits: number | null;
  updaterHttpStatus: number | null;
}
export interface ReleaseStatusReport { schema: 'phantom.release-status.v1'; repos: ReleaseStatusRow[] }
export interface ReleaseStatusDeps {
  read?: (endpoint: string) => Promise<unknown>;
  feed?: () => Promise<number>;
  repos?: readonly string[];
}
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const safe = async <T>(fn: () => Promise<T>): Promise<T | null> => { try { return await fn(); } catch { return null; } };

async function githubRead(endpoint: string): Promise<unknown> {
  const output = await new Promise<string>((resolve, reject) => execFile('gh', ['api', '--hostname', 'github.com', '--method', 'GET', endpoint], {
    encoding: 'utf8', timeout: 15000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' },
  }, (error, stdout) => error ? reject(new Error('GitHub read unavailable')) : resolve(stdout)));
  return JSON.parse(output) as unknown;
}

/** Remote observations only. Null means unavailable or unmeasured, never zero. */
export async function getReleaseStatus(deps: ReleaseStatusDeps = {}): Promise<ReleaseStatusReport> {
  const read = deps.read ?? githubRead;
  const feed = deps.feed ?? (async () => (await fetch('https://github.com/ashlrai/phantom/releases/latest/download/latest.json', { signal: AbortSignal.timeout(15000), redirect: 'follow' })).status);
  const repos = await Promise.all((deps.repos ?? AUTONOMY_REPOS).map(async (name): Promise<ReleaseStatusRow> => {
    const base = `repos/ashlrai/${name}`;
    const [info, tags, updaterHttpStatus] = await Promise.all([
      safe(() => read(base)), safe(() => read(`${base}/tags?per_page=1`)), name === 'phantom' ? safe(feed) : Promise.resolve(null),
    ]);
    const branchValue = object(info)['default_branch'];
    const defaultBranch = typeof branchValue === 'string' && branchValue ? branchValue : null;
    const tagValue = Array.isArray(tags) ? object(tags[0])['name'] : null;
    const latestTag = typeof tagValue === 'string' && tagValue ? tagValue : null;
    const [release, comparison] = await Promise.all([
      latestTag ? safe(() => read(`${base}/releases/tags/${encodeURIComponent(latestTag)}`)) : Promise.resolve(null),
      latestTag && defaultBranch ? safe(() => read(`${base}/compare/${encodeURIComponent(latestTag)}...${encodeURIComponent(defaultBranch)}`)) : Promise.resolve(null),
    ]);
    const assets = object(release)['assets'];
    const count = object(comparison)['ahead_by'];
    return { repo: `ashlrai/${name}`, defaultBranch, latestTag, hasAssets: Array.isArray(assets) ? assets.length > 0 : null,
      unreleasedCommits: typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 ? count : null, updaterHttpStatus };
  }));
  return { schema: 'phantom.release-status.v1', repos };
}

export function formatReleaseStatus(report: ReleaseStatusReport): string {
  const rows = report.repos.map((r) => [r.repo, r.latestTag ?? 'Unknown', r.hasAssets === null ? 'Unknown' : r.hasAssets ? 'Yes' : 'No', r.unreleasedCommits === null ? 'Unknown' : String(r.unreleasedCommits), r.repo === 'ashlrai/phantom' ? r.updaterHttpStatus === null ? 'Unknown' : String(r.updaterHttpStatus) : '—']);
  const headings = ['Repository', 'Latest tag', 'Has assets', 'Unreleased commits', 'Updater HTTP'];
  const widths = headings.map((heading, i) => Math.max(heading.length, ...rows.map((row) => row[i]!.length)));
  return [headings, ...rows].map((row) => row.map((cell, i) => cell.padEnd(widths[i]!)).join('  ').trimEnd()).join('\n');
}
