import { dirname, isAbsolute } from 'node:path';
import { performance } from 'node:perf_hooks';
import { type BusInboxOptions } from '../core/fleet/bus-inbox.js';
import { BUS_SCATTER_DEFAULT_CONCURRENCY, BUS_SCATTER_DEFAULT_TIMEOUT_MS, BUS_SCATTER_INTERVAL_MS,
  BUS_SCATTER_MAX_BYTES, BUS_SCATTER_MAX_CONCURRENCY, BUS_SCATTER_MAX_TIMEOUT_MS, BUS_SCATTER_MIN_CONCURRENCY,
  BUS_SCATTER_MIN_TIMEOUT_MS, parseBusScatterFile, type ScatterDependencies,
  type ScatterStatus } from '../core/fleet/bus-scatter-request.js';
import { BUS_SCATTER_RETRY_MAX_REPORT_BYTES, parseBusScatterRetryFile, previewBusScatterRetry,
  retryBusScatter, type BusScatterRetryReport } from '../core/fleet/bus-scatter-retry.js';
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

function statusReport(mode: 'preview' | 'apply', status: ScatterStatus, startedAt: number): BusScatterRetryReport {
  return { schema: 'fleet.bus-scatter-retry.v1', mode, status, correlation: 'untrusted-routing-only',
    concurrency: 0, timeoutMs: 0, intervalMs: BUS_SCATTER_INTERVAL_MS,
    elapsedMs: Math.max(0, Math.floor(performance.now() - startedAt)),
    retained: [], retried: [], expired: [],
    counts: { total: 0, retained: 0, retried: 0, replied: 0, expired: 0 }, requests: [], evidence: [] };
}

/** Selection summary plus fresh per-request outcomes; reply bodies stay out of text mode. */
function formatRetryText(report: BusScatterRetryReport): string {
  const counts = report.counts;
  const head = report.mode === 'preview'
    ? `bus-scatter-retry preview: ${counts.retained} retained, ${counts.retried} to retry, ${counts.expired} expired, timeout ${report.timeoutMs}ms`
    : `bus-scatter-retry ${report.status}: ${counts.replied}/${counts.retried} retried replied, ${counts.retained} retained, ${counts.expired} expired in ${report.elapsedMs}ms`;
  return [head, ...report.requests.map(row => {
    const reply = row.result?.reply;
    return `  ${row.id} ${row.from} -> ${row.to} ${row.priority} ttl=${row.ttl} ${row.outcome}` +
      (reply ? ` reply=${reply.envelope.id}` : '');
  })].join('\n');
}

/** Convention-resolved CLI entry: retries only the unreplied rows of a prior scatter. */
export async function cmdFleetBusScatterRetry(args: string[], options: BusInboxOptions = {},
  deps: Dependencies = {}): Promise<number> {
  const start = performance.now(), output = deps.output ?? console.log;
  let json = false, apply = false;
  const emit = (report: BusScatterRetryReport): number => {
    try {
      const safe = sanitizePublicJson(redactFields(report)) as BusScatterRetryReport;
      output(json || report.status === 'invalid-input' ? JSON.stringify(safe) : formatRetryText(safe));
    } catch { return 1; }
    return report.status === 'preview' || report.status === 'all-replied' ? 0
      : report.status === 'invalid-input' ? 2 : 1;
  };
  const report = (status: ScatterStatus): BusScatterRetryReport => statusReport(apply ? 'apply' : 'preview', status, start);
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    output('Usage: ashlr fleet bus-scatter-retry --file <absolute batch JSON> --report <absolute prior report> [--apply] [--timeout-ms <1..60000>] [--concurrency <1..8>] [--json]\n'
      + 'Retries the unreplied rows of a fleet.bus-scatter.v1 run or of a previous\n'
      + 'fleet.bus-scatter-retry.v1 run, so a partially recovered fan-out can be retried\n'
      + 'repeatedly from the immediately previous report. --file is the original\n'
      + '{"version":1,"requests":[...]} batch (at most 256 KiB); --report is the prior run\'s JSON\n'
      + 'report (at most 2 MiB). Both are bounded stable regular files validated fully before any\n'
      + 'post: every scatter row, or every row of a retry report\'s cumulative evidence array,\n'
      + 'must match one batch request\'s id, from, to, priority and ttl exactly once with a\n'
      + 'recognized outcome and (while pending) valid post evidence — mismatched, duplicated,\n'
      + 'missing or incomplete rows refuse the run, as does retry output lacking evidence.\n'
      + 'The report only selects what to retry; it is never execution or completion authority.\n'
      + 'Replied rows are retained across generations; every other live original envelope is\n'
      + 'reposted unchanged — same IDs and TTLs, so transport dedupe applies and late replies\n'
      + 'still correlate. Reply bodies are never executed. Timestamp policy: a retried row\'s\n'
      + 'remaining life is its original TTL minus the validated age of its prior post — bound\n'
      + 'to the live inbox receipt at the recorded post cursor where available, else to the\n'
      + 'earliest-post bound carried in the evidence (for a scatter report, its file mtime\n'
      + 'minus recorded elapsedMs). A later report\'s mtime never refreshes a TTL: a row that\n'
      + 'cannot prove unexpired life is refused rather than reposted and stays refused in later\n'
      + 'generations, and the shared wait never exceeds the shortest remaining life. Rows never\n'
      + 'posted keep their full TTL. Without --apply nothing is posted, and every emitted\n'
      + 'report carries the evidence needed to feed the next retry.');
    return 0;
  }
  const values: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json' && !json) { json = true; continue; }
    if (arg === '--apply' && !apply) { apply = true; continue; }
    const match = /^(--file|--report|--timeout-ms|--concurrency)(?:=(.*))?$/.exec(arg);
    if (!match || Object.hasOwn(values, match[1]!)) return emit(report('invalid-input'));
    const value = match[2] ?? args[++i];
    if (!value || value.startsWith('--')) return emit(report('invalid-input'));
    values[match[1]!] = value;
  }
  const number = (value: string | undefined): number => value && /^\d+$/.test(value) ? Number(value) : NaN;
  const timeout = values['--timeout-ms'] === undefined ? BUS_SCATTER_DEFAULT_TIMEOUT_MS : number(values['--timeout-ms']);
  const concurrency = values['--concurrency'] === undefined ? BUS_SCATTER_DEFAULT_CONCURRENCY : number(values['--concurrency']);
  const file = values['--file'], reportPath = values['--report'];
  if (!file || !isAbsolute(file) || !reportPath || !isAbsolute(reportPath) ||
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
    const batch = readStableRegularFile(file, { anchorPath: dirname(file),
      maxFileBytes: BUS_SCATTER_MAX_BYTES, remainingBytes: BUS_SCATTER_MAX_BYTES });
    if (!batch.ok) return emit(report('invalid-input'));
    const parsed = parseBusScatterFile(batch.text);
    if (!parsed.ok) return emit(report('invalid-input'));
    const prior = readStableRegularFile(reportPath, { anchorPath: dirname(reportPath),
      maxFileBytes: BUS_SCATTER_RETRY_MAX_REPORT_BYTES, remainingBytes: BUS_SCATTER_RETRY_MAX_REPORT_BYTES });
    if (!prior.ok) return emit(report('invalid-input'));
    const selection = parseBusScatterRetryFile(prior.text, parsed.requests, prior.mtimeMs);
    if (!selection.ok) return emit(report('invalid-input'));
    const invocation = { list: deps.list, append: deps.append, request: deps.request,
      signal: controller.signal, startedAt: start };
    return emit(apply
      ? await retryBusScatter(selection.selection, timeout, concurrency, options, invocation)
      : previewBusScatterRetry(selection.selection, timeout, concurrency, options, invocation));
  } finally {
    deps.signal?.removeEventListener('abort', stop);
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
  }
}
