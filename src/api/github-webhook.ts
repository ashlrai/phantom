import { createHmac, timingSafeEqual } from 'node:crypto';
import { storeGithubWebhook } from '../core/github/webhook-store.js';

/** Mount this Fetch handler at POST /api/github/webhook. The host supplies the
 * signing secret through its Phantom Secrets binding, never a checked-in value.
 * No public listener is started and no merge/dispatch authority is granted.
 */
export function createGithubWebhookHandler(options: { secret: string; eventDirectory: string }) {
  if (!options.secret || !options.eventDirectory) throw new Error('Webhook configuration required');
  const { secret, eventDirectory } = options;
  return async (request: Request): Promise<Response> => {
    const reply = (status: number) => new Response(null, { status });
    if (new URL(request.url).pathname !== '/api/github/webhook') return reply(404);
    if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } });
    const signature = request.headers.get('x-hub-signature-256');
    if (!signature || !/^sha256=[a-fA-F0-9]{64}$/.test(signature)) return reply(401);
    const deliveryId = request.headers.get('x-github-delivery');
    if (!deliveryId || !/^[a-zA-Z0-9-]{1,128}$/.test(deliveryId)) return reply(400);
    const event = request.headers.get('x-github-event');
    if (event !== 'check_run' && event !== 'pull_request') return reply(422);
    const maxBytes = 1024 * 1024;
    const reader = request.body?.getReader();
    if (!reader) return reply(400);
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) { await reader.cancel(); return reply(413); }
        chunks.push(value);
      }
    } catch { return reply(400); }
    finally { reader.releaseLock(); }
    const body = Buffer.concat(chunks);
    const expected = createHmac('sha256', secret).update(body).digest();
    if (!timingSafeEqual(expected, Buffer.from(signature.slice(7), 'hex'))) return reply(401);
    let payload: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return reply(400);
      payload = parsed as Record<string, unknown>;
      if (typeof payload.action !== 'string' || !payload[event] || typeof payload[event] !== 'object'
        || Array.isArray(payload[event])) return reply(400);
    } catch { return reply(400); }
    try {
      const accepted = await storeGithubWebhook(eventDirectory, {
        v: 1, deliveryId, event, receivedAt: new Date().toISOString(), payload,
      });
      return reply(accepted ? 202 : 409);
    } catch { return reply(503); }
  };
}
