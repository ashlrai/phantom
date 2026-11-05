import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { jobPathHistory, JOB_LIMIT_MAX, validJobId, validJobRef } from '../core/fleet/job-path-history.js';
import { sanitizePublicJson } from '../core/util/public-json.js';
import { BULK_COMMIT_MIN_FILES } from '../core/fleet/bulk-commit.js';
import { pathJobHistory } from '../core/fleet/path-job-history.js';

const exec = promisify(execFile);
const usage = 'Usage: ashlr fleet path-history (<path> | --job RQ-ID) [--ref origin/master] [--limit N] [--json]\nJob mode scans at most 1000 commits; --limit is 1–100 matching commits (default 20).';

export async function cmdFleetPathHistory(args: string[], deps: { log?: Parameters<typeof pathJobHistory>[1]['log'] } = {}): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return 0; }
  let path: string | undefined, job: string | undefined;
  let ref = 'origin/master', limit = 20, json = false;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json' && !seen.has(arg)) json = true;
    else if ((arg === '--ref' || arg === '--limit' || arg === '--job') && !seen.has(arg)) {
      const value = args[++i];
      if (!value || value.startsWith('-')) { console.error(usage); return 2; }
      if (arg === '--ref') ref = value;
      else if (arg === '--job') job = value;
      else {
        limit = Number(value);
        if (!/^\d+$/.test(value) || !Number.isSafeInteger(limit * 3) || limit < 1) { console.error(usage); return 2; }
      }
    } else if (!arg.startsWith('-') && path === undefined) path = arg;
    else { console.error(usage); return 2; }
    seen.add(arg);
  }
  if ((!path && !job) || (path && job) || (job && (!validJobId(job) || !validJobRef(ref) || limit > JOB_LIMIT_MAX))) { console.error(usage); return 2; }
  try {
    if (job) {
      const result = await jobPathHistory(job, ref, limit);
      const safe = sanitizePublicJson(result) as typeof result;
      if (json) console.log(JSON.stringify(safe));
      else {
        console.log(`Scanned ${safe.scanned} commits (bound ${safe.scanBound}; ${safe.scanMayBeTruncated ? 'older history may remain' : 'history exhausted'}).${safe.matchesTruncated ? ' Matching commits exceed the result limit.' : ''}`);
        for (const commit of safe.commits) console.log(`${commit.sha} ${commit.date} ${commit.pr === null ? '#?' : `#${commit.pr}`}`);
        if (!safe.paths.length) console.log('No paths found in this bounded scan; this does not prove the job never landed.');
        else for (const path of safe.paths) console.log(path);
      }
      return 0;
    }
    let skipped = 0;
    const rows = await pathJobHistory(path!, { log: deps.log ?? (async (file, count) => {
      const { stdout } = await exec('git', ['log', `-n${count * 3}`, '--format=%h%x09%cI%x09%s', ref, '--', file],
        { encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
      return Promise.all(stdout.split('\n').filter(Boolean).map(async line => {
        const [sha = '', date = '', ...subject] = line.split('\t');
        let filesChanged: number | null = null;
        try {
          const { stdout: names } = await exec('git', ['show', '--format=', '--name-only', '-z', sha],
            { encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
          filesChanged = names.split('\0').filter(Boolean).length;
        } catch { /* Unknown counts preserve existing behavior. */ }
        return { sha, date, subject: subject.join('\t'), filesChanged };
      }));
    }) }, { limit, onBulkCommit: () => { skipped += 1; } });
    if (json) console.log(JSON.stringify(rows));
    else if (!rows.length && !skipped) console.log(`no fleet jobs touched ${path}`);
    else for (const row of rows) console.log(`${row.pr === null ? '#?' : `#${row.pr}`} ${row.jobId} ${row.date} ${row.title}`);
    if (!json && skipped) console.log(`skipped ${skipped} bulk commit${skipped === 1 ? '' : 's'} (>=${BULK_COMMIT_MIN_FILES} files) that cannot attribute this path`);
    return 0;
  } catch { console.error('error: unable to read path history from git'); return 1; }
}
