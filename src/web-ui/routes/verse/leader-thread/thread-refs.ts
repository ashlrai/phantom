import { JOB_ID_RE } from '../fleet-job-log/worker-log-model.js';
import { pullUrl } from '../fleet/job-refs.js';

/** Collect the references that JobRefs can open, with jobs before pull requests. */
export function mentionedRefs(text: string): string[] {
  const jobs = new Set<string>();
  const prs = new Set<string>();
  const tokens = /(?<![A-Za-z0-9_./-])(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#\d+(?![A-Za-z0-9_]|\.\d)|(?:RQ|LAND|FIX)-[A-Za-z0-9._-]+)|(?<![A-Za-z0-9_#./-])#\d+(?![A-Za-z0-9_]|\.\d)/g;
  for (const match of text.matchAll(tokens)) {
    const token = match[0];
    const hash = token.indexOf('#');
    if (hash >= 0) {
      const repo = hash ? token.slice(0, hash) : 'ashlrai/phantom';
      if (pullUrl(repo, Number(token.slice(hash + 1)))) prs.add(token);
    } else {
      const job = token.replace(/\.+$/, '');
      if (JOB_ID_RE.test(job)) jobs.add(job);
    }
  }
  return [...jobs, ...prs].slice(0, 8);
}
