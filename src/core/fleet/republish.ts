import { constants } from 'node:fs';
import { open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

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
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.publish$/.test(name) || name.includes('..')) continue;
    const job = name.slice(0, -8), branch = `codex-bridge/${job}`;
    const row: RepublishJob = { job, status: 'unknown', reason: 'Publish log is unreadable or too large.', head: null, sha: null, readyLine: null, pr_state: 'unknown' };
    jobs.push(row);
    try {
      const file = await open(join(runsDir, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      let log: string;
      try {
        if (!(await file.stat()).isFile()) throw new Error('Not a file');
        const buffer = Buffer.alloc(2 * 1024 * 1024 + 1);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        if (bytesRead === buffer.length) throw new Error('Log too large');
        log = buffer.subarray(0, bytesRead).toString('utf8');
      } finally { await file.close(); }
      const lines = log.split(/\r?\n/);
      const pushed = lines.reduce((last, line, index) => line.trim().replace(/^remote:\s*/, '').startsWith(`Create a pull request for '${branch}'`) ? index : last, -1);
      const result = lines.reduce((last, line, index) => /^(?:RESULT\s|ABORT\b)/.test(line) ? index : last, -1);
      if (pushed < 0 || result <= pushed || !/^(?:RESULT )?ABORT(?:\s|$)/.test(lines[result]!)) {
        row.status = 'skip'; row.reason = 'No abort after a confirmed push.'; continue;
      }
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
      row.reason = /^(?:RESULT )?ABORT default-fetch$/.test(lines[result]!)
        ? 'Publish aborted after push because the default branch fetch failed.' : 'Publish aborted after push.';
      row.readyLine = `- READY RQ-REPUBLISH-${job} (P1, pool=any, tier=frontier, repo=${link[2]}): Cherry-pick ${row.sha} from ${fork} branch ${branch} onto fresh master. Reason: ${row.reason} Acceptance: recheck the branch and PR head, resolve conflicts, and run affected tests through the normal review and publish path.`;
    } catch { /* Keep the specific unknown reason; never echo logs or transport errors. */ }
  }
  return { schema: 'fleet.republish.v1', readOnly: true, status: jobs.some(row => row.status === 'unknown') ? 'unknown' : 'ok', jobs };
}
