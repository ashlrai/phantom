/** Offline IO: existing bounded metadata readers, with a single advisory append sink. */
import { constants } from 'node:fs';
import { mkdir, open, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readSource } from '../fleet/runs-parked-queue.js';
import { readFleetHeartbeat } from '../../cli/fleet-heartbeat.js';
import { redactHomePaths, scrubPrivateText } from '../util/scrub.js';
import { AMPLIFY_OBJECTIVE, MAX_AGE_MS, projectAmplify, record, stamp, type AmplifySnapshot } from './snapshot.js';

export const amplifyRunsDir = (): string => process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
const SMALL = 256 * 1024;
const parse = (text: string): unknown => JSON.parse(text) as unknown;
export async function readAmplifyStatus(root = amplifyRunsDir(), now = Date.now()): Promise<AmplifySnapshot> {
  const sources: Record<string, string> = {};
  const read = async (relative: string, tail = false) => {
    const source = await readSource(join(root, relative), tail ? 1024 * 1024 : SMALL, tail);
    sources[relative] = source.state;
    return source;
  };
  const json = async (relative: string) => {
    const s = await read(relative);
    if (s.state !== 'healthy') return null;
    try {
      const value = parse(s.text);
      if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid metadata');
      return value;
    } catch { sources[relative] = 'degraded'; return null; }
  };
  const [ledger, overrides, status, controllerSource, heartbeat] = await Promise.all([
    json('queue/resources-ledger.json').then(v => sources['queue/resources-ledger.json'] === 'missing' ? json('resources-ledger.json') : v),
    json('queue/budget-overrides.json'), json('queue/status.json'), read('metrics/fleet-controller.jsonl', true),
    readFleetHeartbeat({
      queueStatus: async () => {
        const s = await readSource(join(root, 'queue/status.json'), SMALL, false);
        return s.state === 'healthy' ? s.text : null;
      },
      supervisorStatuses: async () => {
        const names = await readdir(join(root, 'supervisor')).catch(() => [] as string[]);
        return Promise.all(names.filter(n => /^status-[A-Za-z0-9._-]{1,80}\.md$/.test(n)).sort().slice(0, 64).map(async name => {
          const s = await readSource(join(root, 'supervisor', name), SMALL, false);
          return { name, text: s.state === 'healthy' ? s.text : '' };
        }));
      },
    }, now, MAX_AGE_MS / 60_000),
  ]);
  // The last complete controller record is authoritative; damaged tails remain visibly degraded.
  let controller: unknown = null;
  for (const line of controllerSource.text.split(/\r?\n/).filter(Boolean)) {
    try { controller = parse(line); } catch { sources['metrics/fleet-controller.jsonl'] = 'degraded'; controller = null; }
  }
  // The shared heartbeat reader clamps future times; these are unknown/stale here.
  for (const s of heartbeat.sources) {
    if (s.at && Date.parse(s.at) > now) { s.stale = true; s.ageMinutes = null; }
  }
  heartbeat.stale = heartbeat.sources.some(s => s.stale);
  return projectAmplify({ ledger, overrides, status, controller, heartbeat, sources }, now);
}
export async function amplifyTick(root = amplifyRunsDir(), now = Date.now()): Promise<AmplifySnapshot> {
  const snapshot = await readAmplifyStatus(root, now);
  await mkdir(join(root, 'metrics'), { recursive: true, mode: 0o700 });
  const file = await open(join(root, 'metrics/amplify.jsonl'), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    if (!(await file.stat()).isFile()) throw new Error('Invalid advisory journal');
    await file.writeFile(JSON.stringify({ ...snapshot, schema: 'amplify.tick.v1', type: 'ADVISORY' }) + '\n');
  } finally { await file.close(); }
  return snapshot;
}
function clean(v: unknown): string | null {
  return typeof v === 'string' ? redactHomePaths(scrubPrivateText(v, { emails: true })).replace(/\p{Cc}/gu, ' ').slice(0, 600) : null;
}
export async function readAmplifyGoal(root = amplifyRunsDir(), limit = 10) {
  const source = await readSource(join(root, 'leader/decisions.jsonl'), 1024 * 1024, true);
  let state = source.state;
  const decisions = [];
  for (const line of source.text.split(/\r?\n/).filter(Boolean)) {
    try {
      const row = record(parse(line));
      const at = stamp(row.at ?? row.ts ?? row.timestamp);
      const decision = clean(row.decision ?? row.summary ?? row.action);
      if (at === null || decision === null) { state = 'degraded'; continue; }
      decisions.push({ at, decision, rationale: clean(row.rationale ?? row.reason) });
    } catch { state = 'degraded'; }
  }
  return { schema: 'amplify.goal.v1', objective: AMPLIFY_OBJECTIVE, advisory: true, source: state,
    decisions: decisions.slice(-Math.min(100, Math.max(1, Math.floor(limit)))).reverse() };
}
