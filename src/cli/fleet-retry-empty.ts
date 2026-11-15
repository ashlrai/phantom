import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readEmptyJobs, type EmptyJobResult } from '../core/fleet/empty-jobs.js';

const usage = 'Usage: phm fleet retry-empty --dry-run|--apply [--json] [--file <router-queue.md>]';
const receipt = (id: string): string => createHash('sha256').update(id).digest('hex');

/** Only retry jobs whose original queue entry supplies an unambiguous route and goal. */
export function planEmptyRetries(queue: string, jobs: EmptyJobResult[], receipts: Set<string>): string[] {
  const lines = queue.split(/\r?\n/);
  const output: string[] = [];
  for (const job of jobs) {
    if (!['too-broad', 'tests-timeout'].includes(job.class) || receipts.has(receipt(job.id))) continue;
    const id = job.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const entries = lines.filter(line => new RegExp(`^\\s*-\\s+(?:\\S+\\s+)*${id}\\s*\\(`).test(line));
    if (entries.length !== 1 || /\bretry-empty-source=/.test(entries[0]!)) continue;
    const entry = entries[0]!;
    const match = /\(([^)]*)\):\s*(\S.*)$/.exec(entry);
    const attrs = match?.[1] ?? '';
    const goal = match?.[2]?.trim();
    const repo = /\brepo=([\w.-]+)/.exec(attrs)?.[1];
    const pool = /\bpool=([\w.-]+)/.exec(attrs)?.[1];
    const tier = /\btier=(frontier|work|mid|fast)\b/.exec(attrs)?.[1];
    if (!goal || !repo || !pool || !tier) continue;
    const retryId = `RQ-EMPTYRETRY-${receipt(job.id).slice(0, 20).toUpperCase()}`;
    if (lines.some(line => line.includes(retryId))) continue;
    output.push(`- READY ${retryId} (P1, pool=${pool}, tier=${tier}, repo=${repo}, size<=200, src=leader): Complete one smallest independently shippable part of this goal: ${goal} Ship partial, list the gap. retry-empty-source=${job.id}`);
  }
  return output;
}

// Lock with the dispatcher, check the snapshot, then persist receipts before the queue.
// A crash after a receipt may require manual recovery, but cannot enqueue twice.
const writer = `import fcntl, json, os, stat, sys, tempfile
path, lockpath, receipts = sys.argv[1:]
data = json.load(sys.stdin)
with open(lockpath, 'a') as lock:
 fcntl.flock(lock, fcntl.LOCK_EX)
 info = os.lstat(path)
 if not stat.S_ISREG(info.st_mode): raise ValueError('queue is not regular')
 with open(path, encoding='utf-8', newline='') as f: current = f.read()
 if current != data['before']: raise ValueError('queue changed')
 os.makedirs(receipts, mode=0o700, exist_ok=True)
 if any(os.path.exists(os.path.join(receipts, x)) for x in data['receipts']): raise ValueError('already retried')
 for name in data['receipts']:
  fd = os.open(os.path.join(receipts, name), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
  os.fsync(fd); os.close(fd)
 fd = os.open(receipts, os.O_RDONLY); os.fsync(fd); os.close(fd)
 fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix='.empty-retry-')
 try:
  os.fchmod(fd, stat.S_IMODE(info.st_mode))
  with os.fdopen(fd, 'w', encoding='utf-8', newline='') as f:
   f.write(data['after']); f.flush(); os.fsync(f.fileno())
  os.replace(tmp, path)
 finally:
  if os.path.exists(tmp): os.unlink(tmp)
`;

async function retryEmpty(args: string[]): Promise<number> {
  let mode: 'dry-run' | 'apply' | undefined;
  let json = false;
  const root = process.env.ASHLR_RUNS_DIR?.trim() || join(homedir(), '.ashlr-runs');
  let file = join(root, 'queue/router-queue.md');
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') { console.log(usage); return 0; }
    if ((arg === '--dry-run' || arg === '--apply') && !mode) mode = arg.slice(2) as 'dry-run' | 'apply';
    else if (arg === '--json' && !json) json = true;
    else if (arg === '--file' && args[i + 1] && !args[i + 1]!.startsWith('--')) file = args[++i]!;
    else { console.error(usage); return 2; }
  }
  if (!mode) { console.error(usage); return 2; }
  try {
    const report = await readEmptyJobs();
    if (!report) throw new Error('Jobs ledger is unreadable');
    const before = await readFile(file, 'utf8');
    const receiptDir = join(dirname(file), 'empty-retry-receipts');
    const receipts = new Set(await readdir(receiptDir).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error; }));
    const lines = planEmptyRetries(before, report.jobs, receipts);
    if (mode === 'apply' && lines.length) {
      const ids = lines.map(line => receipt(/\bretry-empty-source=([\w.-]+)$/.exec(line)![1]!));
      const after = before + (before && !before.endsWith('\n') ? '\n' : '') + lines.join('\n') + '\n';
      const result = spawnSync('python3', ['-c', writer, file, join(dirname(file), 'ready.lock'), receiptDir], { input: JSON.stringify({ before, after, receipts: ids }), encoding: 'utf8', timeout: 10000 });
      if (result.status !== 0) throw new Error('Could not update queue; it may have changed or a retry was already recorded');
    }
    if (json) console.log(JSON.stringify({ schema: 'jobs.retry-empty.v1', applied: mode === 'apply', lines }));
    else if (lines.length) console.log(lines.join('\n'));
    else console.log('No eligible empty jobs to retry.');
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Retry failed');
    return 1;
  }
}

// Convention export is deliberately non-async so the generated fleet registry
// (scripts/gen-fleet-registry.mjs) leaves this preserved verb unlisted; the
// contract — cmdFleetRetryEmpty(args): Promise<number> — matches the loader.
export function cmdFleetRetryEmpty(args: string[]): Promise<number> {
  return retryEmpty(args);
}
