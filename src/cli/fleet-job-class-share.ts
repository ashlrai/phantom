/** Offline accounting only; never changes dispatch or merge authority. */
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { jobClassShare } from '../core/fleet/job-class-share.js';

const usage = 'Usage: ashlr fleet job-class-share [--root <dir>] [--hours <1..168>] [--json]';

/** An absent metrics file is an empty report; other read failures still propagate. */
export async function readJobClassShareJobs(root: string): Promise<string> {
  let file;
  try {
    file = await open(join(root, 'metrics/jobs.jsonl'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(String((error as NodeJS.ErrnoException)?.code))) return '';
    throw error;
  }
  try {
    const limit = 32 * 1024 * 1024;
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > limit) throw new Error('Unavailable metrics');
    const buffer = Buffer.alloc(limit + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > limit) throw new Error('Unavailable metrics');
    return buffer.subarray(0, offset).toString('utf8');
  } finally { await file.close(); }
}

const percent = (value: number | null): string => value === null ? '-' : value.toFixed(1);

export async function cmdFleetJobClassShare(args: string[], readJobs = readJobClassShareJobs, now = Date.now()): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log(`${usage}\nShare of each lane's finished-job tokens by class in the trailing window: author (auto-authored filler), drain and real. Reads <root>/metrics/jobs.jsonl (default ~/.ashlr-runs); a missing file reports empty totals.`);
    return 0;
  }
  let root = join(homedir(), '.ashlr-runs');
  let hours = 6;
  let json = false;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (seen.has(arg) || !['--json', '--hours', '--root'].includes(arg)) {
      console.error(`error: invalid fleet job-class-share arguments\n${usage}`);
      return 2;
    }
    seen.add(arg);
    if (arg === '--json') json = true;
    else if (arg === '--hours') {
      const value = args[++i];
      if (!value || !/^\d+(?:\.\d+)?$/.test(value)) { console.error(`error: --hours needs a number\n${usage}`); return 2; }
      hours = Number(value);
      if (!Number.isFinite(hours) || hours < 1 || hours > 168) { console.error(`error: --hours must be within 1..168\n${usage}`); return 2; }
    } else {
      const value = args[++i];
      if (!value || value.startsWith('-')) { console.error(`error: --root needs a directory\n${usage}`); return 2; }
      root = value;
    }
  }
  let report;
  try {
    report = jobClassShare(await readJobs(root), hours, now);
  } catch {
    console.error('fleet job-class-share: metrics unavailable');
    return 1;
  }
  console.log(json ? JSON.stringify(report) : [
    'lane jobs tokens author_pct drain_pct real_pct',
    ...report.rows.map(row => `${row.lane} ${row.jobs} ${row.tokens} ${percent(row.author_pct)} ${percent(row.drain_pct)} ${percent(row.real_pct)}`),
    `Malformed rows: ${report.malformed}`,
  ].join('\n'));
  return 0;
}
