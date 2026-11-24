import { readdir } from 'node:fs/promises';
import { z } from 'zod';
import { findPublishAbort, PUBLISH_LOG_NAME, readPublishLogLines } from './publish-log.js';

export interface RepublishJob {
  job: string;
  status: 'ready' | 'skip' | 'unknown';
  reason: string;
  head: string | null;
  sha: string | null;
  readyLine: string | null;
  /** PR lookup result; `unknown` whenever the lookup was skipped, failed or was incomplete. */
  pr_state: RepublishPrState;
}
export type RepublishPrState = 'none' | 'open' | 'merged' | 'closed' | 'unknown';
export interface RepublishReport {
  schema: 'fleet.republish.v1';
  readOnly: true;
  status: 'ok' | 'unknown';
  jobs: RepublishJob[];
}
const refs = z.array(z.object({ ref: z.string(), object: z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/) }) }));
const pulls = z.array(z.object({ state: z.enum(['open', 'closed']), merged_at: z.string().nullable(),
  head: z.object({ label: z.string() }) }));
const repos = new Set(['phantom', 'phantom-secrets', 'ashlr-plugin', 'locus', 'lexicon', 'ashlr-md', 'ashlr-stack']);

/** Public GETs only; unavailable evidence never means a missing branch or PR. */
export async function readFleetRepublish(runsDir: string, fetcher: typeof fetch = fetch): Promise<RepublishReport> {
  const jobs: RepublishJob[] = [];
  const get = async (path: string) => {
    const response = await fetcher(`https://api.github.com/repos/${path}`, { method: 'GET', redirect: 'error',
      headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error('GitHub unavailable');
    return { data: await response.json() as unknown, more: /rel="next"/.test(response.headers.get('link') ?? '') };
  };
  for (const name of (await readdir(runsDir)).sort()) {
    if (!PUBLISH_LOG_NAME.test(name) || name.includes('..')) continue;
    const job = name.slice(0, -8), branch = `codex-bridge/${job}`;
    const row: RepublishJob = { job, status: 'unknown', reason: 'Publish log is unreadable or too large.', head: null, sha: null, readyLine: null, pr_state: 'unknown' };
    jobs.push(row);
    try {
      const lines = await readPublishLogLines(runsDir, name);
      const abort = findPublishAbort(lines, branch), pushed = abort?.pushed ?? -1;
      if (!abort) { row.status = 'skip'; row.reason = 'No abort after a confirmed push.'; continue; }
      row.reason = 'Fork identity is unknown; the push link is missing or unsupported.';
      const link = lines.slice(pushed + 1, pushed + 4).join('\n').match(/https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\/pull\/new\/codex-bridge\/([A-Za-z0-9._-]+)(?=\s|$)/);
      if (!link || link[3] !== job || !repos.has(link[2]!)) continue;
      const fork = `${link[1]}/${link[2]}`, repo = `ashlrai/${link[2]}`;
      row.head = `${link[1]}:${branch}`;
      row.reason = 'Branch evidence is unknown; GitHub could not confirm the fork branch.';
      const found = refs.parse((await get(`${fork}/git/matching-refs/heads/${branch}`)).data)
        .find(ref => ref.ref === `refs/heads/${branch}`);
      if (!found) { row.status = 'skip'; row.reason = 'Fork branch is gone.'; continue; }
      row.sha = found.object.sha;
      row.reason = 'PR evidence is unknown; GitHub could not confirm a complete PR list.';
      // A failed or malformed PR lookup degrades to pr_state "unknown" for this job only.
      const response = await get(`${repo}/pulls?state=all&head=${encodeURIComponent(row.head)}&per_page=100`).catch(() => null);
      const parsed = pulls.safeParse(response?.data);
      if (!response || !parsed.success || parsed.data.some(pr => pr.head.label !== row.head)) continue;
      const prs = parsed.data;
      if (prs.some(pr => pr.state === 'open' || pr.merged_at !== null)) {
        row.pr_state = prs.some(pr => pr.state === 'open') ? 'open' : 'merged';
        row.status = 'skip'; row.reason = 'An open or merged PR already has this head.'; continue;
      }
      if (response.more) continue;
      row.pr_state = prs.length ? 'closed' : 'none';
      row.status = 'ready';
      row.reason = abort.reason === 'default-fetch'
        ? 'Publish aborted after push because the default branch fetch failed.' : 'Publish aborted after push.';
      row.readyLine = `- READY RQ-REPUBLISH-${job} (P1, pool=any, tier=frontier, repo=${link[2]}): Cherry-pick ${row.sha} from ${fork} branch ${branch} onto fresh master. Reason: ${row.reason} Acceptance: recheck the branch and PR head, resolve conflicts, and run affected tests through the normal review and publish path.`;
    } catch { /* Keep the specific unknown reason; never echo logs or transport errors. */ }
  }
  return { schema: 'fleet.republish.v1', readOnly: true, status: jobs.some(row => row.status === 'unknown') ? 'unknown' : 'ok', jobs };
}
