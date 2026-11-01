import { randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, linkSync, lstatSync, openSync, realpathSync, unlinkSync, type BigIntStats } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { type Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { type BusInboxOptions } from '../core/fleet/bus-inbox.js';
import { BUS_SCATTER_DEFAULT_CONCURRENCY, BUS_SCATTER_DEFAULT_TIMEOUT_MS, BUS_SCATTER_INTERVAL_MS,
  BUS_SCATTER_MAX_BYTES, BUS_SCATTER_MAX_CONCURRENCY, BUS_SCATTER_MAX_TIMEOUT_MS, BUS_SCATTER_MIN_CONCURRENCY,
  BUS_SCATTER_MIN_TIMEOUT_MS, parseBusScatterFile, previewBusScatter, scatterBusRequests,
  type BusScatterReport, type ScatterDependencies } from '../core/fleet/bus-scatter-request.js';
import { sanitizePublicJson } from '../core/util/public-json.js';
import { fsyncDirectory } from '../core/util/durability.js';
import { writePrivateFileAtomically } from '../core/util/private-file-write.js';
import { assurePrivateStoragePath } from '../core/util/private-storage.js';
import { readStableRegularFile } from '../core/util/stable-file-read.js';

interface Dependencies extends ScatterDependencies { output?: (text: string) => void; input?: Readable & { isTTY?: boolean } }

/** Wait for EOF without retaining bytes beyond the batch limit or owning the stream. */
function readInput(input: Readable & { isTTY?: boolean }, deadline: number, signal: AbortSignal): Promise<string | null> {
  if (input.isTTY || input.readableEnded || input.destroyed || signal.aborted || performance.now() >= deadline) return Promise.resolve(null);
  return new Promise(resolve => {
    const chunks: Buffer[] = [];
    let size = 0, finished = false;
    const finish = (text: string | null): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      input.removeListener('data', onData); input.removeListener('end', onEnd);
      input.removeListener('error', onFailure); input.removeListener('close', onFailure);
      signal.removeEventListener('abort', onFailure);
      input.pause();
      resolve(text);
    };
    const onFailure = (): void => finish(null);
    const onData = (chunk: unknown): void => {
      if (performance.now() >= deadline || (!Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array)) ||
          chunk.byteLength > BUS_SCATTER_MAX_BYTES - size) return onFailure();
      size += chunk.byteLength;
      chunks.push(Buffer.from(chunk));
    };
    const onEnd = (): void => {
      if (!size || performance.now() >= deadline) return onFailure();
      try { finish(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size))); }
      catch { onFailure(); }
    };
    const timer = setTimeout(onFailure, Math.max(0, deadline - performance.now()));
    input.on('data', onData); input.once('end', onEnd);
    input.once('error', onFailure); input.once('close', onFailure);
    signal.addEventListener('abort', onFailure, { once: true });
    if (input.readableEnded || input.destroyed || signal.aborted) onFailure();
  });
}

const MAX_REPORT_BYTES = 2 * 1024 * 1024;
interface Reservation { path: string; parent: string; parentStat: BigIntStats; fd: number; stat: BigIntStats }
const sameNode = (a: BigIntStats, b: BigIntStats): boolean => a.dev === b.dev && a.ino === b.ino;
function safeParent(path: string): BigIntStats {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path ||
      typeof process.getuid === 'function' && stat.uid !== BigInt(process.getuid()) ||
      process.platform !== 'win32' && (stat.mode & 0o077n) !== 0n ||
      !assurePrivateStoragePath(path, 'directory', 'inspect-existing', { anchorPath: path }).ok) throw new Error('unsafe parent');
  if (process.platform !== 'win32') {
    for (let current = dirname(path); ; current = dirname(current)) {
      const ancestor = lstatSync(current, { bigint: true });
      if (!ancestor.isDirectory() || ancestor.isSymbolicLink() ||
          typeof process.getuid === 'function' && ancestor.uid !== 0n && ancestor.uid !== BigInt(process.getuid()) ||
          (ancestor.mode & 0o022n) !== 0n && (ancestor.mode & 0o1000n) === 0n) throw new Error('unsafe ancestor');
      if (dirname(current) === current) break;
    }
  }
  return stat;
}
function reserveOutput(path: string): Reservation {
  const parent = dirname(path), parentStat = safeParent(parent);
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  let stat: BigIntStats | undefined;
  try {
    stat = fstatSync(fd, { bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n || stat.size !== 0n ||
        typeof process.getuid === 'function' && stat.uid !== BigInt(process.getuid()) ||
        process.platform !== 'win32' && (stat.mode & 0o777n) !== 0o600n ||
        !assurePrivateStoragePath(path, 'file', 'secure-created', { anchorPath: parent }).ok ||
        !sameNode(stat, lstatSync(path, { bigint: true })) || !sameNode(parentStat, safeParent(parent))) throw new Error('unsafe reservation');
    return { path, parent, parentStat, fd, stat };
  } catch (error) {
    closeSync(fd);
    if (stat) removeReservation({ path, parent, parentStat, fd, stat });
    throw error;
  }
}
function removeReservation(reservation: Reservation): void {
  try {
    if (sameNode(reservation.parentStat, safeParent(reservation.parent)) &&
        sameNode(reservation.stat, lstatSync(reservation.path, { bigint: true }))) unlinkSync(reservation.path);
  } catch { /* Never remove a replacement or a path in a changed parent. */ }
}
function saveReport(reservation: Reservation, text: string): void {
  if (Buffer.byteLength(text) > MAX_REPORT_BYTES || !sameNode(reservation.parentStat, safeParent(reservation.parent))) throw new Error('unsafe output');
  checkReservation(reservation);
  const stage = join(reservation.parent, `.bus-scatter-${randomBytes(16).toString('hex')}.json`);
  let staged: BigIntStats | undefined;
  try {
    writePrivateFileAtomically(`${stage}.tmp`, stage, text, { anchorPath: reservation.parent, label: 'bus-scatter report' });
    staged = lstatSync(stage, { bigint: true });
    if (!sameNode(reservation.parentStat, safeParent(reservation.parent))) throw new Error('parent changed');
    checkReservation(reservation);
    // link() publishes without replacing a new occupant if the reservation is raced.
    unlinkSync(reservation.path);
    linkSync(stage, reservation.path);
    if (!sameNode(staged, lstatSync(reservation.path, { bigint: true }))) throw new Error('report changed');
    fsyncDirectory(reservation.parent);
  } finally {
    if (staged) {
      try {
        if (sameNode(reservation.parentStat, safeParent(reservation.parent)) && sameNode(staged, lstatSync(stage, { bigint: true }))) unlinkSync(stage);
      } catch { /* Do not remove a replacement. */ }
    }
  }
}
function checkReservation(reservation: Reservation): void {
  const named = lstatSync(reservation.path, { bigint: true }), opened = fstatSync(reservation.fd, { bigint: true });
  if (!named.isFile() || named.isSymbolicLink() || !sameNode(reservation.stat, named) || !sameNode(reservation.stat, opened) ||
      named.nlink !== 1n || opened.nlink !== 1n || named.size !== 0n || opened.size !== 0n ||
      process.platform !== 'win32' && ((named.mode & 0o777n) !== 0o600n || (opened.mode & 0o777n) !== 0o600n) ||
      !assurePrivateStoragePath(reservation.path, 'file', 'inspect-existing', { anchorPath: reservation.parent }).ok) throw new Error('reservation changed');
}

function redactFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactFields);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    /(?:api[_-]?key|token|secret|password|passwd|pwd|credentials?|private[_-]?key|access[_-]?key|auth(?:orization)?|connection[_-]?string)$/i.test(key)
      ? '[REDACTED]' : redactFields(item)]));
}

function statusReport(mode: 'preview' | 'apply', status: BusScatterReport['status'], startedAt: number): BusScatterReport {
  return { schema: 'fleet.bus-scatter.v1', mode, status, correlation: 'untrusted-routing-only',
    concurrency: 0, timeoutMs: 0, intervalMs: BUS_SCATTER_INTERVAL_MS,
    elapsedMs: Math.max(0, Math.floor(performance.now() - startedAt)),
    counts: { total: 0, attempted: 0, replied: 0, failed: 0, notAttempted: 0 }, requests: [] };
}

/** Bounded routing metadata plus per-request outcome; reply bodies stay out of text mode. */
function formatScatterText(report: BusScatterReport): string {
  const counts = report.counts;
  const head = report.mode === 'preview'
    ? `bus-scatter preview: ${counts.total} request(s) valid, concurrency ${report.concurrency}, timeout ${report.timeoutMs}ms`
    : `bus-scatter ${report.status}: ${counts.replied}/${counts.total} replied, ${counts.notAttempted} not-attempted in ${report.elapsedMs}ms`;
  return [head, ...report.requests.map(row => {
    const reply = row.result?.reply;
    return `  ${row.id} ${row.from} -> ${row.to} ${row.priority} ttl=${row.ttl} ${row.outcome}` +
      (reply ? ` reply=${reply.envelope.id}` : '');
  })].join('\n');
}

/** Convention-resolved CLI entry: fans out a validated batch under one shared deadline. */
export async function cmdFleetBusScatter(args: string[], options: BusInboxOptions = {}, deps: Dependencies = {}): Promise<number> {
  const start = performance.now(), output = deps.output ?? console.log;
  let json = false, apply = false, stdin = false, reservation: Reservation | undefined;
  const emit = (report: BusScatterReport): number => {
    try {
      const safe = sanitizePublicJson(redactFields(report)) as BusScatterReport;
      let saveFailed = false;
      if (reservation) {
        try { saveReport(reservation, JSON.stringify(safe)); }
        catch { saveFailed = true; console.error('bus-scatter: failed to save output report'); }
      }
      output(json || report.status === 'invalid-input' ? JSON.stringify(safe) : formatScatterText(safe));
      if (saveFailed) return 1;
    } catch { return 1; }
    return report.status === 'preview' || report.status === 'all-replied' ? 0 : report.status === 'invalid-input' ? 2 : 1;
  };
  const report = (status: BusScatterReport['status']): BusScatterReport => statusReport(apply ? 'apply' : 'preview', status, start);
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    output('Usage: ashlr fleet bus-scatter (--file <absolute JSON file> | --stdin) [--output <absolute new file>] [--apply] [--timeout-ms <1..60000>] [--concurrency <1..8>] [--json]\n'
      + 'Input is {"version":1,"requests":[<envelope>...]} with 1..16 requests (at most 256 KiB). Without --apply the batch is\n'
      + 'validated and routing metadata is shown; no posts are made. Apply posts every request under one shared deadline.\n'
      + '--stdin reads one UTF-8 JSON batch, requires EOF, and shares the timeout deadline with execution.\n'
      + 'Routing labels and correlation are untrusted; reply bodies are never executed.\n'
      + '--output saves the sanitized JSON report in a new private file under a private directory.\n'
      + 'Handled SIGINT/SIGTERM save partial results; abrupt process death can leave an empty reservation without a report.');
    return 0;
  }
  const values: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json' && !json) { json = true; continue; }
    if (arg === '--apply' && !apply) { apply = true; continue; }
    if (arg === '--stdin' && !stdin) { stdin = true; continue; }
    const match = /^(--file|--output|--timeout-ms|--concurrency)(?:=(.*))?$/.exec(arg);
    if (!match || Object.hasOwn(values, match[1]!)) return emit(report('invalid-input'));
    const value = match[2] ?? args[++i];
    if (!value || value.startsWith('--')) return emit(report('invalid-input'));
    values[match[1]!] = value;
  }
  const number = (value: string | undefined): number => value && /^\d+$/.test(value) ? Number(value) : NaN;
  const timeout = values['--timeout-ms'] === undefined ? BUS_SCATTER_DEFAULT_TIMEOUT_MS : number(values['--timeout-ms']);
  const concurrency = values['--concurrency'] === undefined ? BUS_SCATTER_DEFAULT_CONCURRENCY : number(values['--concurrency']);
  const file = values['--file'];
  if (stdin === (file !== undefined) || file !== undefined && !isAbsolute(file) ||
      values['--output'] !== undefined && (!isAbsolute(values['--output']) || resolve(values['--output']) !== values['--output'] ||
        file !== undefined && values['--output'] === resolve(file)) ||
      !Number.isSafeInteger(timeout) || timeout < BUS_SCATTER_MIN_TIMEOUT_MS || timeout > BUS_SCATTER_MAX_TIMEOUT_MS ||
      !Number.isSafeInteger(concurrency) || concurrency < BUS_SCATTER_MIN_CONCURRENCY || concurrency > BUS_SCATTER_MAX_CONCURRENCY) {
    return emit(report('invalid-input'));
  }
  if (!stdin && values['--output'] !== undefined) {
    try { reservation = reserveOutput(resolve(values['--output'])); }
    catch { return emit(report('invalid-input')); }
  }
  const controller = new AbortController(), stop = (): void => controller.abort();
  deps.signal?.addEventListener('abort', stop, { once: true });
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    if (deps.signal?.aborted) stop();
    if (controller.signal.aborted) return emit(report('cancelled'));
    const deadline = start + timeout;
    let text: string;
    if (stdin) {
      const input = await readInput(deps.input ?? process.stdin, deadline, controller.signal);
      if (controller.signal.aborted) return emit(report('cancelled'));
      if (input === null) return emit(report('invalid-input'));
      text = input;
    } else {
      const path = file!;
      let read = readStableRegularFile(path, { anchorPath: dirname(path), maxFileBytes: BUS_SCATTER_MAX_BYTES, remainingBytes: BUS_SCATTER_MAX_BYTES });
      while (!read.ok && read.reason === 'changed-during-read') {
        const remaining = deadline - performance.now();
        if (remaining <= 0) return emit(report('invalid-input'));
        try { await delay(Math.min(BUS_SCATTER_INTERVAL_MS, remaining), undefined, { signal: controller.signal }); }
        catch { return emit(report('cancelled')); }
        read = readStableRegularFile(path, { anchorPath: dirname(path), maxFileBytes: BUS_SCATTER_MAX_BYTES, remainingBytes: BUS_SCATTER_MAX_BYTES });
      }
      if (!read.ok) return emit(report('invalid-input'));
      text = read.text;
    }
    const parsed = parseBusScatterFile(text);
    if (!parsed.ok) return emit(report('invalid-input'));
    if (stdin && performance.now() >= deadline) return emit(report('invalid-input'));
    if (stdin && values['--output'] !== undefined) {
      try { reservation = reserveOutput(resolve(values['--output'])); }
      catch { return emit(report('invalid-input')); }
    }
    const invocation = { list: deps.list, append: deps.append, request: deps.request, signal: controller.signal, startedAt: start };
    return emit(apply
      ? await scatterBusRequests(parsed.requests, timeout, concurrency, options, invocation)
      : previewBusScatter(parsed.requests, timeout, concurrency, invocation));
  } finally {
    deps.signal?.removeEventListener('abort', stop);
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
    if (reservation) { closeSync(reservation.fd); removeReservation(reservation); }
  }
}
