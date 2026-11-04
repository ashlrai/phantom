import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathJobHistory } from '../core/fleet/path-job-history.js';

const exec = promisify(execFile);
const usage = 'Usage: ashlr fleet path-history <path> [--ref origin/master] [--limit N] [--json]';

export async function cmdFleetPathHistory(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return 0; }
  let path: string | undefined;
  let ref = 'origin/master', limit = 20, json = false;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json' && !seen.has(arg)) json = true;
    else if ((arg === '--ref' || arg === '--limit') && !seen.has(arg)) {
      const value = args[++i];
      if (!value || value.startsWith('-')) { console.error(usage); return 2; }
      if (arg === '--ref') ref = value;
      else {
        limit = Number(value);
        if (!/^\d+$/.test(value) || !Number.isSafeInteger(limit * 3) || limit < 1) { console.error(usage); return 2; }
      }
    } else if (!arg.startsWith('-') && path === undefined) path = arg;
    else { console.error(usage); return 2; }
    seen.add(arg);
  }
  if (!path) { console.error(usage); return 2; }
  try {
    const rows = await pathJobHistory(path, { log: async (file, count) => {
      const { stdout } = await exec('git', ['log', `-n${count * 3}`, '--format=%h%x09%cI%x09%s', ref, '--', file],
        { encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
      return stdout.split('\n').filter(Boolean).map(line => {
        const [sha = '', date = '', ...subject] = line.split('\t');
        return { sha, date, subject: subject.join('\t') };
      });
    } }, { limit });
    if (json) console.log(JSON.stringify(rows));
    else if (!rows.length) console.log(`no fleet jobs touched ${path}`);
    else for (const row of rows) console.log(`${row.pr === null ? '#?' : `#${row.pr}`} ${row.jobId} ${row.date} ${row.title}`);
    return 0;
  } catch { console.error('error: unable to read path history from git'); return 1; }
}
