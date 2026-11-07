import { lstat, readdir, rmdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const usage = 'Usage: phm fleet reap-marks [--min <minutes>] [--apply] [--json]';
type Marker = { jobId: string; ageMinutes: number; status?: 'removed' | 'not-empty' | 'changed' | 'failed' };

/** List stale reaping markers; apply only removes empty directories. */
export async function cmdFleetReapMarks(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log(`${usage}\nList marker directories older than 20 minutes by default. Use --apply to remove empty markers.`);
    return 0;
  }
  let min = 20, seenMin = false, apply = false, json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--min' && !seenMin && args[i + 1] !== undefined && /^(?:\d+\.?\d*|\.\d+)$/.test(args[i + 1]!)) {
      min = Number(args[++i]); seenMin = true;
      if (!Number.isFinite(min)) { console.error(usage); return 2; }
    } else if (arg === '--apply' && !apply) apply = true;
    else if (arg === '--json' && !json) json = true;
    else { console.error(usage); return 2; }
  }
  const root = join(process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs'), 'queue', 'run');
  const now = Date.now();
  const markers: Marker[] = [];
  try {
    let names: string[];
    try { names = await readdir(root); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      names = [];
    }
    for (const name of names.sort()) {
      if (!name.endsWith('.reaping') || name === '.reaping') continue;
      const path = join(root, name);
      let stat;
      try { stat = await lstat(path); }
      catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue; throw err; }
      const ageMinutes = (now - stat.mtimeMs) / 60_000;
      if (!stat.isDirectory() || ageMinutes <= min) continue;
      const marker: Marker = { jobId: name.slice(0, -'.reaping'.length), ageMinutes };
      markers.push(marker);
      if (apply) {
        try {
          const current = await lstat(path);
          if (!current.isDirectory() || current.dev !== stat.dev || current.ino !== stat.ino || (Date.now() - current.mtimeMs) / 60_000 <= min) {
            marker.status = 'changed';
          } else {
            await rmdir(path);
            marker.status = 'removed';
          }
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          marker.status = code === 'ENOTEMPTY' || code === 'EEXIST' ? 'not-empty' : code === 'ENOENT' ? 'changed' : 'failed';
        }
      }
    }
  } catch {
    console.error('Unable to read reaping markers.');
    return 1;
  }
  const report = { schema: 'fleet.reap-marks.v1', minMinutes: min, applied: apply, markers, total: markers.length };
  if (json) console.log(JSON.stringify(report));
  else {
    for (const marker of markers) console.log(`${marker.jobId}: ${marker.ageMinutes.toFixed(2)} minutes${marker.status ? ` (${marker.status})` : ''}`);
    console.log(`Total: ${markers.length}`);
  }
  return markers.some(marker => marker.status === 'failed') ? 1 : 0;
}
