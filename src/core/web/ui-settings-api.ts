/**
 * GET/PUT /api/ui-settings — the HTTP face of ~/.ashlr/ui.json (../ui-settings.ts).
 *
 * GET re-reads the file every time (an agent may have just edited it) and is
 * read-gated like every other dashboard read. PUT merges a partial document
 * into the file behind the same gates as every other write (--allow-dispatch,
 * then x-ashlr-token + application/json). Invalid fields are reported in
 * `problems`, never written; the response is always the file as it now stands.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readUiSettings, writeUiSettings } from '../ui-settings.js';
import { passesMutationGate, readBody, sendJson } from './api.js';

export const UI_SETTINGS_PATH = '/api/ui-settings';
const MAX_BODY_BYTES = 16 * 1024;

export async function handleUiSettingsApi(
  ctx: { token: string; allowDispatch: boolean },
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
): Promise<boolean> {
  if (method === 'GET') {
    sendJson(res, 200, readUiSettings());
    return true;
  }
  if (method !== 'PUT') {
    sendJson(res, 405, { error: 'method not allowed' });
    return true;
  }
  // Same posture as every write: absent unless the server was started with
  // --allow-dispatch (the desktop sidecar is), then token-gated.
  if (!ctx.allowDispatch) {
    sendJson(res, 404, { error: 'not found' });
    return true;
  }
  if (!passesMutationGate(req, res, ctx.token)) return true;
  let patch: unknown;
  try {
    patch = JSON.parse(await readBody(req, MAX_BODY_BYTES));
  } catch {
    sendJson(res, 400, { error: 'body must be a JSON object' });
    return true;
  }
  try {
    sendJson(res, 200, writeUiSettings(patch));
  } catch {
    sendJson(res, 500, { error: 'could not write the UI settings file' });
  }
  return true;
}
