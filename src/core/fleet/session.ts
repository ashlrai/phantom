/** Read-only router session projection. Follow emits complete snapshots as JSONL. */
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { scrubSecrets } from '../util/scrub-secrets.js';

const LIMIT = 4 * 1024 * 1024;
const TAIL = 64 * 1024;
const FINISHED = /^(DONE|FINISHED|COMPLETED|LAND|LANDED|MERGED|FAILED|CANCELLED|CANCELED|ERROR)$/i;

async function readTail(path: string, limit: number): Promise<string> {
  let file;
  try {
    file = await open(path, 'r');
    const info = await file.stat();
    if (!info.isFile()) throw new Error('not a regular file');
    const start = Math.max(0, info.size - limit);
    const buffer = Buffer.alloc(Math.min(info.size, limit));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    return start ? text.slice(text.indexOf('\n') + 1) : text;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  } finally { await file?.close(); }
}

function field(row: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) if (typeof row[key] === 'string' && row[key]) return row[key] as string;
  return null;
}
function link(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash ? url.href : null;
  } catch { return null; }
}

export interface FleetSessionOptions {
  queueDir?: string;
  follow?: boolean;
  signal?: AbortSignal;
  pollMs?: number;
}

export async function getFleetSession(job: string, options: FleetSessionOptions = {}) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(job)) throw new Error('invalid job id');
  const dir = options.queueDir ?? join(homedir(), '.ashlr-runs', 'queue');
  const metadata: Record<string, unknown> = Object.create(null);
  let found = false;
  for (const line of (await readTail(join(dir, 'jobs.jsonl'), LIMIT)).split('\n')) {
    let row;
    try { row = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    if (!row || (row.job ?? row.id ?? row.jobId) !== job) continue;
    found = true;
    Object.assign(metadata, row);
    const state = field(row, 'to', 'status', 'event');
    if (state) metadata.currentStatus = state;
  }
  if (!found) throw new Error('unknown job id');
  const status = field(metadata, 'currentStatus');
  const logPath = field(metadata, 'logPath', 'log_file', 'logFile', 'log');
  const log = await readTail(logPath ? (isAbsolute(logPath) ? logPath : join(dir, logPath)) : join(dir, 'logs', `${job}.log`), TAIL);
  return {
    schema: 'fleet.session.v1', job,
    lane: field(metadata, 'pool', 'lane'), status,
    repo: field(metadata, 'repo'), tier: field(metadata, 'tier'),
    at: field(metadata, 'at', 'updatedAt'),
    prUrl: link(field(metadata, 'prUrl', 'pr_url', 'pr')),
    sessions: {
      codex: link(field(metadata, 'codexUrl', 'codexSessionUrl', 'codex_session_url')),
      devin: link(field(metadata, 'devinUrl', 'devinSessionUrl', 'devin_session_url')),
      claude: link(field(metadata, 'claudeUrl', 'claudeSessionUrl', 'claude_session_url')),
    },
    log: scrubSecrets(log), finished: status !== null && FINISHED.test(status),
  };
}

/** Full bounded snapshots only when changed; a finished job always terminates. */
export async function* followFleetSession(job: string, options: FleetSessionOptions = {}) {
  let previous = '';
  while (!options.signal?.aborted) {
    const snapshot = await getFleetSession(job, options);
    const serialized = JSON.stringify(snapshot);
    if (serialized !== previous) { yield snapshot; previous = serialized; }
    if (!options.follow || snapshot.finished) return;
    try { await delay(options.pollMs ?? 500, undefined, { signal: options.signal }); }
    catch (error) { if (options.signal?.aborted) return; throw error; }
  }
}
