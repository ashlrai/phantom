#!/usr/bin/env -S npx tsx
/* global process, AbortController, AbortSignal */
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { validateBusEnvelope } from '../../src/core/fleet/bus-envelope.js';
import { appendBusInbox, type BusInboxOptions } from '../../src/core/fleet/bus-inbox.js';
import { getFleetJobDetail, isFleetJobId } from '../../src/core/fleet/runs-job-detail.js';
import { getFleetJobChanges } from '../../src/core/fleet/runs-job-changes.js';

const MAX_TTL = 30 * 24 * 60 * 60 * 1000;
const READ_TIMEOUT_MS = 15_000;
const USAGE = 'usage: --job ID --to ADDRESS --from ADDRESS --id MESSAGEID --ttl-ms N';

export interface PostWorkerEvidenceDependencies {
  readDetail?: typeof getFleetJobDetail;
  readChanges?: typeof getFleetJobChanges;
  append?: typeof appendBusInbox;
  inboxOptions?: BusInboxOptions;
  now?: () => number;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
  write?: (text: string) => void;
}

/** Take one bounded snapshot and attempt one append; never retry a post implicitly. */
export async function runPostWorkerEvidence(args: readonly string[], deps: PostWorkerEvidenceDependencies = {}): Promise<number> {
  const write = deps.write ?? (text => process.stdout.write(text));
  const emit = (value: unknown, code: number) => { write(`${JSON.stringify(value)}\n`); return code; };
  if (args.length === 1 && args[0] === '--help') return emit({ usage: USAGE }, 0);
  const values = new Map<string, string>();
  const keys = ['--job', '--to', '--from', '--id', '--ttl-ms'];
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]!, value = args[i + 1];
    if (!keys.includes(key) || value === undefined || values.has(key)) return emit({ error: USAGE }, 2);
    values.set(key, value);
  }
  const job = values.get('--job') ?? '', ttlText = values.get('--ttl-ms') ?? '';
  const ttl = Number(ttlText);
  if (values.size !== keys.length || !isFleetJobId(job) || !/^[1-9][0-9]*$/.test(ttlText) || !Number.isSafeInteger(ttl) || ttl > MAX_TTL) {
    return emit({ error: USAGE }, 2);
  }
  // Validate transport fields before any potentially expensive reads.
  const initial = validateBusEnvelope({ id: values.get('--id'), from: values.get('--from'), to: values.get('--to'), priority: 'P2', ttl, body: null });
  if (!initial.ok) return emit({ error: 'invalid-envelope', issues: initial.issues }, 2);

  const timer = new AbortController();
  const onAbort = () => timer.abort();
  if (deps.signal?.aborted) return emit({ error: 'interrupted' }, 130);
  deps.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const wait = deps.wait ?? ((ms: number, signal: AbortSignal) => delay(ms, undefined, { signal }));
    const timeout = wait(READ_TIMEOUT_MS, timer.signal).then(() => { throw new Error('timeout'); });
    const changes = (deps.readChanges ?? getFleetJobChanges)(job).catch(() => null);
    const [detail, change] = await Promise.race([
      Promise.all([(deps.readDetail ?? getFleetJobDetail)(job), changes]), timeout,
    ]);
    if (deps.signal?.aborted) return emit({ error: 'interrupted' }, 130);
    if (detail.job !== job || (change && change.job !== job)) return emit({ error: 'job-mismatch' }, 1);
    // The publisher's free text is untrusted. Only a plain GitHub PR URL is safe to forward.
    const url = detail.publish?.prUrl ?? null;
    const prUrl = url && /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]*$/.test(url) && url.length <= 512 ? url : null;
    const available = change?.state === 'live' && !change.truncated;
    const checked = validateBusEnvelope({
      id: values.get('--id'), from: values.get('--from'), to: values.get('--to'), priority: 'P2', ttl,
      body: {
        schema: 'fleet.job.evidence.v1', jobId: job, state: detail.state, prUrl,
        sources: detail.sources,
        changes: { state: change?.state ?? 'unavailable', truncated: change?.truncated ?? null, totals: available ? change.totals : null },
      },
    });
    if (!checked.ok) return emit({ error: 'invalid-envelope', issues: checked.issues }, 2);
    const post = (deps.append ?? appendBusInbox)(checked.value, { ...deps.inboxOptions, ...(deps.now ? { now: deps.now } : {}) });
    if (post.status === 'posted' || post.status === 'duplicate') return emit(post, 0);
    return emit(post, post.status === 'retryable' ? 3 : post.status === 'full' ? 4 : post.status === 'conflict' ? 5 : 1);
  } catch {
    return emit({ error: deps.signal?.aborted ? 'interrupted' : 'evidence-unavailable' }, deps.signal?.aborted ? 130 : 1);
  } finally {
    timer.abort();
    deps.signal?.removeEventListener('abort', onAbort);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try { process.exitCode = await runPostWorkerEvidence(process.argv.slice(2), { signal: controller.signal }); }
  finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}
