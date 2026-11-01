import { dirname, isAbsolute } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { type BusInboxOptions } from '../core/fleet/bus-inbox.js';
import { BUS_SCATTER_DEFAULT_CONCURRENCY, BUS_SCATTER_DEFAULT_TIMEOUT_MS, BUS_SCATTER_INTERVAL_MS,
  BUS_SCATTER_MAX_BYTES, BUS_SCATTER_MAX_CONCURRENCY, BUS_SCATTER_MAX_TIMEOUT_MS, BUS_SCATTER_MIN_CONCURRENCY,
  BUS_SCATTER_MIN_TIMEOUT_MS, parseBusScatterFile, previewBusScatter, scatterBusRequests,
  type BusScatterReport, type ScatterDependencies } from '../core/fleet/bus-scatter-request.js';
import { sanitizePublicJson } from '../core/util/public-json.js';
import { readStableRegularFile } from '../core/util/stable-file-read.js';

interface Dependencies extends ScatterDependencies { output?: (text: string) => void }

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
  let json = false, apply = false;
  const emit = (report: BusScatterReport): number => {
    try {
      const safe = sanitizePublicJson(redactFields(report)) as BusScatterReport;
      output(json || report.status === 'invalid-input' ? JSON.stringify(safe) : formatScatterText(safe));
    } catch { return 1; }
    return report.status === 'preview' || report.status === 'all-replied' ? 0 : report.status === 'invalid-input' ? 2 : 1;
  };
  const report = (status: BusScatterReport['status']): BusScatterReport => statusReport(apply ? 'apply' : 'preview', status, start);
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    output('Usage: ashlr fleet bus-scatter --file <absolute JSON file> [--apply] [--timeout-ms <1..60000>] [--concurrency <1..8>] [--json]\n'
      + 'Input is {"version":1,"requests":[<envelope>...]} with 1..16 requests (at most 256 KiB). Without --apply the batch is\n'
      + 'validated and routing metadata is shown; no posts are made. Apply posts every request under one shared deadline.\n'
      + 'Routing labels and correlation are untrusted; reply bodies are never executed.');
    return 0;
  }
  const values: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json' && !json) { json = true; continue; }
    if (arg === '--apply' && !apply) { apply = true; continue; }
    const match = /^(--file|--timeout-ms|--concurrency)(?:=(.*))?$/.exec(arg);
    if (!match || Object.hasOwn(values, match[1]!)) return emit(report('invalid-input'));
    const value = match[2] ?? args[++i];
    if (!value || value.startsWith('--')) return emit(report('invalid-input'));
    values[match[1]!] = value;
  }
  const number = (value: string | undefined): number => value && /^\d+$/.test(value) ? Number(value) : NaN;
  const timeout = values['--timeout-ms'] === undefined ? BUS_SCATTER_DEFAULT_TIMEOUT_MS : number(values['--timeout-ms']);
  const concurrency = values['--concurrency'] === undefined ? BUS_SCATTER_DEFAULT_CONCURRENCY : number(values['--concurrency']);
  const file = values['--file'];
  if (!file || !isAbsolute(file) ||
      !Number.isSafeInteger(timeout) || timeout < BUS_SCATTER_MIN_TIMEOUT_MS || timeout > BUS_SCATTER_MAX_TIMEOUT_MS ||
      !Number.isSafeInteger(concurrency) || concurrency < BUS_SCATTER_MIN_CONCURRENCY || concurrency > BUS_SCATTER_MAX_CONCURRENCY) {
    return emit(report('invalid-input'));
  }
  const controller = new AbortController(), stop = (): void => controller.abort();
  deps.signal?.addEventListener('abort', stop, { once: true });
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    if (deps.signal?.aborted) stop();
    if (controller.signal.aborted) return emit(report('cancelled'));
    const deadline = start + timeout;
    let read = readStableRegularFile(file, { anchorPath: dirname(file), maxFileBytes: BUS_SCATTER_MAX_BYTES, remainingBytes: BUS_SCATTER_MAX_BYTES });
    while (!read.ok && read.reason === 'changed-during-read') {
      const remaining = deadline - performance.now();
      if (remaining <= 0) return emit(report('invalid-input'));
      try { await delay(Math.min(BUS_SCATTER_INTERVAL_MS, remaining), undefined, { signal: controller.signal }); }
      catch { return emit(report('cancelled')); }
      read = readStableRegularFile(file, { anchorPath: dirname(file), maxFileBytes: BUS_SCATTER_MAX_BYTES, remainingBytes: BUS_SCATTER_MAX_BYTES });
    }
    if (!read.ok) return emit(report('invalid-input'));
    const parsed = parseBusScatterFile(read.text);
    if (!parsed.ok) return emit(report('invalid-input'));
    const invocation = { list: deps.list, append: deps.append, request: deps.request, signal: controller.signal, startedAt: start };
    return emit(apply
      ? await scatterBusRequests(parsed.requests, timeout, concurrency, options, invocation)
      : previewBusScatter(parsed.requests, timeout, concurrency, invocation));
  } finally {
    deps.signal?.removeEventListener('abort', stop);
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
  }
}
