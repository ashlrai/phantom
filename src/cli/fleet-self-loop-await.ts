import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute, parse, resolve } from 'node:path';

// Read-only: waits for a record written by `fleet self-loop-record`. It never
// launches, retries or signals a loop; it only polls one regular file.
interface Dependencies {
  output?: (text: string) => void;
  /** Monotonic milliseconds. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  read?: (path: string) => Promise<ReadResult>;
}
type ReadResult = { kind: 'missing' } | { kind: 'text'; text: string } | { kind: 'refused'; reason: string };

const MAX_BYTES = 64 * 1024;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const TERMINATIONS = ['duration', 'max-ticks', 'interrupted', 'observer-error'];

function parseIso(value: unknown): number | undefined {
  if (typeof value !== 'string' || !ISO.test(value)) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

function parseInteger(value: string | undefined, min: number, max: number): number | undefined {
  if (value === undefined || !/^\d{1,6}$/.test(value)) return undefined;
  const n = Number(value);
  return n >= min && n <= max ? n : undefined;
}

// Opened no-follow, then fstat on the descriptor, so the checked file is the read file.
export async function readReceiptFile(path: string): Promise<ReadResult> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { kind: 'missing' };
    return { kind: 'refused', reason: code === 'ELOOP' || code === 'ENOTDIR' ? 'unsafe record' : 'unreadable record' };
  }
  try {
    const st = await handle.stat();
    if (!st.isFile() || st.nlink !== 1) return { kind: 'refused', reason: 'unsafe record' };
    if (st.size > MAX_BYTES) return { kind: 'refused', reason: 'oversized record' };
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let used = 0;
    while (used < buffer.length) {
      const { bytesRead } = await handle.read(buffer, used, buffer.length - used, used);
      if (bytesRead === 0) break;
      used += bytesRead;
    }
    if (used > MAX_BYTES) return { kind: 'refused', reason: 'oversized record' };
    return { kind: 'text', text: buffer.subarray(0, used).toString('utf8') };
  } catch {
    return { kind: 'refused', reason: 'unreadable record' };
  } finally {
    await handle.close().catch(() => {});
  }
}

interface Evaluated { startedAt: string; finishedAt: string; summary: Record<string, unknown>; fresh: boolean }
type Outcome = Evaluated | 'running';

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

// Allowlisted copy of a loop summary, or undefined; lastReport is deliberately dropped.
function pickSummary(m: Record<string, unknown>): Record<string, unknown> | undefined {
  const keys = ['elapsedMs', 'durationMs', 'intervalMs', 'ticks', 'failures', 'busy'] as const;
  if (m['v'] !== 1 || parseIso(m['startedAt']) === undefined || parseIso(m['endedAt']) === undefined
    || !keys.every(k => isCount(m[k])) || (m['failures'] as number) > (m['ticks'] as number)
    || (m['busy'] as number) > (m['ticks'] as number)
    || typeof m['termination'] !== 'string' || !TERMINATIONS.includes(m['termination'])
    || (m['maxTicks'] !== undefined && !(isCount(m['maxTicks']) && m['maxTicks'] > 0))) return undefined;
  const summary: Record<string, unknown> = { startedAt: m['startedAt'], endedAt: m['endedAt'] };
  for (const k of [...keys, 'maxTicks'] as const) if (m[k] !== undefined) summary[k] = m[k];
  summary['termination'] = m['termination'];
  return summary;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

// Live snapshot from `self-loop-record --live`: running (keep polling) or completed.
// latest.report is never read, and latest.lastReport is dropped by pickSummary.
function evaluateLive(r: Record<string, unknown>, after: number): Outcome | undefined {
  const started = parseIso(r['startedAt']), updated = parseIso(r['updatedAt']);
  const latest = r['latest'];
  if (r['v'] !== 1 || started === undefined || updated === undefined || updated < started
    || r['summary'] !== undefined || r['finishedAt'] !== undefined || !isObject(latest)) return undefined;
  if (r['status'] === 'running') {
    const pass = latest['pass'], exit = latest['exitCode'];
    if (latest['v'] !== 1 || latest['record'] !== 'pass' || typeof pass !== 'number' || !Number.isSafeInteger(pass)
      || pass < 1 || typeof exit !== 'number' || !Number.isSafeInteger(exit)) return undefined;
    return 'running';
  }
  if (r['status'] !== 'completed' || latest['record'] !== 'summary') return undefined;
  const summary = pickSummary(latest);
  if (!summary) return undefined;
  return { startedAt: r['startedAt'] as string, finishedAt: r['updatedAt'] as string, summary, fresh: started >= after };
}

// Returns undefined for any shape deviation.
function evaluate(text: string, after: number): Outcome | undefined {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return undefined; }
  if (!isObject(value)) return undefined;
  const r = value;
  if (Object.hasOwn(r, 'status')) return evaluateLive(r, after);
  const s = r['summary'];
  if (r['v'] !== 1 || !isObject(s)) return undefined;
  const started = parseIso(r['startedAt']), finished = parseIso(r['finishedAt']);
  if (started === undefined || finished === undefined || finished < started) return undefined;
  const summary = pickSummary(s);
  if (!summary) return undefined;
  return { startedAt: r['startedAt'] as string, finishedAt: r['finishedAt'] as string, summary, fresh: started >= after };
}

export async function cmdFleetSelfLoopAwait(args: string[], deps: Dependencies = {}): Promise<number> {
  const output = deps.output ?? ((text: string) => console.log(text));
  const emit = (ok: boolean, reason: string, extra: Record<string, unknown> = {}) =>
    output(JSON.stringify({ v: 1, ok, reason, ...extra }));
  let path: string | undefined, afterText: string | undefined, timeout: number | undefined, poll = 100, json = false;
  const seen = new Set<string>();
  let usage = false;
  for (let i = 0; i < args.length && !usage; i++) {
    const arg = args[i]!;
    if (seen.has(arg)) { usage = true; break; }
    seen.add(arg);
    if (arg === '--json') json = true;
    else if (arg === '--result-file') path = args[++i];
    else if (arg === '--after') afterText = args[++i];
    else if (arg === '--timeout-ms') timeout = parseInteger(args[++i], 1, 60_000);
    else if (arg === '--poll-ms') { const p = parseInteger(args[++i], 10, 1000); if (p === undefined) usage = true; else poll = p; }
    else usage = true;
  }
  const after = parseIso(afterText);
  if (usage || !json || !path || !isAbsolute(path) || resolve(path) !== path || path === parse(path).root
    || after === undefined || timeout === undefined) {
    emit(false, 'invalid arguments'); return 2;
  }
  const now = deps.now ?? (() => performance.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(done => setTimeout(done, ms)));
  const read = deps.read ?? readReceiptFile;
  const deadline = now() + timeout;
  // Sequential polls; the deadline is checked before every read, never after it.
  while (now() < deadline) {
    const result = await read(path);
    if (result.kind === 'refused') { emit(false, result.reason); return 1; }
    if (result.kind === 'text') {
      const record = evaluate(result.text, after);
      if (!record) { emit(false, 'malformed record'); return 1; }
      if (record !== 'running' && record.fresh) {
        const failed = record.summary['termination'] === 'observer-error' || (record.summary['failures'] as number) > 0;
        emit(!failed, failed ? 'loop failed' : 'completed',
          { startedAt: record.startedAt, finishedAt: record.finishedAt, summary: record.summary });
        return failed ? 1 : 0;
      }
    }
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await sleep(Math.min(poll, remaining));
  }
  emit(false, 'timed out'); return 1;
}
