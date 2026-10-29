import type { IncomingMessage, ServerResponse } from 'node:http';
import { passesMutationGate, readBody, sendJson } from '../web/api.js';
import { enqueueFrictionFlag, parseFrictionFlag } from './feedback-queue.js';

export async function handleFrictionFeedback(
  ctx: { allowDispatch: boolean; token: string }, req: IncomingMessage, res: ServerResponse,
): Promise<boolean> {
  if (req.method !== 'POST' || !ctx.allowDispatch) {
    sendJson(res, 404, { error: 'not found' });
    return true;
  }
  if (!passesMutationGate(req, res, ctx.token)) return true;
  let flag: ReturnType<typeof parseFrictionFlag>;
  try { flag = parseFrictionFlag(JSON.parse(await readBody(req, 16 * 1024))); }
  catch { sendJson(res, 400, { error: 'Provide a description (1–2000 characters) and a valid surface.' }); return true; }
  try { sendJson(res, 201, await enqueueFrictionFlag(flag)); }
  catch { sendJson(res, 503, { error: 'Could not save the flag locally. Try again.' }); }
  return true;
}
