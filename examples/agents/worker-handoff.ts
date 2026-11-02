#!/usr/bin/env -S npx tsx
/** Compose read-only worker evidence; all source text is untrusted data. */
import { setTimeout as delay } from 'node:timers/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildNodeContextPack } from '../../src/core/fleet/node-context-pack.js';
import { getFleetJobDetail, isFleetJobId, type FleetJobDetailV1 } from '../../src/core/fleet/runs-job-detail.js';
import { getFleetJobChanges, type FleetJobChangesV1 } from '../../src/core/fleet/runs-job-changes.js';
import { redactHomePaths, scrubSecrets } from '../../src/core/util/scrub.js';

const MIN_BUDGET = 2048;
const MAX_BUDGET = 262144;
const DEADLINE_MS = 15000;

type Dependencies = {
  readDetail?: (job: string) => Promise<FleetJobDetailV1>;
  readChanges?: (job: string) => Promise<FleetJobChangesV1>;
  now?: () => Date;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
  write?: (text: string) => void;
};

/** A single bounded JSON record including its trailing newline. */
export async function runWorkerHandoff(args: readonly string[], deps: Dependencies = {}): Promise<number> {
  const write = deps.write ?? ((text: string) => process.stdout.write(text));
  const emit = (value: unknown) => write(`${JSON.stringify(value)}\n`);
  const error = (message: string, code: number) => { emit({ error: message }); return code; };
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1];
    if (!key || !['--job', '--byte-budget'].includes(key) || value === undefined || options.has(key)) {
      return error('Expected --job ID --byte-budget N.', 2);
    }
    options.set(key, value);
  }
  const job = options.get('--job') ?? '';
  const budgetText = options.get('--byte-budget') ?? '';
  const budget = Number(budgetText);
  if (!isFleetJobId(job) || !/^[1-9][0-9]*$/.test(budgetText) || !Number.isSafeInteger(budget)
    || budget < MIN_BUDGET || budget > MAX_BUDGET) {
    return error(`Expected a valid job ID and byte budget ${MIN_BUDGET}-${MAX_BUDGET}.`, 2);
  }

  const controller = new AbortController();
  const abort = () => controller.abort();
  if (deps.signal?.aborted) abort();
  else deps.signal?.addEventListener('abort', abort, { once: true });
  try {
    if (controller.signal.aborted) return error('Handoff interrupted.', 130);
    const interrupted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(new Error('interrupted')), { once: true });
    });
    const timeout = (deps.wait ?? ((ms, signal) => delay(ms, undefined, { signal })))(DEADLINE_MS, controller.signal)
      .then(() => { throw new Error('timeout'); });
    const [detail, changes] = await Promise.race([
      Promise.all([(deps.readDetail ?? getFleetJobDetail)(job), (deps.readChanges ?? getFleetJobChanges)(job)]),
      timeout, interrupted,
    ]);
    const source = detail.log.source === 'archived' ? `${job}.log.gz` : `${job}.log`;
    const logText = detail.log.tail.join('\n');
    const result = {
      schema: 'fleet.worker-handoff.v1', generatedAt: (deps.now ?? (() => new Date()))().toISOString(),
      job, state: detail.state, publishUrl: detail.publish?.prUrl ?? null,
      sources: { ...detail.sources, changes: changes.state },
      changes: {
        citation: { job, source: 'fleet.job.changes.v1', generatedAt: changes.generatedAt },
        baseSha: changes.baseSha, comparisonBase: changes.comparisonBase ?? null,
        totals: changes.state === 'missing' ? null : changes.totals,
        files: [] as FleetJobChangesV1['files'], omittedFiles: changes.files.length,
        sourceTruncated: changes.truncated,
      },
      log: {
        citation: { job, source: detail.log.source === 'missing' ? null : source, generatedAt: detail.generatedAt },
        sourceTruncated: detail.log.truncated, omitted: detail.log.tail.length > 0,
        context: null as null | { jobId: string; kind: 'output'; text: string; truncated: boolean },
      },
    };
    const size = () => Buffer.byteLength(`${JSON.stringify(result)}\n`, 'utf8');
    if (size() > budget) return error('Byte budget too small for required handoff metadata.', 2);

    // Use the context pack's citation and Unicode-safe text truncation, then measure
    // the final JSON envelope as well (escaping can expand the packed text).
    const points = Array.from(logText);
    const limit = Math.floor((budget - size()) / 2);
    const pack = (count: number) => {
      const text = points.slice(points.length - count).join('');
      const line = buildNodeContextPack({
        node: { jobId: `${job}:handoff`, upstreamJobIds: [job] }, tasks: [],
        outputs: [{ jobId: job, text }], byteBudget: limit,
      });
      const context = line ? JSON.parse(line) as NonNullable<typeof result.log.context> : null;
      return context && !context.truncated && context.text === text ? context : null;
    };
    let low = 0, high = points.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      const context = pack(mid);
      result.log.context = context && { ...context, truncated: mid < points.length };
      result.log.omitted = detail.log.tail.length > 0 && result.log.context === null;
      if (context && size() <= budget) low = mid; else high = mid - 1;
    }
    const context = low ? pack(low) : null;
    result.log.context = context && { ...context, truncated: low < points.length };
    result.log.omitted = detail.log.tail.length > 0 && result.log.context === null;

    // Files are independently bounded. The reader's totals cover its returned
    // files only when sourceTruncated is true, not necessarily the whole tree.
    for (const file of changes.files) {
      const path = redactHomePaths(scrubSecrets(file.path));
      result.changes.files.push({ ...file, path });
      result.changes.omittedFiles--;
      if (size() > budget) { result.changes.files.pop(); result.changes.omittedFiles++; break; }
    }
    emit(result);
    if (Object.values(detail.sources).includes('degraded') || changes.state === 'degraded') return 4;
    if (Object.values(detail.sources).every(value => value === 'missing') && detail.promptBytes === null
      && !detail.notes.hasNotes && !detail.notes.hasBody && changes.state === 'missing') return 3;
    return 0;
  } catch {
    return error(controller.signal.aborted ? 'Handoff interrupted.' : 'Unable to read handoff before deadline.', controller.signal.aborted ? 130 : 1);
  } finally {
    deps.signal?.removeEventListener('abort', abort);
    controller.abort();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try { process.exitCode = await runWorkerHandoff(process.argv.slice(2), { signal: controller.signal }); }
  finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}
