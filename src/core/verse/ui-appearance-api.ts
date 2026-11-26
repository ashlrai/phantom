/**
 * UI appearance route — the server-side appearance record every local console
 * polls (web-ui/data/appearance-sync.ts) and agents write through the CLI.
 *
 *   GET  /api/verse/appearance  → the stored file (version, revision,
 *                                 updatedAt, updatedBy, appearance), or
 *                                 `{ revision: 0, appearance: null }` when
 *                                 nothing is stored yet. A read like every
 *                                 other GET here: behind the read-session
 *                                 boundary in server.ts.
 *   PUT  /api/verse/appearance  { expectedRevision, appearance, updatedBy? }
 *                                 → the stored file at revision+1; 409 with
 *                                 the current record on a revision mismatch,
 *                                 so the loser refetches instead of clobbering.
 *
 * The PUT is gated exactly like the Leader attachment POST: 404 without
 * dispatch, then the x-ashlr-token check. The remote (phone) gateway does not
 * list this path, so it stays denied there, same as the attachment routes.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readBody, sendJson } from '../web/api.js';
import { headerValue, safeEqual } from '../web/read-session.js';
import type { VerseApiContext } from './verse-api.js';
import { readUiAppearanceFile, updateUiAppearanceFile, type UiAppearanceFile } from './ui-appearance-file.js';
import { appearanceSettingsFrom, validateAppearanceSettings, type AppearanceSettings } from '../settings-appearance.js';
import { BrandUploadError, MAX_BRAND_BYTES, readBrandImage, storeBrandImage } from '../brand/sidebar-upload.js';

export const VERSE_UI_APPEARANCE_PATH = '/api/verse/appearance';
export const VERSE_BRAND_IMAGE_PATH = '/api/verse/appearance/brand-image';
/**
 * The plain settings (brand, theme, accent hex, density, fontSize) as the CLI
 * `phm settings appearance` shows them, over the SAME record:
 *
 *   GET   → AppearanceSettingsResponse
 *   PATCH { brand?, theme?, accent?, density?, fontSize? } → AppearanceSettingsResponse
 *           (validated like the CLI: an unknown key or bad value is a 400 with
 *           a plain message; no revision needed, the write merges)
 *
 * Gated exactly like the PUT above.
 */
export const VERSE_APPEARANCE_SETTINGS_PATH = '/api/verse/appearance/settings';

export interface AppearanceSettingsResponse {
  appearance: AppearanceSettings;
  /** false = nothing saved yet, these are the defaults. */
  saved: boolean;
  revision: number;
}

function settingsResponse(file: UiAppearanceFile | null): AppearanceSettingsResponse {
  return { appearance: appearanceSettingsFrom(file?.appearance), saved: file !== null, revision: file?.revision ?? 0 };
}

export async function handleBrandImage(ctx: VerseApiContext, req: IncomingMessage, res: ServerResponse, method: string): Promise<boolean> {
  if ((req.url ?? '').includes('?')) { sendJson(res, 400, { error: 'this route takes no query parameters' }); return true; }
  if (method === 'GET') {
    const { brandAsset } = (await readUiAppearanceFile())?.appearance ?? {};
    const image = brandAsset ? await readBrandImage(brandAsset) : null;
    if (!image) { sendJson(res, 404, { error: 'no custom brand image is selected' }); return true; }
    res.writeHead(200, {
      'Content-Type': image.contentType,
      'Content-Length': image.bytes.length,
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(image.bytes);
    return true;
  }
  if (method !== 'POST') { sendJson(res, 405, { error: 'method not allowed' }); return true; }
  if (!ctx.allowDispatch) { sendJson(res, 404, { error: 'not found' }); return true; }
  if (!safeEqual(headerValue(req, 'x-ashlr-token'), ctx.token)) {
    sendJson(res, 401, { error: 'unauthorized: missing or invalid x-ashlr-token' });
    return true;
  }
  const maxEncoded = Math.ceil(MAX_BRAND_BYTES / 3) * 4;
  let body: string;
  try { body = await readBody(req, maxEncoded); }
  catch { sendJson(res, 413, { error: 'Brand images must be at most 512 KB.' }); return true; }
  const bytes = Buffer.from(body, 'base64');
  if (bytes.toString('base64') !== body) {
    sendJson(res, 400, { error: 'Expected a base64-encoded brand image.' });
    return true;
  }
  if (bytes.length > MAX_BRAND_BYTES) {
    sendJson(res, 413, { error: 'Brand images must be at most 512 KB.' });
    return true;
  }
  try {
    const brandAsset = await storeBrandImage(bytes);
    const result = await updateUiAppearanceFile({ brand: 'upload', brandAsset }, { updatedBy: 'verse-ui' });
    if (!result.ok) { sendJson(res, 409, { error: 'appearance changed while writing; retry' }); return true; }
    sendJson(res, 200, result.file);
  } catch (error) {
    if (!(error instanceof BrandUploadError)) throw error;
    sendJson(res, 400, { error: error.message });
  }
  return true;
}

export async function handleAppearanceSettings(ctx: VerseApiContext, req: IncomingMessage, res: ServerResponse, method: string): Promise<boolean> {
  if ((req.url ?? '').includes('?')) { sendJson(res, 400, { code: 'VERSE_INVALID', error: 'this route takes no query parameters' }); return true; }
  if (method === 'GET') {
    sendJson(res, 200, settingsResponse(await readUiAppearanceFile()));
    return true;
  }
  if (method !== 'PATCH') { sendJson(res, 405, { error: 'method not allowed' }); return true; }
  if (!ctx.allowDispatch) { sendJson(res, 404, { error: 'not found' }); return true; }
  if (!safeEqual(headerValue(req, 'x-ashlr-token'), ctx.token)) {
    sendJson(res, 401, { error: 'unauthorized: missing or invalid x-ashlr-token' });
    return true;
  }
  let body: unknown;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    sendJson(res, 400, { code: 'VERSE_INVALID', error: 'invalid JSON body' });
    return true;
  }
  const checked = validateAppearanceSettings(body);
  if (!checked.ok) { sendJson(res, 400, { code: 'VERSE_INVALID', error: checked.error }); return true; }
  const result = await updateUiAppearanceFile(checked.patch, { updatedBy: 'api' });
  if (!result.ok) { sendJson(res, 409, { code: 'VERSE_REVISION_CONFLICT', error: 'appearance changed while writing; retry' }); return true; }
  sendJson(res, 200, settingsResponse(result.file));
  return true;
}

const PUT_KEYS = new Set(['expectedRevision', 'appearance', 'updatedBy']);
const UPDATED_BY_MAX = 120;

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export async function handleUiAppearance(ctx: VerseApiContext, req: IncomingMessage, res: ServerResponse, method: string): Promise<boolean> {
  if (method === 'GET') {
    if ((req.url ?? '').includes('?')) { sendJson(res, 400, { code: 'VERSE_INVALID', error: 'this route takes no query parameters' }); return true; }
    const stored = await readUiAppearanceFile();
    sendJson(res, 200, stored ?? { revision: 0, appearance: null });
    return true;
  }
  if (method !== 'PUT') { sendJson(res, 405, { error: 'method not allowed' }); return true; }
  if (!ctx.allowDispatch) { sendJson(res, 404, { error: 'not found' }); return true; }
  if (!safeEqual(headerValue(req, 'x-ashlr-token'), ctx.token)) {
    sendJson(res, 401, { error: 'unauthorized: missing or invalid x-ashlr-token' });
    return true;
  }
  if ((req.url ?? '').includes('?')) { sendJson(res, 400, { code: 'VERSE_INVALID', error: 'this route takes no query parameters' }); return true; }
  let body: unknown;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    sendJson(res, 400, { code: 'VERSE_INVALID', error: 'invalid JSON body' });
    return true;
  }
  if (!isRecord(body) || Object.keys(body).some((key) => !PUT_KEYS.has(key))) {
    sendJson(res, 400, { code: 'VERSE_INVALID', error: 'expected { expectedRevision, appearance, updatedBy? }' });
    return true;
  }
  const expected = body['expectedRevision'];
  if (typeof expected !== 'number' || !Number.isSafeInteger(expected) || expected < 0) {
    sendJson(res, 400, { code: 'VERSE_INVALID', error: 'expectedRevision must be a non-negative integer' });
    return true;
  }
  if (!isRecord(body['appearance'])) {
    sendJson(res, 400, { code: 'VERSE_INVALID', error: 'appearance must be an object' });
    return true;
  }
  const updatedBy = body['updatedBy'];
  if (updatedBy !== undefined && (typeof updatedBy !== 'string' || updatedBy.length === 0 || updatedBy.length > UPDATED_BY_MAX)) {
    sendJson(res, 400, { code: 'VERSE_INVALID', error: `updatedBy must be a string of 1-${UPDATED_BY_MAX} characters` });
    return true;
  }
  const result = await updateUiAppearanceFile(body['appearance'], { expectedRevision: expected, updatedBy });
  if (!result.ok) {
    sendJson(res, 409, {
      code: 'VERSE_REVISION_CONFLICT',
      error: 'appearance changed since your read; refetch and retry',
      revision: result.conflict?.revision ?? 0,
      appearance: result.conflict?.appearance ?? null,
    });
    return true;
  }
  sendJson(res, 200, result.file);
  return true;
}
