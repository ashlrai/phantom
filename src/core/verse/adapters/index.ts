/**
 * Verse adapters — one per vendor CLI. An adapter knows two things:
 *
 *   1. how to build the argv/env/stdin for ONE turn of a session
 *      (`buildLaunch`), and
 *   2. how to turn the CLI's stdout lines into normalized `VerseEvent`s
 *      (`createParser`).
 *
 * Adapters are pure: they never spawn, never touch the filesystem and never
 * read secrets. Events they produce omit `seq`/`at` — the session engine
 * stamps those when it appends to the durable store. Parsers must never throw
 * on a garbage line; unknown or malformed lines are dropped.
 */

import type { VerseEngine, VerseEvent, VerseSession, VerseTurnLaunch } from '../types.js';
import type { VerseSeatLaunch } from '../session-engine.js';
import type { ProviderBackend, ProviderCapabilities } from '../../providers.js';
import { claudeAdapter } from './claude.js';
import { codexAdapter } from './codex.js';
import { grokAdapter } from './grok.js';
import { devinAdapter } from './devin.js';

/** Distributive Omit — `Omit` on a union would collapse it to the common keys. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A VerseEvent before the engine stamps `seq` and `at`. */
export type VerseParsedEvent = DistributiveOmit<VerseEvent, 'seq' | 'at'>;

export interface VerseTurnParser {
  /** Feed one stdout line. Returns zero or more normalized events. */
  push(line: string): VerseParsedEvent[];
  /** Called once after the process exits. Flushes buffered state (e.g. usage). */
  finish(exitCode: number | null): VerseParsedEvent[];
  /** Vendor conversation id observed in the output (codex thread id, claude session id), or null. */
  nativeSessionId(): string | null;
}

/**
 * V3.9 — what a telemetry hook gets. Hooks are the ONE place an adapter may
 * read the filesystem: some CLIs (codex) never put exact per-call context on
 * stdout, only in their own session files. Hooks must be bounded (tail reads,
 * size caps), synchronous, fast, and must never throw.
 */
export interface VerseAdapterTurnContext {
  session: VerseSession;
  launch: VerseSeatLaunch;
  turnId: string;
  /** Epoch ms when the process was spawned. */
  startedAt: number;
  /** Native id observed so far this turn (parser), else the session's. */
  nativeSessionId: string | null;
  /** This turn's parser, for hooks that need what it captured. */
  parser: VerseTurnParser;
  /** Per-turn scratch the hooks own (e.g. a file offset); starts empty. */
  state: Record<string, unknown>;
}

export interface VerseAdapter {
  buildLaunch(session: VerseSession, text: string, launch: VerseSeatLaunch): VerseTurnLaunch;
  /**
   * `session` is additive context for parsers that check the CLI's output
   * against what the launch asked for (claude: the requested model, so an
   * automatic switch surfaces as a `status` event). Older call sites may omit
   * it; adapters that need nothing from it ignore it.
   */
  createParser(turnId: string, session?: VerseSession): VerseTurnParser;
  /**
   * V3.9, optional. Polled every VERSE_TELEMETRY_POLL_MS while a turn runs
   * (live meter). Typically returns `context` events.
   */
  pollTelemetry?(ctx: VerseAdapterTurnContext): VerseParsedEvent[];
  /**
   * V3.9, optional. Called once after the process exits and AFTER the
   * parser's `finish()` events were applied. Typically returns `context` and
   * `compaction` events read from the CLI's own session files.
   */
  afterTurn?(ctx: VerseAdapterTurnContext): VerseParsedEvent[];
  /**
   * 3.15, optional. True when this turn's own launch resolves a `!macro`
   * playbook itself (a Devin cloud chat's first message starts a Devin task,
   * whose launch does — and records the version on the task). The engine then
   * still shows the chip but does not append the block a second time.
   */
  resolvesPlaybooks?(session: VerseSession, launch: VerseSeatLaunch): boolean;
}

export { turnAttachmentDirs, turnAttachmentImages, type VerseTurnExtras } from './turn-extras.js';

/** V3.9 — live telemetry poll interval for adapters that implement `pollTelemetry`. */
export const VERSE_TELEMETRY_POLL_MS = 2_000;

export interface VerseBackend extends VerseAdapter,
  ProviderBackend<VerseSession, VerseSeatLaunch, VerseTurnLaunch, VerseTurnParser> {
  /** Preserve adapter identity for existing consumers (local shares Claude's adapter). */
  readonly adapter: VerseAdapter;
}

function defineBackend(
  id: VerseEngine,
  adapter: VerseAdapter,
  capabilities: ProviderCapabilities,
): VerseBackend {
  return Object.freeze({ ...adapter, adapter, id, capabilities: Object.freeze({ ...capabilities }) });
}

// Exhaustive over VerseEngine, including the existing Grok backend. Capabilities
// describe the wire contract, independent of account, tool access or readiness.
const BACKENDS: Readonly<Record<VerseEngine, VerseBackend>> = Object.freeze({
  claude: defineBackend('claude', claudeAdapter, { streaming: true, resume: true, providerAssignedSessionId: false }),
  codex: defineBackend('codex', codexAdapter, { streaming: true, resume: true, providerAssignedSessionId: true }),
  devin: defineBackend('devin', devinAdapter, { streaming: true, resume: true, providerAssignedSessionId: true }),
  local: defineBackend('local', claudeAdapter, { streaming: true, resume: true, providerAssignedSessionId: false }),
  grok: defineBackend('grok', grokAdapter, { streaming: true, resume: true, providerAssignedSessionId: false }),
});

export function backendFor(engine: VerseEngine): VerseBackend {
  if (!Object.hasOwn(BACKENDS, engine)) throw new Error(`unknown verse engine: ${String(engine)}`);
  return BACKENDS[engine];
}

/** Compatibility seam for existing callers and injected adapters. */
export function adapterFor(engine: VerseEngine): VerseAdapter {
  return backendFor(engine).adapter;
}
