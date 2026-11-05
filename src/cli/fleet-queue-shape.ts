import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { parseReadyTsv } from '../core/fleet/lane-console.js';
import { queueShape } from '../core/fleet/queue-shape.js';
import { readLaneTargets } from '../core/fleet/runs-lane-targets.js';
export { queueShape };
export type { QueueShapeLane, QueueShapeReport, QueueShapeRepo } from '../core/fleet/queue-shape.js';

const MAX_BYTES = 4 * 1024 * 1024;
const usage = 'Usage: phm fleet queue-shape [--queue-dir <abs>] [--factor <n>] [--json]\nPer-lane ready-queue depth against slot targets, and the repos filling it. Reads <queue-dir>/ready.tsv plus the queue\'s slots.json lane targets (default ~/.ashlr-runs/queue). A lane is OVER-DEEP when ready > factor x target (default 3) or the target is 0 with ready rows. Read-only: no writes, no child processes, no network.';

export async function cmdFleetQueueShape(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return 0; }
  let queueDir: string | undefined, factor: number | undefined, json = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json' && !json) json = true;
    else if (args[i] === '--queue-dir' && !queueDir && args[i + 1] && isAbsolute(args[i + 1]!)) queueDir = args[++i];
    else if (args[i] === '--factor' && factor === undefined && args[i + 1] && !args[i + 1]!.startsWith('-')) {
      factor = Number(args[++i]);
      if (!Number.isFinite(factor) || factor <= 0) { console.error(usage); return 2; }
    } else { console.error(usage); return 2; }
  }
  const dir = queueDir ?? join(homedir(), '.ashlr-runs', 'queue');
  let text: string;
  try {
    const path = join(dir, 'ready.tsv');
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_BYTES) throw new Error('not a readable ready.tsv');
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') { console.log('queue: missing (ready.tsv)'); return 0; }
    console.error('queue: unreadable (ready.tsv)');
    return 1;
  }
  const { rows } = parseReadyTsv(text);
  const targets = await readLaneTargets({ runsDir: dirname(dir) });
  const report = queueShape(
    rows,
    targets.lanes.map(row => ({ lane: row.lane, target: row.target, held: row.held })),
    factor === undefined ? {} : { overDeepFactor: factor },
  );
  if (json) { console.log(JSON.stringify(report)); return 0; }
  if (report.lanes.length === 0) console.log('queue: empty (no lanes)');
  for (const lane of report.lanes) {
    const depth = lane.target === null ? 'no target' : `target ${lane.target}${lane.ratio === null ? '' : ` (${lane.ratio.toFixed(1)}x)`}`;
    const flags = `${lane.overDeep ? '  OVER-DEEP' : ''}${lane.held ? ' HELD' : ''}`;
    const top = lane.topRepos.length === 0 ? '' : `  top: ${lane.topRepos.map(r => `${r.repo} ${Math.round(r.share * 100)}%`).join(', ')}`;
    console.log(`${lane.lane}  ready ${lane.ready} / ${depth}${flags}${top}`);
  }
  return 0;
}
