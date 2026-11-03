import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { readFollowCheckpoint, writeFollowCheckpoint } from '../core/fleet/apps-follow-checkpoint.js';
import { readAppsRecoveryHistory } from '../core/fleet/apps-recovery-history.js';

const usage = 'Usage: ashlr fleet apps-follow --duration-ms <1..300000> [--root <dir>] [--after <cursor> | --checkpoint <path>] [--invocation-id <uuid>] [--until-summary] [--interval-ms <100..60000>] [--max-events <1..1000>] --jsonl';
type Deps = {
  reader?: typeof readAppsRecoveryHistory;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
};

export async function cmdFleetAppsFollow(args: string[], deps: Deps = {}): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return 0; }
  const invalid = (): number => { console.error(`error: invalid fleet apps-follow arguments\n${usage}`); return 2; };
  let root = process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
  let after = 0, duration = 0, interval = 1000, maxEvents = 1000, invocationId: string | undefined, checkpoint: string | undefined;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!['--root', '--after', '--checkpoint', '--duration-ms', '--interval-ms', '--max-events', '--invocation-id', '--until-summary', '--jsonl'].includes(arg) || seen.has(arg)) return invalid();
    seen.add(arg);
    if (arg === '--jsonl' || arg === '--until-summary') continue;
    const value = args[++i];
    if (!value || value.startsWith('-')) return invalid();
    if (arg === '--root') root = value;
    else if (arg === '--checkpoint') checkpoint = value;
    else if (arg === '--invocation-id') {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) return invalid();
      invocationId = value;
    } else {
      if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(Number(value))) return invalid();
      const n = Number(value);
      if (arg === '--after') after = n;
      else if (arg === '--duration-ms') { if (n < 1 || n > 300000) return invalid(); duration = n; }
      else if (arg === '--interval-ms') { if (n < 100 || n > 60000) return invalid(); interval = n; }
      else { if (n < 1 || n > 1000) return invalid(); maxEvents = n; }
    }
  }
  if (!duration || !seen.has('--jsonl') || (seen.has('--until-summary') && !invocationId) || (checkpoint && seen.has('--after'))) return invalid();
  if (checkpoint) {
    try { after = readFollowCheckpoint(checkpoint, invocationId); }
    catch { console.error('error: unable to read or validate checkpoint'); return 2; }
  }
  const reader = deps.reader ?? readAppsRecoveryHistory, now = deps.now ?? (() => performance.now());
  const sleep = deps.sleep ?? (async (ms, signal) => { await delay(ms, undefined, { signal }); });
  const deadline = now() + duration;
  let delivered = 0, outcome: unknown, reason: 'deadline' | 'event_limit' | 'cancelled' | 'unavailable' | 'invalid_cursor' | 'invocation_finished';
  for (;;) {
    if (deps.signal?.aborted) { reason = 'cancelled'; break; }
    if (now() >= deadline) { reason = 'deadline'; break; }
    const page = reader(root, after, Math.min(100, maxEvents - delivered), invocationId);
    if (page.availability !== 'available') { reason = page.availability === 'invalid-cursor' ? 'invalid_cursor' : 'unavailable'; break; }
    let finished = false;
    for (const event of page.events) {
      console.log(JSON.stringify({ type: 'event', event })); delivered++;
      if (seen.has('--until-summary') && event.invocationId === invocationId && event.kind === 'apps-watch.summary.v1') {
        after = event.cursor as number; outcome = event.outcome; finished = true; break;
      }
    }
    if (!finished) after = page.nextCursor;
    if (checkpoint) {
      try { writeFollowCheckpoint(checkpoint, after, invocationId); }
      catch { console.error('error: unable to write checkpoint'); return 1; }
    }
    if (finished) { reason = 'invocation_finished'; break; }
    if (delivered >= maxEvents) { reason = 'event_limit'; break; }
    if (page.hasMore) continue;
    if (deps.signal?.aborted) { reason = 'cancelled'; break; }
    const remaining = deadline - now();
    if (remaining <= 0) { reason = 'deadline'; break; }
    try { await sleep(Math.min(interval, remaining), deps.signal); }
    catch (error) { if (!deps.signal?.aborted) throw error; }
  }
  console.log(JSON.stringify({ type: 'summary', reason, delivered, nextCursor: after, ...(reason === 'invocation_finished' ? { outcome } : {}) }));
  return reason === 'invalid_cursor' ? 2 : reason === 'unavailable' || outcome === 'failed' ? 1 : 0;
}
