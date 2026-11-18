/** HTTP adapter for bot templates; retains the host's dispatch, token and JSON-body gates. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { BotTemplateError, createBotFromTemplate, listBots, listBotTemplates } from '../core/agents/bot-templates.js';
import { passesMutationGate, readBody, sendJson } from '../core/web/api.js';
import { listSeats } from '../core/bots/seats.js';

/**
 * GET  /api/bots/templates  the starter templates (read-only, no token)
 * GET  /api/bots            bots created from templates
 * GET  /api/bots/seats      external bot seat roster and quota evidence
 * POST /api/bots            { templateId, id, name? } create a bot (mutation token, --allow-dispatch)
 */
export async function handleBotTemplates(req: IncomingMessage, res: ServerResponse, ctx: { token: string; allowDispatch: boolean }): Promise<boolean> {
  const path = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (!['/api/bots', '/api/bots/templates', '/api/bots/seats'].includes(path)) return false;
  res.setHeader('Cache-Control', 'no-store');
  const method = (req.method ?? 'GET').toUpperCase();
  if (method === 'GET') {
    if (path === '/api/bots/seats') {
      try { sendJson(res, 200, await listSeats()); }
      catch { sendJson(res, 503, { error: 'Bot seats unavailable.' }); }
      return true;
    }
    if (path === '/api/bots/templates') sendJson(res, 200, { templates: listBotTemplates() });
    else sendJson(res, 200, { bots: await listBots() });
    return true;
  }
  if (path !== '/api/bots' || method !== 'POST') { res.setHeader('Allow', path === '/api/bots' ? 'GET, POST' : 'GET'); sendJson(res, 405, { error: 'method not allowed' }); return true; }
  if (!ctx.allowDispatch) { sendJson(res, 404, { error: 'not found' }); return true; }
  if (!passesMutationGate(req, res, ctx.token)) return true;
  let input: unknown;
  try { input = JSON.parse(await readBody(req)); }
  catch { sendJson(res, 400, { error: 'Invalid JSON body.' }); return true; }
  if (!input || typeof input !== 'object' || Array.isArray(input)) { sendJson(res, 400, { error: 'Expected an object.' }); return true; }
  const body = input as Record<string, unknown>;
  if (Object.keys(body).some(k => !['templateId', 'id', 'name'].includes(k)) || typeof body.templateId !== 'string' || typeof body.id !== 'string' ||
      (body.name !== undefined && typeof body.name !== 'string')) {
    sendJson(res, 400, { error: 'Expected { templateId, id, name? }.' }); return true;
  }
  try {
    const result = await createBotFromTemplate({ templateId: body.templateId, id: body.id, name: body.name as string | undefined });
    sendJson(res, 201, result);
  } catch (error) {
    if (error instanceof BotTemplateError) sendJson(res, error.status, { error: error.message });
    else sendJson(res, 500, { error: 'Bot creation unavailable.' });
  }
  return true;
}
