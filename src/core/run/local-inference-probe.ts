/**
 * Local inference probe (local-inference-plan.md slice P3).
 *
 * One GET <baseUrl>/models against the configured `localInference` server:
 * loopback only (a remote URL, even with allowRemote, is never probed), no
 * key or Authorization header, no request body, no redirects, short timeout,
 * bounded response. Reports whether the backend answered and which models it
 * lists, so `phm doctor` and `status --json` can say "local inference ready".
 * Value-free: no URL, header or error text in the result; model ids only when
 * they match a conservative model-name charset.
 */
import { LOCAL_PROBE_MAX_BODY_BYTES, readCappedBody } from './bounded-body.js';
import { parseLocalInferenceConfig, type LocalInferenceProvider, type LocalInferenceRole } from './local-inference.js';

export { LOCAL_PROBE_MAX_BODY_BYTES, readCappedBody } from './bounded-body.js';

export const LOCAL_INFERENCE_PROBE_TIMEOUT_MS = 3_000;
const MAX_BODY_BYTES = LOCAL_PROBE_MAX_BODY_BYTES;
const MAX_MODELS = 20;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/;

export type LocalInferenceProbeStatus =
  | 'not-configured'
  | 'config-invalid'
  | 'remote-not-probed'
  | 'reachable'
  | 'unreachable'
  | 'bad-response';

export interface LocalInferenceProbe {
  status: LocalInferenceProbeStatus;
  provider: LocalInferenceProvider | null;
  loopback: boolean | null;
  reachable: boolean;
  /** HTTP status when the server answered; null otherwise. */
  httpStatus: number | null;
  modelCount: number;
  /** Up to 20 model ids reported by the server (charset-filtered). */
  models: string[];
  /** For each configured role: is its model listed by the server? */
  rolesPresent: Partial<Record<LocalInferenceRole, boolean>>;
}

export type ProbeFetch = (url: string, init: RequestInit) => Promise<Response>;

function base(status: LocalInferenceProbeStatus, provider: LocalInferenceProvider | null = null, loopback: boolean | null = null): LocalInferenceProbe {
  return { status, provider, loopback, reachable: false, httpStatus: null, modelCount: 0, models: [], rolesPresent: {} };
}

/** Pure. Model ids from an OpenAI `{data:[{id}]}` or Ollama `{models:[{name}]}` body. */
export function modelIdsFromBody(body: unknown): string[] | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const list = Array.isArray(b['data']) ? b['data'] : Array.isArray(b['models']) ? b['models'] : null;
  if (!list) return null;
  const ids: string[] = [];
  for (const m of list) {
    if (!m || typeof m !== 'object') continue;
    const r = m as Record<string, unknown>;
    const id = typeof r['id'] === 'string' ? r['id'] : typeof r['name'] === 'string' ? r['name'] : null;
    if (id) ids.push(id);
  }
  return ids;
}

/** Strip a digest pin for presence matching (`name@sha256:...` -> `name`). */
function modelKey(m: string): string {
  return m.replace(/@sha256:[a-f0-9]{64}$/, '');
}

/** Probe the configured local inference server. Never throws. */
export async function probeLocalInference(
  localInference: unknown,
  opts: { fetchImpl?: ProbeFetch; timeoutMs?: number } = {},
): Promise<LocalInferenceProbe> {
  const parsed = parseLocalInferenceConfig(localInference);
  if (!parsed.ok) return base('config-invalid');
  const li = parsed.config;
  if (!li) return base('not-configured');
  if (!li.loopback) return base('remote-not-probed', li.provider, false);
  const fetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, init));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? LOCAL_INFERENCE_PROBE_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${li.baseUrl}/models`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      redirect: 'error',
      signal: controller.signal,
    });
    const out = base('bad-response', li.provider, true);
    out.reachable = true;
    out.httpStatus = res.status;
    if (!res.ok) return out;
    const text = await readCappedBody(res, MAX_BODY_BYTES, controller);
    if (text === null) return out;
    let body: unknown;
    try { body = JSON.parse(text); } catch { return out; }
    const ids = modelIdsFromBody(body);
    if (!ids) return out;
    const safe = ids.filter((id) => MODEL_ID.test(id));
    out.status = 'reachable';
    out.modelCount = ids.length;
    out.models = safe.slice(0, MAX_MODELS);
    const listed = new Set(safe.map(modelKey));
    for (const [role, model] of Object.entries(li.models)) {
      if (model) out.rolesPresent[role as LocalInferenceRole] = listed.has(modelKey(model));
    }
    return out;
  } catch {
    return base('unreachable', li.provider, true);
  } finally {
    clearTimeout(timer);
  }
}
