/** fleet_email_outbox_batch_await — bounded wait for up to 50 named reply
 * artifacts to leave `queued` in one call through the isolated fleet MCP
 * server. Results carry per-name state, fixed reason, timedOut/cancelled/
 * sourceFailure and source availability only — evidence, never send authority. */
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readEmailDropConfig } from '../core/comms/email-drop-config.js';
import { awaitEmailOutboxBatch, type BatchResult, type BatchRow } from '../core/comms/email-outbox-batch-await.js';
import {
  DEFAULT_FLEET_EMAIL_OUTBOX_AWAIT_POLL_MS, MAX_FLEET_EMAIL_OUTBOX_AWAIT_MS,
  MAX_FLEET_EMAIL_OUTBOX_AWAIT_POLL_MS, MIN_FLEET_EMAIL_OUTBOX_AWAIT_POLL_MS,
  type FleetEmailOutboxAwaitSourceState,
} from './fleet-email-outbox-await.js';

export const MAX_FLEET_EMAIL_OUTBOX_BATCH_AWAIT_NAMES = 50;

export interface FleetEmailOutboxBatchAwaitArgs {
  /** Distinct exact artifact file names ending in .reply.eml; never paths. */
  names: string[];
  timeoutMs: number;
  pollMs?: number;
}

export interface FleetEmailOutboxBatchAwaitReport {
  schemaVersion: 1;
  snapshotKind: 'local-persisted';
  authority: 'none';
  generatedAt: string;
  /** 'ok' once the saved config resolved to a stat-able outbox directory. */
  sourceState: FleetEmailOutboxAwaitSourceState;
  /** Observed per-name rows in input order; null when the source failed before any poll could run. */
  rows: BatchRow[] | null;
  timedOut: boolean;
  cancelled: boolean;
  sourceFailure: boolean;
}

export interface FleetEmailOutboxBatchAwaitDeps {
  /** Email-drop config root; default ~/.ashlr-runs (test seam). */
  runsDir?: string;
  readConfig?: typeof readEmailDropConfig;
  awaitBatch?: typeof awaitEmailOutboxBatch;
}

/** Bounded exactly like the CLI; unknown keys (dir/root/cwd/send) rejected. */
export function parseFleetEmailOutboxBatchAwaitArgs(args: Record<string, unknown>): FleetEmailOutboxBatchAwaitArgs | null {
  const { names, timeoutMs, pollMs } = args;
  if (Object.keys(args).some(key => !['names', 'timeoutMs', 'pollMs'].includes(key)) ||
    !Array.isArray(names) || names.length < 1 || names.length > MAX_FLEET_EMAIL_OUTBOX_BATCH_AWAIT_NAMES ||
    !names.every((name: unknown) => typeof name === 'string' && name.toLowerCase().endsWith('.reply.eml') &&
      !name.includes('..') && !/[/\\\0]/.test(name)) ||
    new Set(names).size !== names.length ||
    typeof timeoutMs !== 'number' || !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 || timeoutMs > MAX_FLEET_EMAIL_OUTBOX_AWAIT_MS ||
    (pollMs !== undefined && (typeof pollMs !== 'number' || !Number.isSafeInteger(pollMs) ||
      pollMs < MIN_FLEET_EMAIL_OUTBOX_AWAIT_POLL_MS || pollMs > MAX_FLEET_EMAIL_OUTBOX_AWAIT_POLL_MS))) return null;
  return { names: names as string[], timeoutMs, ...(pollMs === undefined ? {} : { pollMs: pollMs as number }) };
}

/** Missing/invalid config and missing/unreadable outbox each report their own
 * sourceState with sourceFailure true and null rows — never an invented
 * observation. The outbox resolves like the CLI: `outboxDir`, else
 * `inboxDir`'s sibling. */
export async function readFleetEmailOutboxBatchAwait(
  input: FleetEmailOutboxBatchAwaitArgs,
  signal?: AbortSignal,
  deps: FleetEmailOutboxBatchAwaitDeps = {},
): Promise<FleetEmailOutboxBatchAwaitReport> {
  const readConfig = deps.readConfig ?? readEmailDropConfig;
  const awaitBatch = deps.awaitBatch ?? awaitEmailOutboxBatch;
  const base = {
    schemaVersion: 1 as const,
    snapshotKind: 'local-persisted' as const,
    authority: 'none' as const,
    generatedAt: new Date().toISOString(),
  };
  const report = (sourceState: FleetEmailOutboxAwaitSourceState, extra: Partial<FleetEmailOutboxBatchAwaitReport>): FleetEmailOutboxBatchAwaitReport =>
    ({ ...base, sourceState, rows: null, timedOut: false, cancelled: false, sourceFailure: false, ...extra });

  if (signal?.aborted) return report('unobserved', { cancelled: true });
  const config = await readConfig(deps.runsDir ?? join(homedir(), '.ashlr-runs'));
  if (signal?.aborted) return report('unobserved', { cancelled: true });
  if (config.state !== 'ok' || !config.config) {
    return report(config.state === 'missing' ? 'missing-config' : 'invalid-config', { sourceFailure: true });
  }
  const outboxDir = config.config.outboxDir ?? join(config.config.inboxDir, '..', 'outbox');
  let sourceState: FleetEmailOutboxAwaitSourceState;
  try {
    sourceState = statSync(outboxDir).isDirectory() ? 'ok' : 'unreadable-outbox';
  } catch (error) {
    sourceState = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing-outbox' : 'unreadable-outbox';
  }
  if (sourceState !== 'ok') return report(sourceState, { sourceFailure: true });

  const result: BatchResult = await awaitBatch({
    dir: outboxDir,
    names: input.names,
    timeoutMs: input.timeoutMs,
    pollMs: input.pollMs ?? DEFAULT_FLEET_EMAIL_OUTBOX_AWAIT_POLL_MS,
    signal: signal ?? new AbortController().signal,
  });
  return report('ok', {
    rows: result.sourceFailure ? null : result.rows,
    timedOut: result.timedOut,
    cancelled: result.cancelled,
    sourceFailure: result.sourceFailure,
  });
}
