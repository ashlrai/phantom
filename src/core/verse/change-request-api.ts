import type { IncomingMessage, ServerResponse } from 'node:http';
import { listChangeRequests, submitChangeRequest, type ChangeRequestDeps } from './change-request.js';
import { passesMutationGate, readBody, sendJson } from '../web/api.js';

export const CHANGE_REQUEST_PATH = '/api/verse/change-request';
export const CHANGE_REQUESTS_PATH = '/api/verse/change-requests';
export async function handleChangeRequestApi(
  ctx: { allowDispatch: boolean; token: string },
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  deps: ChangeRequestDeps = {},
): Promise<boolean> {
  if (path !== CHANGE_REQUEST_PATH && path !== CHANGE_REQUESTS_PATH) return false;
  const method = req.method ?? '';
  if (!ctx.allowDispatch || !((path === CHANGE_REQUEST_PATH && method === 'POST')
    || (path === CHANGE_REQUESTS_PATH && method === 'GET'))) {
    sendJson(res, 404, { error: 'not found' });
    return true;
  }
  if (!passesMutationGate(req, res, ctx.token)) return true;
  if (method === 'GET') {
    try {
      sendJson(res, 200, { requests: await listChangeRequests(deps) });
    } catch {
      sendJson(res, 503, { error: 'Could not read change requests locally. Try again.' });
    }
    return true;
  }
  let input: unknown;
  try {
    input = JSON.parse(await readBody(req, 16 * 1024));
  } catch {
    sendJson(res, 400, { error: 'Provide a description (1–2000 characters) and a valid surface.' });
    return true;
  }
  try {
    const result = await submitChangeRequest(input, deps);
    const status = result.status === 'queued' ? 201
      : result.status === 'duplicate' ? 200
        : result.status === 'deferred' ? 202 : 422;
    sendJson(res, status, result);
  } catch (error) {
    if (error instanceof Error && error.message === 'Invalid flag') {
      sendJson(res, 400, { error: 'Provide a description (1–2000 characters) and a valid surface.' });
    } else {
      sendJson(res, 503, { error: 'Could not save the change request locally. Try again.' });
    }
  }
  return true;
}
