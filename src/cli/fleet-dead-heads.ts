/** Read-only report; never edits queue state or launches jobs. */
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { queueDeadHeads } from '../core/fleet/queue-dead-heads.js';
import { parseReadyTsv } from '../core/fleet/lane-console.js';

async function readText(path: string, limit: number): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > limit) throw new Error('unavailable');
    const buffer = Buffer.alloc(limit + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > limit) throw new Error('unavailable');
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally { await file.close(); }
}

export async function cmdFleetDeadHeads(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log('ashlr fleet dead-heads [--json] [--root PATH] [--cap N]\nRead-only skip evidence; positions are one-based per lane. Default cap: 4 launchable lines.');
    return 0;
  }
  let root = join(homedir(), '.ashlr-runs');
  let cap = 4;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json' && !json) json = true;
    else if (args[i] === '--root' && args[i + 1] && !args[i + 1]!.startsWith('--')) root = resolve(args[++i]!);
    else if (args[i] === '--cap' && /^[1-9]\d*$/.test(args[i + 1] ?? '')) cap = Number(args[++i]);
    else return 2;
  }
  if (!Number.isSafeInteger(cap)) return 2;
  try {
    for (const dir of [root, join(root, 'queue'), join(root, 'queue/run')]) {
      if (!(await lstat(dir)).isDirectory()) throw new Error('unavailable');
    }
    const ready = await readText(join(root, 'queue/ready.tsv'), 2 * 1024 * 1024);
    const reasons = new Map<string, string>();
    for (const row of parseReadyTsv(ready).rows) {
      if (!row.id || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(row.id) || /^PARKED-/i.test(row.pool) || reasons.has(row.id)) continue;
      try { reasons.set(row.id, await readText(join(root, 'queue/run', `${row.id}.skipped-empty`), 4096)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    const result = { schema: 'fleet.dead-heads.v1', perLaneCap: cap, lanes: queueDeadHeads(ready, reasons, cap) };
    console.log(json ? JSON.stringify(result) : result.lanes.map(lane =>
      `${lane.lane}: ${lane.deadLines.length} dead lines; first launchable ${lane.firstLaunchablePosition ?? 'none'}; ${lane.roundsLost} rounds lost\n` +
      lane.deadLines.map(line => `  ${line.position}. ${line.job}: ${line.reason}`).join('\n')).join('\n'));
    return 0;
  } catch {
    console.error('fleet dead-heads: queue evidence unavailable');
    return 1;
  }
}
