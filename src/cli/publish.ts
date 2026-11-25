/** `phm publish resume|orphans|sweep`: finish a publish that pushed a fork branch but never opened a PR. */
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { Gh } from '../core/autopilot/github.js';
import type { RetryOptions } from '../core/publish/retry.js';
import { listPublishOrphans, resumePublish, type PublishResumeResult } from '../core/publish/resume.js';
import { sweepPublishResumes, type PublishResumeSweepReport } from '../core/fleet/publish-resume-sweep.js';

const usage = `Usage:
  phm publish resume --branch <codex-bridge/job | job> [--repo <name>] [--json]
  phm publish orphans [--repo <name>] [--json]
  phm publish sweep [--runs-dir <dir>] [--apply] [--limit <n>] [--json]`;

const say: Record<PublishResumeResult['status'], string> = {
  opened: 'Opened', 'already-open': 'Already open', 'already-merged': 'Already merged',
  'already-on-main': 'Already on the default branch, nothing to publish', missing: 'Branch is not on your fork', deferred: 'GitHub is unavailable, so nothing was opened. Your branch is safe on your fork',
};

function sweepLines(r: PublishResumeSweepReport): string {
  const lines = [
    r.reason ?? `${r.apply ? 'publish sweep' : 'publish sweep (dry run — pass --apply to open PRs)'}: ${r.candidates} stranded, ${r.resumed.length + r.planned.length} attempted of limit ${r.limit}`,
    ...r.planned.map((o) => `  plan   ${o.job}  ${o.repo}  ${o.branch}`),
    ...r.resumed.map((o) => `  ${o.status.padEnd(7)} ${o.job}  ${o.pr_url ?? o.error ?? ''}`.trimEnd()),
    ...r.deferred.map((d) => `  defer  ${d.job}  ${d.why}`),
    ...r.skipped.map((s) => `  skip   ${s.job}  ${s.why}`),
    ...(r.unreadable.length ? [`  unreadable: ${r.unreadable.join(', ')}`] : []),
  ];
  return lines.join('\n');
}

export async function cmdPublish(args: string[], gh?: Gh, retry?: RetryOptions): Promise<number> {
  const verb = args[0];
  if (verb === undefined || verb === '--help' || verb === '-h' || verb === 'help') {
    console.log(`${usage}\nresume opens the PR for a pushed branch and turns on auto-merge through the merge queue.\norphans lists your fork's codex-bridge/ branches from the last 48 hours that have no PR.\nsweep finishes publishes that pushed a branch but aborted before the PR existed: it opens the PR without arming auto-merge (the merge queue decides), at most --limit per run, oldest first. The fleet self-tick runs it every pass.\nExit: 0 done, 1 branch missing, GitHub unavailable or unreadable logs (a short outage is retried first; branches are kept), 2 bad usage.`);
    return verb === undefined ? 2 : 0;
  }
  if (verb === 'sweep') {
    let values;
    try {
      ({ values } = parseArgs({
        args: args.slice(1), strict: true,
        options: { 'runs-dir': { type: 'string' }, apply: { type: 'boolean' }, limit: { type: 'string' }, json: { type: 'boolean' } },
      }));
    } catch { console.error(usage); return 2; }
    const json = values.json === true;
    const limit = values.limit === undefined ? undefined : Number(values.limit);
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) { console.error(usage); return 2; }
    try {
      const runsDir = resolve(values['runs-dir'] ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs'));
      const r = await sweepPublishResumes({ runsDir, apply: values.apply === true, limit, gh, retry });
      console.log(json ? JSON.stringify(r) : sweepLines(r));
      return r.status === 'unknown' ? 1 : 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Publish sweep failed.';
      if (json) console.log(JSON.stringify({ schema: 'publish.error.v1', ok: false, error: message })); else console.error(message);
      return 1;
    }
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
