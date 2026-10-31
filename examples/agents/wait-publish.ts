#!/usr/bin/env -S npx tsx
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getFleetJobDetail, isFleetJobId, type FleetJobDetailV1 } from '../../src/core/fleet/runs-job-detail.js';

const MAX_TIMEOUT_MS = 3_600_000;
const MAX_INTERVAL_MS = 60_000;
const USAGE = 'Expected --job ID --timeout-ms N --interval-ms N (timeout 1-3600000, interval 1-60000).';

export interface WaitPublishDependencies {
  read?: (job: string) => Promise<FleetJobDetailV1>;
  now?: () => number;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  write?: (text: string) => void;
  signal?: AbortSignal;
}

/** A cancellable timer that removes its listener on both completion and cancellation. */
function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolveWait, reject) => {
    if (signal.aborted) { reject(new Error('aborted')); return; }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolveWait();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(new Error('aborted'));
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Race an operation with cancellation, including readers that do not accept a signal. */
function cancellable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolveOperation, reject) => {
    if (signal.aborted) { void operation.catch(() => {}); reject(new Error('aborted')); return; }
    const onAbort = () => { cleanup(); reject(new Error('aborted')); };
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(value => { cleanup(); resolveOperation(value); }, error => { cleanup(); reject(error); });
  });
}

/** Run without changing process state. The reader and scheduling seams are injectable. */
export async function runWaitPublish(args: readonly string[], deps: WaitPublishDependencies = {}): Promise<number> {
  const emit = (value: unknown) => (deps.write ?? (text => process.stdout.write(text)))(`${JSON.stringify(value)}\n`);
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1];
    if (!key || !['--job', '--timeout-ms', '--interval-ms'].includes(key) || value === undefined || values.has(key)) {
      emit({ error: USAGE }); return 2;
    }
    values.set(key, value);
  }
  const job = values.get('--job') ?? '';
  const timeoutText = values.get('--timeout-ms') ?? '';
  const intervalText = values.get('--interval-ms') ?? '';
  const timeout = Number(timeoutText), interval = Number(intervalText);
  if (!isFleetJobId(job) || !/^[1-9][0-9]*$/.test(timeoutText) || !Number.isSafeInteger(timeout) || timeout > MAX_TIMEOUT_MS
    || !/^[1-9][0-9]*$/.test(intervalText) || !Number.isSafeInteger(interval) || interval > MAX_INTERVAL_MS) {
    emit({ error: USAGE }); return 2;
  }

  const controller = new AbortController();
  const onAbort = () => controller.abort('aborted');
  deps.signal?.addEventListener('abort', onAbort, { once: true });
  if (deps.signal?.aborted) onAbort();
  const timer = setTimeout(() => controller.abort('timeout'), timeout);
  const now = deps.now ?? (() => performance.now());
  const deadline = now() + timeout;
  let result: { code: number; value: object };
  try {
    for (;;) {
      if (controller.signal.aborted) throw new Error('aborted');
      if (now() >= deadline) { controller.abort('timeout'); throw new Error('timeout'); }
      const detail = await cancellable((deps.read ?? getFleetJobDetail)(job), controller.signal);
      if (controller.signal.aborted) throw new Error('aborted');
      if (now() >= deadline) { controller.abort('timeout'); throw new Error('timeout'); }
      if (detail.sources.publish === 'degraded') throw new Error('publish source unavailable');
      if (detail.state === 'published' && detail.sources.publish === 'healthy' && detail.publish?.prUrl) {
        result = { code: 0, value: { job, prUrl: detail.publish.prUrl } };
        break;
      }
      await cancellable((deps.wait ?? wait)(Math.min(interval, deadline - now()), controller.signal), controller.signal);
    }
  } catch {
    const reason = controller.signal.reason;
    result = reason === 'timeout' ? { code: 3, value: { error: 'Timed out waiting for publication.', job } }
      : reason === 'aborted' ? { code: 130, value: { error: 'Wait aborted.', job } }
        : { code: 1, value: { error: 'Unable to read job publication.', job } };
  } finally {
    clearTimeout(timer);
    deps.signal?.removeEventListener('abort', onAbort);
    controller.abort('finished');
  }
  emit(result.value);
  return result.code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    process.exitCode = await runWaitPublish(process.argv.slice(2), { signal: controller.signal });
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}
