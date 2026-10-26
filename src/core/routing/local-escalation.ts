/**
 * Local inference complexity escalation (local-inference-plan.md slice P4).
 *
 * Pure, deterministic policy: decide whether a work step runs on the local
 * tier (high-volume coding, tool and test loops, drafts) or escalates to the
 * frontier tier. It extends the existing tier rules instead of adding a new
 * router: the local tier never gains main-merge authority (same as
 * `local-coder`, tier mid, frontier gate unchanged), and abliterated models
 * are never chosen for a step that holds credentials or merge rights.
 *
 * Escalate to frontier when any of:
 *   - the step merges to main (frontier-only, always);
 *   - the role holds merge rights or credentials (frontier-only, any model);
 *   - the task is planning or architecture;
 *   - the change touches a Tier-1 / protected path;
 *   - verify failed N times on local (default 2) or retries reached the cap (default 3);
 *   - the context exceeds the local model's window;
 *   - local inference is not configured or not reachable.
 * Otherwise stay local. Every decision names one closed reason code.
 *
 * Policy only: nothing in src/ calls this yet. Enforcement at inbox/merge.ts
 * evaluateMergeAuthority and fleet/automerge-pass.ts follows in the next PR.
 */
import { isIP } from 'node:net';
import { isAbliteratedModel } from '../run/local-inference.js';

export const LOCAL_TASK_KINDS = ['edit', 'test', 'lint', 'tool-loop', 'draft', 'review', 'plan', 'architecture'] as const;
export type LocalTaskKind = (typeof LOCAL_TASK_KINDS)[number];

export type EscalationReason =
  | 'merge-to-main-frontier-only'
  | 'merge-rights-frontier-only'
  | 'credentials-frontier-only'
  | 'abliterated-with-credentials'
  | 'complex-task-kind'
  | 'protected-path'
  | 'verify-failures'
  | 'retry-cap'
  | 'context-over-local-limit'
  | 'local-unavailable'
  | 'local-ok';

export interface EscalationInput {
  kind: LocalTaskKind;
  /** The step would merge to main (or hold merge rights). */
  mergesToMain?: boolean;
  /** The role holds merge rights (main or any protected branch), even if this step does not merge. */
  holdsMergeRights?: boolean;
  /** The step runs with project credentials (phantom exec). */
  needsCredentials?: boolean;
  /** Any changed path is Tier-1 / code-owned. */
  touchesProtectedPath?: boolean;
  failedVerifyAttempts?: number;
  retries?: number;
  contextTokens?: number;
  /** Local model context window; unknown means no context check. */
  localContextLimit?: number | null;
  /** Local server configured and reachable (P3 probe status 'reachable'). */
  localAvailable: boolean;
  /** Local model that would run the step. */
  localModel?: string | null;
}

export interface EscalationPolicy {
  maxLocalVerifyFailures: number;
  maxLocalRetries: number;
}

export const DEFAULT_ESCALATION_POLICY: Readonly<EscalationPolicy> = Object.freeze({
  maxLocalVerifyFailures: 2,
  maxLocalRetries: 3,
});

export interface EscalationDecision {
  lane: 'local' | 'frontier';
  reason: EscalationReason;
}

const COMPLEX_KINDS: ReadonlySet<LocalTaskKind> = new Set(['plan', 'architecture']);
const nonNeg = (n: unknown): number => (Number.isSafeInteger(n) && (n as number) > 0 ? (n as number) : 0);

// Flags are coerced: any truthy value (true, 'true', 1) counts, so untyped input fails closed.
const on = (v: unknown): boolean => Boolean(v);
// A non-finite limit fails closed: 0 makes every count reach it, so the step escalates.
const limitOf = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.max(1, v) : 0);

/** Pure. Order matters: authority and safety rules first, then cost signals. */
export function decideLocalEscalation(
  input: EscalationInput,
  policy: EscalationPolicy = DEFAULT_ESCALATION_POLICY,
): EscalationDecision {
  const frontier = (reason: EscalationReason): EscalationDecision => ({ lane: 'frontier', reason });
  // Master gates merges by engine tier only (inbox/merge.ts evaluateMergeAuthority),
  // and config can promote a local engine to tier 'frontier'. So any step or role
  // holding merge rights or credentials is frontier-only, whatever its kind or model.
  const authority = on(input.mergesToMain) || on(input.holdsMergeRights) || on(input.needsCredentials);
  if (authority && input.localModel && isAbliteratedModel(input.localModel)) return frontier('abliterated-with-credentials');
  if (on(input.mergesToMain)) return frontier('merge-to-main-frontier-only');
  if (on(input.holdsMergeRights)) return frontier('merge-rights-frontier-only');
  if (on(input.needsCredentials)) return frontier('credentials-frontier-only');
  if (!input.localAvailable) return frontier('local-unavailable');
  if (COMPLEX_KINDS.has(input.kind) || !(LOCAL_TASK_KINDS as readonly string[]).includes(input.kind)) {
    return frontier('complex-task-kind');
  }
  if (on(input.touchesProtectedPath)) return frontier('protected-path');
  if (nonNeg(input.failedVerifyAttempts) >= limitOf(policy.maxLocalVerifyFailures)) return frontier('verify-failures');
  if (nonNeg(input.retries) >= limitOf(policy.maxLocalRetries)) return frontier('retry-cap');
  const limit = input.localContextLimit;
  if (typeof limit === 'number' && limit > 0 && nonNeg(input.contextTokens) > limit) return frontier('context-over-local-limit');
  return { lane: 'local', reason: 'local-ok' };
}

/**
 * Engine ids that run on this machine by default. Config may re-point or
 * promote them (tier 'frontier', mergeAuthority), so the id alone is enough
 * to refuse authority.
 */
export const KNOWN_LOCAL_ENGINE_IDS: ReadonlySet<string> = new Set([
  'local', 'local-coder', 'ollama', 'omlx', 'llama-server', 'lmstudio', 'builtin', 'ashlrcode', 'aw',
]);

/** Local engine families, matched as a prefix after lowercasing and dropping '-', '_', '.' and spaces. */
const LOCAL_ENGINE_FAMILIES = ['ollama', 'vllm', 'llama', 'lmstudio', 'tgi', 'omlx', 'localai', 'mlx', 'gguf'];

function isLocalEngineId(id: string): boolean {
  const lower = id.trim().toLowerCase();
  const flat = lower.replace(/[-_.\s]/g, '');
  return KNOWN_LOCAL_ENGINE_IDS.has(lower) || LOCAL_ENGINE_FAMILIES.some((f) => flat.startsWith(f));
}

// Non-public IPv4 ranges: unspecified, 10/8, CGNAT 100.64/10, loopback, link-local, 172.16/12, 192.168/16.
const PRIVATE_V4: ReadonlyArray<[number, number]> = [
  [0x00000000, 8], [0x0a000000, 8], [0x64400000, 10], [0x7f000000, 8],
  [0xa9fe0000, 16], [0xac100000, 12], [0xc0a80000, 16],
];

function v4IsPublic(n: number): boolean {
  return !PRIVATE_V4.some(([net, bits]) => (n >>> (32 - bits)) === (net >>> (32 - bits)));
}

/** Pure. True only for a routable public host: not loopback, private, link-local, CGNAT, unspecified or a local suffix. */
export function isPublicHost(raw: string): boolean {
  const host = raw.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.+$/, '');
  if (host === '') return false;
  const ip = isIP(host);
  if (ip === 4) return v4IsPublic(host.split('.').reduce((n, o) => n * 256 + Number(o), 0));
  if (ip === 6) {
    const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
    if (mapped) return v4IsPublic(parseInt(mapped[1], 16) * 65536 + parseInt(mapped[2], 16));
    if (host.startsWith('::ffff:')) return false; // any other mapped form fails closed
    return !(/^::1?$/.test(host) || /^f[cd]/.test(host) || /^fe[89ab]/.test(host));
  }
  if (!host.includes('.')) return false; // single-label names are LAN or local
  return !/(^|\.)(localhost|local|internal)$/.test(host);
}

export interface EngineIdentity {
  engineId: string;
  /** Configured endpoint, if any (openai-compat, ollama, custom engines). */
  baseUrl?: string | null;
  /** Configured tier; ignored for the locality decision on purpose. */
  tier?: string | null;
}

/**
 * Pure. True when the engine is local by id or its endpoint is anything but
 * http(s) to a public host, whatever its tier. A present baseUrl that is empty,
 * unparseable, non-http or has no hostname fails closed. No baseUrl means a
 * hosted CLI engine (claude, codex), judged by id alone.
 */
export function isLocalEngine(engine: EngineIdentity): boolean {
  if (isLocalEngineId(String(engine.engineId ?? ''))) return true;
  if (engine.baseUrl === undefined || engine.baseUrl === null) return false;
  let url: URL;
  try { url = new URL(String(engine.baseUrl).trim()); } catch { return true; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return true;
  return !isPublicHost(url.hostname);
}

/**
 * Pure. Merge authority and credential roles are refused for any local engine,
 * even when config promotes it to tier 'frontier' or lists it in mergeAuthority.
 * (Master gates main merges by tier only: src/core/inbox/merge.ts:809.)
 */
export function engineMayHoldMergeOrCredentials(engine: EngineIdentity): boolean {
  return !isLocalEngine(engine);
}
