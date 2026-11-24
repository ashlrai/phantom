/** HTTP adapter; retains the host's dispatch, token and JSON-body gates. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { humanActorForPresence, invitePresenceBytes, verifyPresenceSignature } from '../core/approvals/actor.js';
import { acceptTeamInvite, createTeamInvite, InviteError } from '../core/teams/invites.js';
import { passesMutationGate, readBody, sendJson } from '../core/web/api.js';

export async function handleTeamInvites(req: IncomingMessage, res: ServerResponse, ctx: { token: string; allowDispatch: boolean }): Promise<boolean> {
  const path = new URL(req.url ?? '/', 'http://localhost').pathname;
  const match = /^\/api\/teams\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,127})\/invites(\/accept)?$/.exec(path);
  if (!match) return false;
  res.setHeader('Cache-Control', 'no-store');
  if (!ctx.allowDispatch) { sendJson(res, 404, { error: 'not found' }); return true; }
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); sendJson(res, 405, { error: 'method not allowed' }); return true; }
  if (!passesMutationGate(req, res, ctx.token)) return true;
  let input: unknown;
  try { input = JSON.parse(await readBody(req)); }
  catch { sendJson(res, 400, { error: 'Invalid JSON body.' }); return true; }
  if (!input || typeof input !== 'object' || Array.isArray(input)) { sendJson(res, 400, { error: 'Expected an object.' }); return true; }
  const body = input as Record<string, unknown>;
  const accept = !!match[2];
  const allowed = accept ? ['token', 'assertion'] : ['ttlMs', 'assertion'];
  if (Object.keys(body).some(k => !allowed.includes(k))
    || (accept ? typeof body.token !== 'string' : body.ttlMs !== undefined && typeof body.ttlMs !== 'number')
    || (body.assertion !== undefined && typeof body.assertion !== 'string')) {
    sendJson(res, 400, { error: 'Invalid invitation fields.' }); return true;
  }
  const op = accept ? 'accept' as const : 'create' as const;
  if (typeof body.assertion !== 'string' || !await verifyPresenceSignature(invitePresenceBytes(match[1]!, op), body.assertion)) {
    sendJson(res, 403, { error: 'human-presence-required', code: 'human-presence-required' }); return true;
  }
  let actor;
  try { actor = humanActorForPresence(ctx.token); }
  catch { sendJson(res, 403, { error: 'human-presence-required', code: 'human-presence-required' }); return true; }
  try {
    if (accept) sendJson(res, 200, acceptTeamInvite(match[1]!, body.token as string, actor));
    else {
      const invite = createTeamInvite(match[1]!, actor, body.ttlMs as number | undefined);
      // This authenticated issuance response intentionally carries the newly
      // minted capability. Generic read-model sanitization would redact it.
      res.writeHead(201, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(JSON.stringify(invite));
    }
  } catch (error) {
    sendJson(res, error instanceof InviteError ? 409 : 500, { error: error instanceof InviteError ? error.message : 'Invitation operation unavailable.' });
  }
  return true;
}
