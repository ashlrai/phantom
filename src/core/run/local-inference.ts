/**
 * Local inference config and loopback gate (local-inference-plan.md slice P2).
 *
 * `localInference` in ~/.ashlr/config.json selects a local OpenAI-compatible
 * server for the `openai-compat` engine:
 *
 *   "localInference": {
 *     "provider": "ollama" | "omlx" | "openai-compat",
 *     "baseUrl": "http://127.0.0.1:11434/v1",      // optional for ollama/omlx
 *     "models": { "coder": "qwen3.8:27b", "reviewer": "...", "planner": "...",
 *                 "proposalOnly": "name@sha256:<64 hex>" },
 *     "allowRemote": false,                          // default
 *     "allowAbliterated": false                      // default
 *   }
 *
 * Rules:
 *   - Loopback only by default: 127.0.0.1, [::1] and localhost. The same gate
 *     now applies to OPENAI_COMPAT_BASE_URL, which used to accept any URL.
 *   - A non-loopback URL needs `allowRemote: true` in config AND https, and
 *     emits a warning. The environment can never widen this.
 *   - URL checks follow the governed gateway validator (gateway-target.ts):
 *     http/https only, no userinfo, query, fragment, non-canonical host,
 *     dot segments or backslashes. Refusals are closed codes, never the input.
 *   - No phantom placeholder (phm_...) or OAuth-shaped token is ever sent to a
 *     local or opted-in remote URL. ollama/omlx never get a key at all.
 *   - Abliterated or uncensored models are never a default and never allowed
 *     in coder, reviewer or planner (roles that can hold credentials or feed a
 *     merge). Only `proposalOnly` may use one, with `allowAbliterated: true`
 *     and the model pinned by digest.
 * Pure: no I/O, no DNS. Reads env only where a caller passes it.
 */

export const LOCAL_INFERENCE_PROVIDERS = ['ollama', 'omlx', 'openai-compat'] as const;
export type LocalInferenceProvider = (typeof LOCAL_INFERENCE_PROVIDERS)[number];
export const LOCAL_INFERENCE_ROLES = ['coder', 'reviewer', 'planner', 'proposalOnly'] as const;
export type LocalInferenceRole = (typeof LOCAL_INFERENCE_ROLES)[number];
/** Roles that may hold credentials or feed a merge decision. */
export const CREDENTIALED_ROLES: readonly LocalInferenceRole[] = ['coder', 'reviewer', 'planner'];

export const PROVIDER_DEFAULT_BASE_URL: Readonly<Record<LocalInferenceProvider, string | null>> = Object.freeze({
  ollama: 'http://127.0.0.1:11434/v1',
  omlx: 'http://127.0.0.1:8000/v1',
  'openai-compat': null,
});

export type LocalUrlRefusal =
  | 'base-url-invalid'
  | 'scheme-not-allowed'
  | 'userinfo-not-allowed'
  | 'query-not-allowed'
  | 'fragment-not-allowed'
  | 'host-not-canonical'
  | 'port-invalid'
  | 'path-not-allowed'
  | 'remote-not-allowed'
  | 'remote-requires-https';

export type LocalUrlCheck =
  | { ok: true; baseUrl: string; host: string; loopback: boolean; warning: 'remote-local-inference' | null }
  | { ok: false; reason: LocalUrlRefusal };

const MAX_URL_LENGTH = 2048;
const PRINTABLE_ASCII = /^[\x21-\x7e]+$/;
const SAFE_PATH = /^(?:\/[A-Za-z0-9._~-]*)*$/;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost']);

function splitAuthority(authority: string): { host: string; port?: string } | null {
  if (authority.startsWith('[')) {
    const end = authority.indexOf(']');
    if (end < 0) return null;
    const host = authority.slice(0, end + 1);
    const tail = authority.slice(end + 1);
    if (tail === '') return { host };
    if (!tail.startsWith(':')) return null;
    return { host, port: tail.slice(1) };
  }
  const idx = authority.lastIndexOf(':');
  if (idx < 0) return { host: authority };
  return { host: authority.slice(0, idx), port: authority.slice(idx + 1) };
}

/** True for the loopback hosts this gate accepts: 127.0.0.1, [::1], localhost. */
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.toLowerCase());
}

/**
 * Validate a local inference base URL. Loopback passes. Anything else needs
 * `allowRemote === true` and https, and then carries a warning.
 */
/**
 * No name resolution for local endpoints (Security, #943 and #952 L2): any
 * case of 'localhost' dials 127.0.0.1 directly. Other hosts are returned as is.
 */
export function pinLoopbackHost(host: string): string {
  return host.toLowerCase() === 'localhost' ? '127.0.0.1' : host;
}

export function validateLocalBaseUrl(raw: unknown, opts: { allowRemote?: unknown } = {}): LocalUrlCheck {
  const refuse = (reason: LocalUrlRefusal): LocalUrlCheck => ({ ok: false, reason });
  if (typeof raw !== 'string') return refuse('base-url-invalid');
  const baseUrl = raw.trim();
  if (baseUrl.length === 0 || baseUrl.length > MAX_URL_LENGTH) return refuse('base-url-invalid');
  if (!PRINTABLE_ASCII.test(baseUrl) || baseUrl.includes('\\')) return refuse('base-url-invalid');
  const head = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(baseUrl);
  if (!head) return refuse('base-url-invalid');
  const scheme = head[1]!.toLowerCase();
  if (scheme !== 'https' && scheme !== 'http') return refuse('scheme-not-allowed');
  const rest = baseUrl.slice(head[0].length);
  if (!rest.startsWith('//')) return refuse('base-url-invalid');
  if (baseUrl.includes('#')) return refuse('fragment-not-allowed');
  if (baseUrl.includes('?')) return refuse('query-not-allowed');
  const afterSlashes = rest.slice(2);
  const slash = afterSlashes.indexOf('/');
  const rawAuthority = slash < 0 ? afterSlashes : afterSlashes.slice(0, slash);
  const rawPath = slash < 0 ? '' : afterSlashes.slice(slash);
  if (rawAuthority.includes('@')) return refuse('userinfo-not-allowed');
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return refuse('base-url-invalid');
  }
  if (parsed.username !== '' || parsed.password !== '') return refuse('userinfo-not-allowed');
  const parts = splitAuthority(rawAuthority);
  if (!parts) return refuse('host-not-canonical');
  const host = parts.host.toLowerCase();
  // URL rewrites 0x7f.1, 2130706433, trailing dots and percent-encoding; the
  // raw text must already be canonical so "loopback" means what was written.
  if (host === '' || parsed.hostname !== host || host.endsWith('.')) return refuse('host-not-canonical');
  if (parts.port !== undefined && !/^\d{1,5}$/.test(parts.port)) return refuse('port-invalid');
  const port = parsed.port === '' ? (scheme === 'https' ? 443 : 80) : Number(parsed.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return refuse('port-invalid');
  if (parts.port !== undefined && Number(parts.port) !== port) return refuse('port-invalid');
  if (!SAFE_PATH.test(rawPath)) return refuse('path-not-allowed');
  const trimmed = rawPath.replace(/\/+$/, '');
  if (trimmed !== '' && trimmed.slice(1).split('/').some((s) => s === '' || s === '.' || s === '..')) {
    return refuse('path-not-allowed');
  }
  if (parsed.pathname.replace(/\/+$/, '') !== trimmed) return refuse('path-not-allowed');
  const loopback = LOOPBACK_HOSTS.has(host);
  if (!loopback) {
    if (opts.allowRemote !== true) return refuse('remote-not-allowed');
    if (scheme !== 'https') return refuse('remote-requires-https');
  }
  // No name resolution for local endpoints (Security, #943): 'localhost' dials 127.0.0.1 directly.
  const origin = host === 'localhost' ? `${parsed.protocol}//${pinLoopbackHost(host)}${parsed.port ? `:${parsed.port}` : ''}` : parsed.origin;
  return { ok: true, baseUrl: `${origin}${trimmed}`, host, loopback, warning: loopback ? null : 'remote-local-inference' };
}

/** Abliterated or uncensored weights (refusal removed). Matched by name. */
export function isAbliteratedModel(model: string): boolean {
  return /abliterat|uncensored/i.test(model);
}

const DIGEST_PIN = /@sha256:[a-f0-9]{64}$/;

export interface LocalInferenceConfig {
  provider: LocalInferenceProvider;
  baseUrl: string;
  loopback: boolean;
  warning: 'remote-local-inference' | null;
  models: Partial<Record<LocalInferenceRole, string>>;
  allowRemote: boolean;
  allowAbliterated: boolean;
  /** 'hybrid' lets fleet dispatch route coding loops to local seats (P4 policy). Default 'off'. */
  routing: 'off' | 'hybrid';
}

export type LocalInferenceParse =
  | { ok: true; config: LocalInferenceConfig | null }
  | { ok: false; problems: string[] };

/**
 * Parse and validate a raw `localInference` value. Absent means off
 * (`config: null`). Problems are value-free (no URL or model text).
 */
export function parseLocalInferenceConfig(value: unknown): LocalInferenceParse {
  if (value === undefined || value === null) return { ok: true, config: null };
  if (typeof value !== 'object' || Array.isArray(value)) return { ok: false, problems: ['localInference: must be an object'] };
  const v = value as Record<string, unknown>;
  const problems: string[] = [];
  const known = new Set(['provider', 'baseUrl', 'models', 'allowRemote', 'allowAbliterated', 'routing']);
  const unknown = Object.keys(v).filter((k) => !known.has(k)).length;
  if (unknown) problems.push(`localInference: ${unknown} unrecognized key(s)`);
  const provider = v['provider'];
  if (typeof provider !== 'string' || !(LOCAL_INFERENCE_PROVIDERS as readonly string[]).includes(provider)) {
    problems.push(`localInference.provider: must be one of ${LOCAL_INFERENCE_PROVIDERS.join(', ')}`);
    return { ok: false, problems };
  }
  const p = provider as LocalInferenceProvider;
  for (const flag of ['allowRemote', 'allowAbliterated'] as const) {
    if (v[flag] !== undefined && typeof v[flag] !== 'boolean') problems.push(`localInference.${flag}: must be a boolean`);
  }
  const allowRemote = v['allowRemote'] === true;
  const allowAbliterated = v['allowAbliterated'] === true;
  const rawRouting = v['routing'];
  if (rawRouting !== undefined && rawRouting !== 'off' && rawRouting !== 'hybrid') problems.push("localInference.routing: must be 'off' or 'hybrid'");
  const routing: 'off' | 'hybrid' = rawRouting === 'hybrid' ? 'hybrid' : 'off';
  const rawUrl = v['baseUrl'] ?? PROVIDER_DEFAULT_BASE_URL[p];
  let checked: LocalUrlCheck | null = null;
  if (rawUrl === null) problems.push('localInference.baseUrl: required for provider openai-compat');
  else {
    checked = validateLocalBaseUrl(rawUrl, { allowRemote });
    if (!checked.ok) problems.push(`localInference.baseUrl: ${checked.reason}`);
  }
  const models: Partial<Record<LocalInferenceRole, string>> = {};
  const rawModels = v['models'];
  if (rawModels !== undefined) {
    if (typeof rawModels !== 'object' || rawModels === null || Array.isArray(rawModels)) {
      problems.push('localInference.models: must be an object');
    } else {
      for (const [role, model] of Object.entries(rawModels as Record<string, unknown>)) {
        if (!(LOCAL_INFERENCE_ROLES as readonly string[]).includes(role)) {
          problems.push('localInference.models: unrecognized role');
          continue;
        }
        if (typeof model !== 'string' || model.trim() === '' || model.length > 200 || !PRINTABLE_ASCII.test(model)) {
          problems.push(`localInference.models.${role}: must be a model name`);
          continue;
        }
        const r = role as LocalInferenceRole;
        if (isAbliteratedModel(model)) {
          if (CREDENTIALED_ROLES.includes(r)) {
            problems.push(`localInference.models.${role}: abliterated models are never allowed in a role with credentials or merge rights`);
            continue;
          }
          if (!allowAbliterated) {
            problems.push(`localInference.models.${role}: abliterated model needs allowAbliterated: true`);
            continue;
          }
          if (!DIGEST_PIN.test(model)) {
            problems.push(`localInference.models.${role}: abliterated model must be pinned by digest (@sha256:<64 hex>)`);
            continue;
          }
        }
        models[r] = model;
      }
    }
  }
  if (problems.length || !checked || !checked.ok) return { ok: false, problems };
  return {
    ok: true,
    config: { provider: p, baseUrl: checked.baseUrl, loopback: checked.loopback, warning: checked.warning, models, allowRemote, allowAbliterated, routing },
  };
}

/** Value-free problem list for config load (empty when absent or valid). */
export function localInferenceConfigProblems(value: unknown): string[] {
  const r = parseLocalInferenceConfig(value);
  return r.ok ? [] : r.problems;
}

/** Phantom placeholder or OAuth-shaped token: never sent to a local URL. */
export function isForbiddenLocalKey(key: string): boolean {
  const k = key.trim();
  return /^phm_/i.test(k) || /^sk-ant-oat/i.test(k) || /^ya29\./.test(k) || /^gho_|^ghu_/.test(k);
}

export type OpenAICompatTarget =
  | { ok: true; baseUrl: string; host: string; loopback: boolean; warning: 'remote-local-inference' | null; apiKey: string; keyDropped: boolean }
  | { ok: false; reason: LocalUrlRefusal | 'local-inference-config-invalid' };

/**
 * Resolve the `openai-compat` engine target. Precedence: OPENAI_COMPAT_BASE_URL,
 * then `localInference.baseUrl` when it selects a server, then the registry
 * default. Every source goes through the loopback gate; only config
 * `localInference.allowRemote: true` admits a remote https URL.
 * The key: ollama/omlx get none; otherwise the configured key is sent unless
 * it is a phantom placeholder or OAuth-shaped (then dropped, keyDropped true).
 */
export function resolveOpenAICompatTarget(input: {
  envBaseUrl?: string;
  localInference?: unknown;
  defaultBaseUrl: string;
  apiKey: string;
}): OpenAICompatTarget {
  const parsed = parseLocalInferenceConfig(input.localInference);
  if (!parsed.ok) return { ok: false, reason: 'local-inference-config-invalid' };
  const li = parsed.config;
  const env = input.envBaseUrl?.trim();
  const raw = env ? env : li ? li.baseUrl : input.defaultBaseUrl;
  const checked = validateLocalBaseUrl(raw, { allowRemote: li?.allowRemote === true });
  if (!checked.ok) return checked;
  const keyless = li !== null && li.provider !== 'openai-compat';
  const forbidden = input.apiKey !== '' && isForbiddenLocalKey(input.apiKey);
  const apiKey = keyless || forbidden ? '' : input.apiKey;
  return { ...checked, apiKey, keyDropped: input.apiKey !== '' && apiKey === '' };
}
