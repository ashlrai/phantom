/** `phm publish resume|orphans`: finish a publish that pushed a fork branch but never opened a PR. */
import { parseArgs } from 'node:util';
import type { Gh } from '../core/autopilot/github.js';
import type { RetryOptions } from '../core/publish/retry.js';
import { listPublishOrphans, resumePublish, type PublishResumeResult } from '../core/publish/resume.js';

const usage = `Usage:
  phm publish resume --branch <codex-bridge/job | job> [--repo <name>] [--json]
  phm publish orphans [--repo <name>] [--json]`;

const say: Record<PublishResumeResult['status'], string> = {
  opened: 'Opened', 'already-open': 'Already open', 'already-merged': 'Already merged',
  'already-on-main': 'Already on the default branch, nothing to publish', missing: 'Branch is not on your fork', deferred: 'GitHub is unavailable, so nothing was opened. Your branch is safe on your fork',
};

export async function cmdPublish(args: string[], gh?: Gh, retry?: RetryOptions): Promise<number> {
  const verb = args[0];
  if (verb === undefined || verb === '--help' || verb === '-h' || verb === 'help') {
    console.log(`${usage}\nresume opens the PR for a pushed branch and turns on auto-merge through the merge queue.\norphans lists your fork's codex-bridge/ branches from the last 48 hours that have no PR.\nExit: 0 done, 1 branch missing or GitHub unavailable (a short outage is retried first; the branch is kept), 2 bad usage.`);
    return verb === undefined ? 2 : 0;
  }
  let values;
  try {
    ({ values } = parseArgs({ args: args.slice(1), strict: true, options: { branch: { type: 'string' }, repo: { type: 'string' }, json: { type: 'boolean' } } }));
    if (verb === 'resume' ? !values.branch : verb !== 'orphans' || values.branch) throw new Error('usage');
  } catch { console.error(usage); return 2; }
  const json = values.json === true;
  try {
    if (verb === 'resume') {
      const r = await resumePublish({ branch: values.branch!, repo: values.repo, retry }, gh);
      console.log(json ? JSON.stringify(r) : `${say[r.status]}${r.pr_url ? `: ${r.pr_url}` : ''}${r.auto_merge && !r.auto_merge.on ? `\nAuto-merge is off: ${r.auto_merge.detail}` : ''}${r.deferred ? `\nWhy: ${r.deferred.reason} (${r.deferred.attempts} tries).\nTry again later: ${r.deferred.retry}` : ''}`);
      return r.status === 'missing' || r.status === 'deferred' ? 1 : 0;
    }
    const r = await listPublishOrphans({ repo: values.repo, retry }, gh);
    console.log(json ? JSON.stringify(r) : r.orphans.map(o => `${o.branch}  ${o.age_hours}h old  → phm publish resume --branch ${o.branch}`).join('\n') || 'No orphan branches in the last 48 hours.');
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Publish check failed.';
    if (json) console.log(JSON.stringify({ schema: 'publish.error.v1', ok: false, error: message })); else console.error(message);
    return 1;
  }
}
