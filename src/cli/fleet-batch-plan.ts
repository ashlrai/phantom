import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface FleetBatch { batch: number; repo: string; ids: string[] }

/** Queue order is the only age ordering available in positional ready.tsv rows. */
export function planFleetBatches(text: string, size: number): FleetBatch[] {
  const repos = new Map<string, string[]>();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const [rawId, rawRepo, rawLane] = line.split('\t');
    const id = rawId?.trim(), repo = rawRepo?.trim(), lane = rawLane?.trim();
    if (!id || !repo || !lane || /^PARKED/i.test(lane) || /^PARKED/i.test(id) || id === 'id') continue;
    const ids = repos.get(repo) ?? [];
    ids.push(id);
    repos.set(repo, ids);
  }
  const batches: FleetBatch[] = [];
  for (const [repo, ids] of repos) {
    for (let i = 0; i < ids.length; i += size) batches.push({ batch: batches.length + 1, repo, ids: ids.slice(i, i + size) });
  }
  return batches;
}

const usage = 'Usage: phm fleet batch-plan [--size N] [--json]\nGroup ready queue jobs by repository in queue order. Default batch size: 10. Read-only.';

export async function cmdFleetBatchPlan(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return 0; }
  let size = 10, sizeSet = false, json = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json' && !json) json = true;
    else if (args[i] === '--size' && !sizeSet && /^\d+$/.test(args[i + 1] ?? '')) {
      size = Number(args[++i]); sizeSet = true;
      if (!Number.isSafeInteger(size) || size < 1) { console.error(usage); return 2; }
    } else { console.error(usage); return 2; }
  }
  let text: string;
  try {
    text = await readFile(join(process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs'), 'queue', 'ready.tsv'), 'utf8');
  } catch {
    console.error('error: unable to read queue/ready.tsv');
    return 1;
  }
  const batches = planFleetBatches(text, size);
  if (json) console.log(JSON.stringify(batches));
  else if (!batches.length) console.log('No ready jobs.');
  else for (const batch of batches) console.log(`Batch ${batch.batch}: ${batch.repo} — ${batch.ids.join(', ')}`);
  return 0;
}
