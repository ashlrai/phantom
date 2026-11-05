import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { validJobRef } from '../core/fleet/job-path-history.js';
import { pathJobHistory } from '../core/fleet/path-job-history.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const exec = promisify(execFile);
const warning = 'Bounded history is evidence, not proof of completeness or semantic duplication.';
const usage = `Usage: ashlr fleet job-impact <path>... [--ref origin/master] [--limit N] [--json]\n1–20 distinct repo-relative file paths; limit 1–20 per path (default 20). ${warning}`;
type Dependencies = { git?: (args: string[]) => Promise<string>; output?: (text: string) => void; error?: (text: string) => void };
const git = async (args: string[]) => (await exec('git', args, { encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024 })).stdout;

function validPath(path: string): boolean {
  return !!path && ![...path].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 || c === '\\') && !path.startsWith('/') && !/^[A-Za-z]:/.test(path)
    && path.split('/').every(part => !!part && part !== '.' && part !== '..');
}

export async function cmdFleetJobImpact(args: string[], deps: Dependencies = {}): Promise<number> {
  const output = deps.output ?? console.log, error = deps.error ?? console.error;
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) { output(usage); return 0; }
  const paths: string[] = [], flags = new Set<string>();
  let ref = 'origin/master', limit = 20, json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith('-')) {
      if (flags.has(arg)) { error(usage); return 2; }
      flags.add(arg);
      if (arg === '--json') json = true;
      else if (arg === '--ref' || arg === '--limit') {
        const value = args[++i];
        if (!value || value.startsWith('-')) { error(usage); return 2; }
        if (arg === '--ref') ref = value;
        else if (/^\d+$/.test(value)) limit = Number(value);
        else { error(usage); return 2; }
      } else { error(usage); return 2; }
    } else paths.push(arg);
  }
  const unique = [...new Set(paths)];
  if (!unique.length || unique.length > 20 || paths.some(path => !validPath(path)) || !validJobRef(ref)
    || !Number.isSafeInteger(limit) || limit < 1 || limit > 20) { error(usage); return 2; }
  const run = deps.git ?? git;
  try {
    const resolvedRef = (await run(['rev-parse', '--verify', `${ref}^{commit}`])).trim();
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(resolvedRef)) throw new Error('invalid commit');
    const results: Array<{ path: string; rows: Awaited<ReturnType<typeof pathJobHistory>> }> = [];
    const jobs = new Set<string>();
    for (const path of unique) {
      const rows = await pathJobHistory(path, { log: async (file, count) => {
        const text = await run(['--literal-pathspecs', 'log', `-n${count * 3}`, '--format=%H%x09%cI%x09%s', resolvedRef, '--', file]);
        return text.split('\n').filter(Boolean).map(line => {
          const [sha = '', date = '', ...subject] = line.split('\t');
          return { sha, date, subject: subject.join('\t') };
        });
      } }, { limit });
      results.push({ path, rows });
      for (const row of rows) jobs.add(row.jobId);
    }
    const safe = sanitizePublicJson({ schema: 'fleet-job-impact.v1', ref, resolvedRef, limit, scanBoundPerPath: limit * 3, warning, results, jobIds: [...jobs] }) as {
      resolvedRef: string; warning: string; results: typeof results; jobIds: string[]; scanBoundPerPath: number;
    };
    if (json) output(JSON.stringify(safe));
    else {
      output(`${safe.warning} Scanned up to ${safe.scanBoundPerPath} commits per path at ${safe.resolvedRef}.`);
      for (const result of safe.results) {
        output(`${result.path}:`);
        if (!result.rows.length) output('  No matching jobs found in this bounded history.');
        for (const row of result.rows) output(`  ${row.jobId} ${row.sha} ${row.date} ${row.title}`);
      }
      output(`Job IDs: ${safe.jobIds.join(', ') || '(none)'}`);
    }
    return 0;
  } catch { error('error: unable to read fleet job impact from git'); return 1; }
}
