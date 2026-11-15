/** `ashlr fleet order-jobs <MM-DD HH:MM> [--json]` — for one inbox order,
 * name the RQ jobs that serve it and where each stands: lane, trace state
 * (queued / launched / published / merged), whether a live worker runs it
 * right now, and its pull URL (github pull URLs only). The key is the same
 * `key` that order-state prints, e.g. "11-13 13:13". Read-only: reads the
 * order trace once and the live process table once; no network, no writes;
 * never prints order text bodies, prompt text, command lines or pids. */
import { classifyOrder, pullRequest, type LiveJobIds } from '../core/fleet/order-work-state.js';
import { readOrderTrace, type OrderTraceV1 } from '../core/fleet/order-trace.js';
import { listLiveWorkers, type LiveWorkersSnapshot } from '../core/fleet/runs-live-workers.js';

const usage = 'Usage: ashlr fleet order-jobs <MM-DD HH:MM> [--json]';
/** The key order-state prints: `MM-DD HH:MM` with no year. */
const KEY_RE = /^\d{2}-\d{2} [0-2]\d:[0-5]\d$/;

export async function cmdFleetOrderJobs(
  args: string[],
  deps: { read?: typeof readOrderTrace; now?: () => number; live?: () => Promise<LiveWorkersSnapshot> } = {},
): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return 0; }
  let json = false;
  let key: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--help' || arg === '-h') { console.log(usage); return 0; }
    else if (arg === '--json') json = true;
    else if (arg.startsWith('-')) { console.error(`fleet order-jobs: bad argument: ${arg}\n${usage}`); return 2; }
    else if (key === null) key = arg;
    else { console.error(`fleet order-jobs: unexpected argument: ${arg}\n${usage}`); return 2; }
  }
  if (key === null || !KEY_RE.test(key)) {
    console.error('fleet order-jobs: expected one order key "MM-DD HH:MM"\n' + usage);
    return 2;
  }
  let trace: OrderTraceV1;
  try {
    trace = await (deps.read ?? readOrderTrace)({ now: deps.now });
  } catch {
    console.error('fleet order-jobs: unable to read the order trace');
    return 1;
  }
  const order = trace.orders.find((o) => o.key === key);
  if (order === undefined) { console.error(`no order with key ${key}`); return 1; }
  let live: LiveJobIds | undefined;
  let liveState: 'healthy' | 'unavailable';
  try {
    const snapshot = await (deps.live ?? listLiveWorkers)();
    liveState = snapshot.sourceState;
    if (liveState === 'healthy') live = { jobIds: new Set(snapshot.workers.map((w) => w.job)), at: snapshot.generatedAt };
  } catch {
    liveState = 'unavailable';
  }
  const nowIso = new Date((deps.now ?? Date.now)()).toISOString();
  const classified = classifyOrder(order, trace.generatedAt, nowIso, live);
  const jobs = order.jobs.map((job) => {
    const pull = pullRequest(job.url);
    return {
      id: job.id,
      lane: job.lane,
      state: job.state,
      live: liveState === 'healthy' ? live!.jobIds.has(job.id) : null,
      pr: pull === null ? null : pull.url,
    };
  });
  if (json) {
    console.log(JSON.stringify({
      v: 1, key, at: order.at, source: order.source,
      state: classified.state, asOf: classified.asOf, evidenceSource: classified.source,
      missing: classified.missing, live: liveState, sources: trace.sources, jobs,
    }));
    return 0;
  }
  const bad = Object.entries(trace.sources).filter(([, s]) => s !== 'healthy');
  if (bad.length) console.log(`warning: order sources not healthy: ${bad.map(([k, s]) => `${k}=${s}`).join(' ')}`);
  if (liveState === 'unavailable') console.log('warning: live workers unavailable; live status not checked');
  console.log(`${key} ${order.at} ${order.source} ${classified.state} as-of=${classified.asOf} source=${classified.source} missing=${classified.missing.length ? classified.missing.join(',') : 'none'}`);
  for (const job of jobs) {
    console.log(`job ${job.id} lane=${job.lane ?? '-'} state=${job.state} live=${job.live === null ? 'null' : String(job.live)} pr=${job.pr ?? '-'}`);
  }
  return 0;
}
