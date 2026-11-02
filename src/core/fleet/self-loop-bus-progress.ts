/**
 * `fleet-self-loop` bus-progress — writes a compact progress envelope to the
 * existing durable bus after each completed pass.  No second bus is
 * implemented; the module delegates posting to `appendBusInbox` and reads
 * through `listBusInboxAfter`.
 *
 * Opt-in flags (`--bus-to`, `--bus-root`, `--bus-run-id`) must all be
 * present together.  Without them the bus is never touched — ticks remain
 * dry-run unless `--apply`.
 *
 * The bus body is a narrow shape: kind, run-id, pass number, exit-code,
 * state string, consecutiveFailures / nextDelayMs (when failure backoff is
 * enabled).  Raw reports, local paths, or observer exception text are NEVER
 * included.
 */
import { isAbsolute } from 'node:path';
import {
  appendBusInbox,
  type BusInboxOptions,
  type BusInboxPage,
  listBusInboxAfter,
} from './bus-inbox.js';
import { validateBusEnvelope, type BusEnvelope, type BusPriority } from './bus-envelope.js';

// --- Public types ----------------------------------------------------------

/** Optional bus-progress configuration; all fields present = active. */
export interface SelfLoopBusConfig {
  /** Routing label the envelope is delivered to (validated address). */
  to: string;
  /** Absolute path to the bus root (used instead of the default store). */
  root: string;
  /** Deterministic run identifier — part of the message ID. */
  runId: string;
}

/** Parsed bus config validation result. */
export type SelfLoopBusParseResult =
  | { ok: true; value: SelfLoopBusConfig }
  | { ok: false; reason: string };

/** One post attempt back from the bus write seam. */
export type BusPostOutcome =
  | { status: 'posted' | 'duplicate'; id: string; cursor: number }
  | { status: 'invalid' | 'unavailable' | 'retryable' | 'full' | 'conflict' };

// --- Constants -------------------------------------------------------------

/** Default TTL for progress envelopes (1 h). */
const DEFAULT_BUS_TTL_MS = 60 * 60 * 1000;
const DEFAULT_BUS_PRIORITY: BusPriority = 'P2';

// --- Public API ------------------------------------------------------------

/**
 * Validate a group of three flags; all must be present or all absent.
 * Returns a parse result (not an error) so the CLI wrapper can decide.
 */
export function parseBusConfigGroup(
  busTo: string | undefined,
  busRoot: string | undefined,
  busRunId: string | undefined,
): SelfLoopBusParseResult {
  // All absent = bus is not active (existing behavior preserved).
  if (busTo === undefined && busRoot === undefined && busRunId === undefined) {
    return { ok: true, value: null as unknown as SelfLoopBusConfig };
  }
  // Partial group is an error: all three must be present.
  const missing: string[] = [];
  if (busTo === undefined) missing.push('--bus-to');
  if (busRoot === undefined) missing.push('--bus-root');
  if (busRunId === undefined) missing.push('--bus-run-id');
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `Missing bus flags: ${missing.join(', ')}. All three of --bus-to, --bus-root, --bus-run-id are required together.`,
    };
  }
  // At this point, busTo, busRoot, busRunId are all guaranteed strings
  // (the partial-group guard above would have returned).
  const safeTo = busTo!;
  const safeRoot = busRoot!;
  const safeRunId = busRunId!;
  if (!/^[A-Za-z0-9._\-:\/]+$/.test(safeTo) || safeTo.length > 128 || safeTo.length === 0) {
    return { ok: false, reason: '--bus-to must be a printable ASCII token of 1–128 characters.' };
  }
  if (!isAbsolute(safeRoot)) {
    return { ok: false, reason: '--bus-root must be an absolute path.' };
  }
  if (!/^[A-Za-z0-9._\-]+$/.test(safeRunId) || safeRunId.length === 0) {
    return { ok: false, reason: '--bus-run-id must be a non-empty printable ASCII token.' };
  }
  return {
    ok: true,
    value: { to: safeTo, root: safeRoot, runId: safeRunId },
  };
}

/**
 * Build a compact progress envelope from a completed pass.  The body
 * intentionally excludes raw reports, observer exceptions, local paths,
 * and any other sensitive or unbounded data.
 */
export function buildProgressEnvelope(
  cfg: SelfLoopBusConfig,
  pass: number,
  exitCode: number,
  state: string | null,
  consecutiveFailures: number | undefined,
  nextDelayMs: number | undefined,
): BusEnvelope {
  const body: Record<string, unknown> = {
    kind: 'fleet-self-loop-pass',
    runId: cfg.runId,
    pass,
    exitCode,
  };
  if (state !== null) {
    (body as Record<string, unknown>).state = state;
  }
  if (consecutiveFailures !== undefined) {
    (body as Record<string, unknown>).consecutiveFailures = consecutiveFailures;
  }
  if (nextDelayMs !== undefined) {
    (body as Record<string, unknown>).nextDelayMs = nextDelayMs;
  }
  // Deterministic message ID: runId + pass ensures retries deduplicate.
  const id = `${cfg.runId}::pass-${pass}`;
  return {
    id,
    from: 'fleet-self-loop',
    to: cfg.to,
    priority: DEFAULT_BUS_PRIORITY,
    ttl: DEFAULT_BUS_TTL_MS,
    body,
  } as BusEnvelope;
}

/**
 * Post a progress envelope through the existing durable bus transport.
 * Returns a typed outcome; the caller decides whether to continue.
 */
export function postProgressEnvelope(
  envelope: BusEnvelope,
  options: BusInboxOptions = {},
): BusPostOutcome {
  const checked = validateBusEnvelope(envelope);
  if (!checked.ok) return { status: 'invalid' };
  return appendBusInbox(checked.value, options);
}

/**
 * Read back delivered envelopes so tests can verify content.  Returns
 * a typed page (same transport used by the real inbox).
 */
export function readDeliveredEnvelopes(options: BusInboxOptions = {}): BusInboxPage {
  return listBusInboxAfter(0, 100, options);
}
