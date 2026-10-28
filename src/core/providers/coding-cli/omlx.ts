/**
 * oMLX is the default local tier: an OpenAI-compatible server that this
 * adapter will call only on a loopback URL. Ollama remains the fallback when
 * oMLX is off or its URL is not loopback. No API key is sent.
 */

import { PROVIDER_DEFAULT_BASE_URL, validateLocalBaseUrl } from '../../run/local-inference.js';
import type { BackendRecord } from './catalog.js';

export interface OmlxFetch {
  (url: string, init: { method: 'GET'; headers: Record<string, string> }): Promise<{
    status: number;
    text(): Promise<string>;
  }>;
}

export type OmlxProbe =
  | { ok: true; models: string[] }
  | { ok: false; reason: 'remote-not-allowed' | 'model-list-refused' | 'model-list-unparsed' };

/** Loopback base URL, or null when the configured URL is missing or remote. */
export function omlxBaseUrl(record: Pick<BackendRecord, 'baseUrl'> | undefined): string | null {
  const raw = record?.baseUrl ?? PROVIDER_DEFAULT_BASE_URL.omlx;
  if (!raw) return null;
  const checked = validateLocalBaseUrl(raw, { allowRemote: false });
  if (!checked.ok || !checked.loopback) return null;
  return checked.baseUrl;
}

export function omlxModelsUrl(baseUrl: string): string | null {
  const checked = validateLocalBaseUrl(baseUrl, { allowRemote: false });
  if (!checked.ok || !checked.loopback) return null;
  return `${checked.baseUrl}/models`;
}

function modelIds(body: unknown): string[] | null {
  if (typeof body !== 'object' || body === null) return null;
  const data = (body as Record<string, unknown>)['data'];
  if (!Array.isArray(data)) return null;
  const ids: string[] = [];
  for (const row of data) {
    if (typeof row !== 'object' || row === null) return null;
    const id = (row as Record<string, unknown>)['id'];
    if (typeof id !== 'string' || id.trim() === '') return null;
    ids.push(id.trim());
  }
  return ids;
}

/** GET /v1/models. A non-loopback URL never reaches `fetch`. */
export async function probeOmlx(baseUrl: string, fetchImpl: OmlxFetch): Promise<OmlxProbe> {
  const url = omlxModelsUrl(baseUrl);
  if (!url) return { ok: false, reason: 'remote-not-allowed' };
  const response = await fetchImpl(url, { method: 'GET', headers: { accept: 'application/json' } });
  if (response.status !== 200) return { ok: false, reason: 'model-list-refused' };
  try {
    const ids = modelIds(JSON.parse(await response.text()) as unknown);
    if (!ids) return { ok: false, reason: 'model-list-unparsed' };
    return { ok: true, models: ids };
  } catch {
    return { ok: false, reason: 'model-list-unparsed' };
  }
}
