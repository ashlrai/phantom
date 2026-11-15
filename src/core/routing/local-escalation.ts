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
 *
 * Endpoint locality is judged from the URL literal only; DNS is not resolved.
 * Public names that resolve to loopback (localtest.me, *.nip.io) are not caught
 * here. Runtime enforcement belongs to the call-site PR and network policy.
 * The `llama` and `mlx` id prefixes also refuse hosted Llama/MLX providers
 * (fail closed); those need an explicit allow later if they should hold authority.
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

// Non-public IPv4 ranges: unspecified 0/8, 10/8, CGNAT 100.64/10, loopback 127/8, link-local 169.254/16,
// 172.16/12, 192.168/16, benchmark 198.18/15, multicast 224/4, reserved 240/4 (includes broadcast).
const PRIVATE_V4: ReadonlyArray<[number, number]> = [
  [0x00000000, 8], [0x0a000000, 8], [0x64400000, 10], [0x7f000000, 8], [0xa9fe0000, 16],
  [0xac100000, 12], [0xc0a80000, 16], [0xc6120000, 15], [0xe0000000, 4], [0xf0000000, 4],
];

function v4IsPublic(n: number): boolean {
  return !PRIVATE_V4.some(([net, bits]) => (n >>> (32 - bits)) === (net >>> (32 - bits)));
}

/** Eight 16-bit words of a valid IPv6 literal (embedded dotted IPv4 allowed). */
function v6Words(host: string): number[] {
  const m = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(host);
  const v6 = m ? m[1] + m[2].split('.').reduce((acc, o, i) => acc + (i % 2 ? '' : (i ? ':' : '')) + Number(o).toString(16).padStart(2, '0'), '') : host;
  const [head, tail] = v6.split('::');
  const parse = (part?: string): number[] => (part ? part.split(':').map((w) => parseInt(w, 16)) : []);
  const h = parse(head);
  const t = tail === undefined ? [] : parse(tail);
  return [...h, ...new Array<number>(8 - h.length - t.length).fill(0), ...t];
}

function v6IsPublic(host: string): boolean {
  const w = v6Words(host);
  const v4 = (hi: number, lo: number): boolean => v4IsPublic(hi * 65536 + lo);
  if (w.slice(0, 4).every((x) => x === 0)) {
    // ::/96 (IPv4-compatible, ::, ::1) and ::ffff:0:0/96 (mapped) check the embedded IPv4; other forms fail closed.
    return w[4] === 0 && (w[5] === 0 || w[5] === 0xffff) && v4(w[6], w[7]);
  }
  if (w[0] < 0x100) return w[0] === 0x64 && w[1] === 0xff9b && v4(w[6], w[7]); // reserved ::/8; only NAT64 64:ff9b::/96 and 64:ff9b:1::/48 pass, by embedded IPv4
  if (w[0] === 0x2002) return v4(w[1], w[2]); // 6to4
  // ULA fc00::/7, link-local fe80::/10, site-local fec0::/10, multicast ff00::/8.
  return (w[0] & 0xfe00) !== 0xfc00 && (w[0] & 0xff80) !== 0xfe80 && (w[0] & 0xff00) !== 0xff00;
}

/** Pure. True only for a routable public host literal (DNS is not resolved). */
export function isPublicHost(raw: string): boolean {
  const host = raw.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.+$/, '');
  if (host === '') return false;
  const ip = isIP(host);
  if (ip === 4) return v4IsPublic(host.split('.').reduce((n, o) => n * 256 + Number(o), 0));
  if (ip === 6) return v6IsPublic(host);
  if (!host.includes('.')) return false; // single-label names are LAN or local
  return !/(^|\.)(localhost|localdomain|local|internal)$/.test(host);
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

