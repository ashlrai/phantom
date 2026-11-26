/**
 * core/queue/order.ts: the queue in launch order, and the three ways to steer it.
 *
 * One file is the queue: <runsDir>/queue/ready.tsv, read top to bottom by the
 * dispatcher (the row contract and its only parser live in
 * fleet/ready-row-edit.ts). This adds no reader of its own. It lists the rows
 * that are waiting to launch and edits them:
 *   top   move a job's row to the front;
 *   lane  rewrite the row's lane column;
 *   drop  take the row out, after copying it to queue/dropped.tsv.
 *
 * EVERY WRITE holds queue/ready.lock, the flock(2) lock dispatchd.py,
 * restock.py and `phm queue dedupe` share, re-reads the file under it, edits
 * that fresh copy and replaces the file by rename. A row another writer
 * appended while we waited is therefore kept. The text as it was before the
 * first write is kept in queue/ready.tsv.bak.
 *
 * THE DISPATCHER reads ready.tsv at the start of a tick and writes its own
 * copy back at the end, so an edit made in between can be undone. The lock
 * helper also tries dispatchd.tick.lock without waiting: when it gets it, no
 * tick is running and the write is final. Otherwise the edit is checked again
 * after verifyMs and re-applied to the fresh file, up to `attempts` writes;
 * `verified: false` means the last check still found the old queue.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { DROP_JOB_LANES } from '../fleet/drop-job-writer.js';
import { defaultRunsDir } from '../fleet/landed-closes-read.js';
import { parseReadyRows, readReadyText, type ReadyRow } from '../fleet/ready-row-edit.js';
import { readLaneTargets } from '../fleet/runs-lane-targets.js';
import { replaceQueueText } from './dedupe.js';
import { queueAgeText, type QueueActionRequest, type QueueActionV1, type QueueOrderV1, type QueueSteerCode } from './order-types.js';
import { ROUTER_LINE, appendGuarded, cycleOf, eventClock, parked, repoKey, supersedeQueue } from './supersede.js';

export const READY_BACKUP = 'ready.tsv.bak';
export const DROP_ARCHIVE = 'dropped.tsv';

export class QueueSteerError extends Error {
  readonly status: 404 | 422 | 503;
  constructor(readonly code: QueueSteerCode) {
    super({
      'job-not-found': 'That job is not in the queue.',
      'lane-closed': 'That lane is unknown or held.',
      'queue-missing': 'The queue is unavailable.',
      'queue-busy': 'The queue is busy. Try again.',
    }[code]);
    this.name = 'QueueSteerError';
    this.status = code === 'job-not-found' ? 404 : code === 'lane-closed' ? 422 : 503;
  }
}

export interface ReadyLock {
  release: () => Promise<void>;
  /** True when no dispatcher tick is running, so nothing can write the old rows back. */
  quiet: boolean;
}
export type TakeReadyLock = (queueDir: string) => Promise<ReadyLock>;
export interface QueueOrderOptions {
  runsDir?: string;
  now?: () => Date;
  /** Names the surface in the event log (cli, desktop, mobile); never a person. */
  by?: string;
  /** Injected by tests; the default takes the real flock. */
  lock?: TakeReadyLock;
  /** Delay before a write is checked again while a tick is running. Default 2000 ms. */
  verifyMs?: number;
  /** Writes attempted before giving up. Default 3. */
  attempts?: number;
  sleep?: (ms: number) => Promise<void>;
}

// The tick lock is tried once; ready.lock is polled the way every other taker polls it.
const LOCK_SCRIPT = `import fcntl,sys,time
t=open(sys.argv[1],'a'); quiet='1'
try: fcntl.flock(t,fcntl.LOCK_EX|fcntl.LOCK_NB)
except OSError: quiet='0'
r=open(sys.argv[2],'a'); end=time.monotonic()+float(sys.argv[3])
while True:
  try: fcntl.flock(r,fcntl.LOCK_EX|fcntl.LOCK_NB); break
  except OSError:
    if time.monotonic()>end: sys.exit(4)
    time.sleep(0.05)
print('locked'+quiet,flush=True); sys.stdin.read()`;

/** Hold queue/ready.lock (waiting up to 10 s) until release. Throws queue-busy when it cannot be taken. */
export const flockReady: TakeReadyLock = queueDir => new Promise((resolve, reject) => {
  const child = spawn('python3', ['-c', LOCK_SCRIPT, join(queueDir, 'dispatchd.tick.lock'), join(queueDir, 'ready.lock'), '10'], { stdio: ['pipe', 'pipe', 'ignore'] });
  const closed = new Promise<void>(done => child.once('close', () => done()));
  let out = '';
  child.stdout.on('data', (chunk: Buffer) => {
    out += chunk.toString('utf8');
    if (out.startsWith('locked') && out.includes('\n')) resolve({ quiet: out[6] === '1', release: async () => { child.stdin.end(); await closed; } });
  });
  // After a resolve these are no-ops; before it, the helper failed or timed out.
  child.once('error', () => reject(new QueueSteerError('queue-busy')));
  child.once('close', () => reject(new QueueSteerError('queue-busy')));
});

const missing = (error: unknown): never => {
  throw (error as NodeJS.ErrnoException).code === 'ENOENT' ? new QueueSteerError('queue-missing') : error;
};

/** Lanes a job may move to: the dispatcher's lanes and the drop lanes, minus held ones. */
async function openLanes(runsDir: string): Promise<string[]> {
  const targets = (await readLaneTargets({ runsDir })).lanes;
  const held = new Set(targets.filter(row => row.held).map(row => row.lane));
  return [...new Set([...DROP_JOB_LANES, ...targets.map(row => row.lane)])].filter(lane => !held.has(lane)).sort();
}

/** The queue in launch order. Throws QueueSteerError('queue-missing') when there is no ready.tsv. */
export async function readQueueOrder(opts: QueueOrderOptions = {}): Promise<QueueOrderV1> {
  const runsDir = opts.runsDir ?? defaultRunsDir(), queueDir = join(runsDir, 'queue'), now = (opts.now ?? (() => new Date()))();
  const rows = parseReadyRows(await readReadyText(join(queueDir, 'ready.tsv')).catch(missing));
  const live = rows.filter(row => !parked(row));
  const plan = await supersedeQueue({ runsDir }).catch(() => null);
  const newer = new Map(plan?.superseded.map(job => [`${job.repo}\n${job.id}`, job.supersededBy]));
  // A job's age is the age of its prompt, which the producer writes as it queues the row.
  const age = async (path: string): Promise<number | null> => {
    if (!path.startsWith(`${queueDir}/`)) return null;
    try { return Math.max(0, Math.round((now.getTime() - (await lstat(path)).mtimeMs) / 1000)); } catch { return null; }
  };
  const jobs = await Promise.all(live.map(async (row, index) => ({
    position: index + 1, id: row.id, repo: row.repo, lane: row.lane, tier: row.tier, ageSeconds: await age(row.promptPath),
    family: cycleOf(row.id)?.family ?? null, supersededBy: newer.get(`${repoKey(row.repo)}\n${row.id}`) ?? null,
  })));
  return { schema: 'queue.order.v1', version: 1, generatedAt: now.toISOString(), count: jobs.length, parked: rows.length - live.length, lanes: await openLanes(runsDir), jobs };
}

/** Pure: the rows after the action, or null when the queue already is the way the action wants it. */
export function planQueueAction(rows: readonly ReadyRow[], req: QueueActionRequest): ReadyRow[] | null {
  const mine = rows.filter(row => row.id === req.id && !parked(row));
  if (!mine.length) return null;
  const rest = rows.filter(row => !mine.includes(row));
  if (req.action === 'drop') return rest;
  if (req.action === 'top') return rows.filter(row => !parked(row)).slice(0, mine.length).every((row, i) => row === mine[i]) ? null : [...mine, ...rest];
  const lane = req.lane ?? '';
  if (mine.every(row => row.lane === lane)) return null;
  // The dispatcher can hand back the old row beside the moved one; moving both leaves one copy.
  const seen = new Set<string>();
  return rows.flatMap(row => {
    if (!mine.includes(row)) return [row];
    const cells = row.raw.split('\t');
    cells[2] = lane;
    const raw = cells.join('\t');
    if (seen.has(raw)) return [];
    seen.add(raw);
    return [{ ...row, lane, raw }];
  });
}

/** Replace a file in the queue directory by temp + rename: never partial, never through a link. */
export async function replaceLockedQueueFile(path: string, text: string): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
    await rename(temp, path);
  } catch (error) { await unlink(temp).catch(() => {}); throw error; }
}

/** Mark the job's router-queue.md line DROPPED so the restocker does not queue it again. Best effort. */
async function markDropped(queueDir: string, id: string): Promise<void> {
  const path = join(queueDir, 'router-queue.md');
  for (let tries = 0; tries < 2; tries++) {
    const text = await readFile(path, 'utf8').catch(() => null);
    if (text === null) return;
    const marked = text.split('\n').map(line => {
      const match = ROUTER_LINE.exec(line);
      return match && match[4] === id && match[2]!.toUpperCase() !== 'RUNNING'
        ? line.replace(ROUTER_LINE, (all, lead: string, status: string) => `${lead}DROPPED${all.slice(lead.length + status.length)}`) : line;
    }).join('\n');
    if (marked === text) return;
    try { replaceQueueText(path, text, marked); return; } catch { /* the file changed under us: read it again */ }
  }
}

function sentence(report: Omit<QueueActionV1, 'message'>): string {
  const { id, from, to } = report, did = report.dryRun ? 'Would move' : 'Moved', place = `${from.position} of ${from.of}`;
  const text = !report.changed ? (report.action === 'top' ? `${id} is already first.` : `${id} is already on ${to.lane}.`)
    : report.action === 'top' ? `${did} ${id} to the top (${report.dryRun ? 'now' : 'was'} ${place}).`
    : report.action === 'lane' ? `${did} ${id} from ${from.lane} to ${to.lane}.`
    : report.dryRun ? `Would drop ${id} (${place}).` : `Dropped ${id} (was ${place}). Its row is kept in queue/${DROP_ARCHIVE}.`;
  return report.verified === false ? `${text} The dispatcher wrote the old queue back; run it again.` : text;
}

/** Move a queued job to the top, to another lane, or out of the queue. With dryRun nothing is written. */
export async function steerQueue(req: QueueActionRequest, opts: QueueOrderOptions = {}): Promise<QueueActionV1> {
  const runsDir = opts.runsDir ?? defaultRunsDir(), queueDir = join(runsDir, 'queue'), path = join(queueDir, 'ready.tsv');
  if (req.action === 'lane' && !(await openLanes(runsDir)).includes(req.lane ?? '')) throw new QueueSteerError('lane-closed');
  const attempts = Math.max(1, Math.floor(opts.attempts ?? 3)), dryRun = req.dryRun === true;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(done => setTimeout(done, ms)));
  let from: QueueActionV1['from'] | undefined, planned = false, writes = 0, verified: boolean | null = null, archive: string | null = null;
  for (let pass = 0; ; pass++) {
    const lock = await (opts.lock ?? flockReady)(queueDir);
    try {
      const text = await readReadyText(path).catch(missing);
      const rows = parseReadyRows(text), live = rows.filter(row => !parked(row)), at = live.findIndex(row => row.id === req.id);
      if (!from) {
        if (at < 0) throw new QueueSteerError('job-not-found');
        from = { position: at + 1, of: live.length, lane: live[at]!.lane };
      }
      const next = planQueueAction(rows, req);
      if (next === null) { verified = writes ? true : null; break; }
      planned = true;
      if (dryRun) break;
      if (pass >= attempts) { verified = false; break; }
      if (!writes) {
        await replaceLockedQueueFile(join(queueDir, READY_BACKUP), text);
        if (req.action === 'drop') {
          archive = DROP_ARCHIVE;
          await appendGuarded(join(queueDir, archive), live.filter(row => row.id === req.id).map(row => `${row.raw.replace(/\r$/, '')}\n`).join(''));
        }
      }
      await replaceLockedQueueFile(path, next.map(row => `${row.raw}\n`).join(''));
      writes++;
      if (lock.quiet) { verified = true; break; }
    } finally { await lock.release(); }
    await sleep(Math.max(0, opts.verifyMs ?? 2000));
  }
  if (!from) throw new QueueSteerError('job-not-found');
  const changed = dryRun ? planned : writes > 0;
  const to = { position: req.action === 'drop' ? null : req.action === 'top' ? 1 : from.position, lane: req.action === 'lane' ? req.lane! : from.lane };
  const report = { schema: 'queue.action.v1' as const, version: 1 as const, action: req.action, id: req.id, dryRun, changed, verified,
    from, to: changed || req.action === 'lane' ? to : { position: from.position, lane: from.lane }, backup: writes ? READY_BACKUP : null, archive };
  if (writes && verified) {
    if (req.action === 'drop') await markDropped(queueDir, req.id);
    const what = req.action === 'lane' ? `QUEUE_LANE ${req.id} ${from.lane} to ${req.lane}` : `QUEUE_${req.action === 'top' ? 'TOP' : 'DROPPED'} ${req.id}`;
    // The queue is already changed; a log that cannot be written must not turn that into a failure.
    await appendGuarded(join(queueDir, 'dispatch-events.log'), `${eventClock((opts.now ?? (() => new Date()))())} ${what} src=phm-queue by=${opts.by ?? 'cli'}\n`).catch(() => {});
  }
  return { ...report, message: sentence(report) };
}

/** One plain line per queued job, after a one-line summary. */
export function queueOrderText(order: QueueOrderV1): string[] {
  const head = order.count ? `${order.count} queued ${order.count === 1 ? 'job' : 'jobs'}, next to launch first.` : 'No queued jobs.';
  return [order.parked ? `${head} ${order.parked} parked.` : head, ...order.jobs.map(job =>
    `${String(job.position).padStart(3)}  ${job.id}  ${job.repo}  ${job.lane}  ${job.tier}  ${queueAgeText(job.ageSeconds)}${job.supersededBy ? `  replaced by ${job.supersededBy}` : ''}`)];
}
