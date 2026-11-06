/** Offline accounting only; never changes dispatch or merge authority. */
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { laneClassShare } from '../core/fleet/lane-class-share.js';

export async function readClassShareJobs(): Promise<string> {
  const file = await open(join(homedir(), '.ashlr-runs/metrics/jobs.jsonl'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
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

export async function cmdFleetClassShare(args: string[], readJobs = readClassShareJobs, now = Date.now()): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log('ashlr fleet class-share [--hours N] [--json]\nRead-only event totals in the trailing window. Missing finishes contribute zero known tokens; PRs dedupe by URL.');
    return 0;
  }
  let hours = 3;
  let json = false;
  let hasHours = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json' && !json) json = true;
    else if (args[i] === '--hours' && !hasHours && /^\d+(?:\.\d+)?$/.test(args[i + 1] ?? '')) {
      hours = Number(args[++i]); hasHours = true;
      if (!Number.isFinite(hours) || hours <= 0) return 2;
    } else return 2;
  }
  try {
    const report = laneClassShare(await readJobs(), hours, now);
    console.log(json ? JSON.stringify(report) : ['lane class launches tokens_total prs_opened prs_merged',
      ...report.rows.map(r => `${r.lane} ${r.class} ${r.launches} ${r.tokens_total} ${r.prs_opened} ${r.prs_merged}`),
      `Malformed rows: ${report.malformed}`].join('\n'));
    return 0;
  } catch {
    console.error('fleet class-share: metrics unavailable');
    return 1;
  }
}
