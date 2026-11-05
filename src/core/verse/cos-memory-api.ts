/** Desktop surface for the chief-of-staff memory: list, add and forget entries (the `phm memory` verbs). */
import type { ApiModule } from './api-modules.js';
import { passesMutationGate, readBody, sendJson } from '../web/api.js';
import { scrubSecrets } from '../util/scrub.js';
import { MEMORY_KINDS, MemoryError, addMemory, forgetMemory, listMemory, type MemoryEntry, type MemoryKind } from '../cos/memory.js';

export const VERSE_COS_MEMORY_PATH = '/api/verse/cos/memory';
export const VERSE_COS_MEMORY_FORGET_PATH = '/api/verse/cos/memory/forget';

export interface CosMemoryApiDeps {
  /** Default: the user's home directory. */
  home?: string;
  now?: () => Date;
}

const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const wire = (e: MemoryEntry): MemoryEntry => ({ ...e, text: scrubSecrets(e.text) });
const hasExactKeys = (body: Record<string, unknown>, keys: string[]): boolean =>
  Object.keys(body).length === keys.length && keys.every(k => typeof body[k] === 'string');

async function jsonBody(req: Parameters<ApiModule>[1]): Promise<unknown> {
  try { return JSON.parse(await readBody(req)); } catch { return null; }
}

export function createCosMemoryApi(deps: CosMemoryApiDeps = {}): ApiModule {
  const now = deps.now ?? (() => new Date());
  const home = deps.home;

  async function list(req: Parameters<ApiModule>[1], res: Parameters<ApiModule>[2]): Promise<void> {
    let kind: string | null;
    try { kind = new URL(req.url ?? '/', 'http://localhost').searchParams.get('kind'); } catch { kind = null; }
    if (kind !== null && !(MEMORY_KINDS as readonly string[]).includes(kind)) {
      sendJson(res, 400, { code: 'VERSE_INVALID', error: 'invalid kind' }); return;
    }
    try {
      const entries = await listMemory({ home, ...(kind ? { kind: kind as MemoryKind } : {}) });
      sendJson(res, 200, { v: 1, entries: entries.map(wire) });
    } catch { sendJson(res, 503, { code: 'MEMORY_UNAVAILABLE' }); }
  }

  async function add(req: Parameters<ApiModule>[1], res: Parameters<ApiModule>[2]): Promise<void> {
    const body = await jsonBody(req);
    if (!record(body) || !hasExactKeys(body, ['kind', 'text'])) {
      sendJson(res, 400, { code: 'VERSE_INVALID', error: 'invalid memory body' }); return;
    }
    try {
      const entry = await addMemory({ kind: body.kind as string, text: body.text as string, source: 'desktop' }, { home, now: now() });
      sendJson(res, 201, { v: 1, entry: wire(entry) });
    } catch (error) {
      // MemoryError messages are fixed text and never echo the input.
      if (error instanceof MemoryError) sendJson(res, 422, { code: 'MEMORY_REFUSED', error: error.message });
      else sendJson(res, 503, { code: 'MEMORY_UNAVAILABLE' });
    }
  }

  async function forget(req: Parameters<ApiModule>[1], res: Parameters<ApiModule>[2]): Promise<void> {
    const body = await jsonBody(req);
    if (!record(body) || !hasExactKeys(body, ['id'])) {
      sendJson(res, 400, { code: 'VERSE_INVALID', error: 'invalid forget body' }); return;
    }
    try {
      sendJson(res, 200, { v: 1, removed: await forgetMemory(body.id as string, { home }) });
    } catch (error) {
      if (error instanceof MemoryError) sendJson(res, 400, { code: 'VERSE_INVALID', error: error.message });
      else sendJson(res, 503, { code: 'MEMORY_UNAVAILABLE' });
    }
  }

  return async (ctx, req, res, path, method) => {
    const route = path === VERSE_COS_MEMORY_PATH ? 'memory' : path === VERSE_COS_MEMORY_FORGET_PATH ? 'forget' : null;
    if (route === null) return false;
    if (method !== (route === 'memory' ? 'GET' : 'POST') && !(route === 'memory' && method === 'POST')) {
      sendJson(res, 405, { error: 'method not allowed' }); return true;
    }
    if (!ctx.allowDispatch) { sendJson(res, 404, { error: 'not found' }); return true; }
    if (method === 'POST' && !passesMutationGate(req, res, ctx.token)) return true;
    await (route === 'forget' ? forget : method === 'GET' ? list : add)(req, res);
    return true;
  };
}

export const handleCosMemoryApi: ApiModule = createCosMemoryApi();
