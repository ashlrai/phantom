import { createPhantomSelfDrive, createDesktopAdapters, type ToolCall, type VerseRequest } from '../verse/desktop-adapters.js';

export const DRIVE_TARGETS = ['devin', 'claude', 'codex', 'phantom'] as const;
export type DriveTarget = typeof DRIVE_TARGETS[number];
export type AppAction = 'start' | 'status' | 'send-prompt' | 'read-result';
export interface AppRequest { target: DriveTarget; action: AppAction; handle?: string; prompt?: string; seat?: string; projectPath: string }
export interface AppPorts { request: VerseRequest; desk?: ToolCall }
const record = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' ? v as Record<string, unknown> : {};
const validHandle = (s: string | undefined): s is string => !!s && /^[A-Za-z0-9_-]{1,80}$/.test(s);

/** Never fall back after a mutation: a lost response might already have spent. */
export function createAppAdapter(target: DriveTarget, ports: AppPorts) {
  return async (input: AppRequest): Promise<unknown> => {
    if (input.target !== target) throw new Error('Target mismatch');
    const { action, handle, prompt } = input;
    if (['start', 'send-prompt'].includes(action) && (!prompt?.trim() || prompt.length > 2000)) throw new Error('Prompt must be 1-2000 characters');
    if (target !== 'phantom' && ports.desk && handle?.startsWith(`desk-${target}:`)) {
      const bundle = handle.slice(`desk-${target}:`.length);
      if (!/^[A-Za-z0-9.-]{1,160}$/.test(bundle)) throw new Error('Invalid DESK handle');
      const desk = createDesktopAdapters(ports.desk)[target];
      if (action === 'status') return desk.status(bundle);
      if (action === 'read-result') return desk.collect(bundle);
      const result = await desk.start(prompt!);
      return result.ok ? { ok: true, handle } : result;
    }
    if (action !== 'start' && !validHandle(handle)) throw new Error('Invalid session handle');
    if (action === 'start') {
      const discovery = await ports.request('GET', '/api/verse/bootstrap');
      if (discovery.status !== 200) throw new Error('Seat discovery unavailable');
      const seats = record(discovery.json)['seats'];
      const seat = Array.isArray(seats) ? seats.map(record).find(s =>
        (target === 'phantom' || s['engine'] === target) && (input.seat ? s['id'] === input.seat : target !== 'phantom')) : undefined;
      if (!seat || typeof seat['id'] !== 'string') {
        // Only the existing DESK driver may touch a GUI. Its grants and
        // confirmation gates still apply. Phantom never drives its own GUI.
        if (target !== 'phantom' && ports.desk && !input.seat) {
          const result = await createDesktopAdapters(ports.desk)[target].start(prompt!);
          return result.ok ? { ok: true, handle: `desk-${target}:${result.handle}` } : result;
        }
        throw new Error('No matching seat; select an enrolled seat');
      }
      return createPhantomSelfDrive(ports.request, { projectPath: input.projectPath, seatId: seat['id'] }).start(prompt!);
    }
    // Verify ownership before reading or sending: handles cannot cross targets.
    const detail = await ports.request('GET', `/api/verse/sessions/${handle}`);
    const session = record(record(detail.json)['session']);
    if (detail.status !== 200 || (target !== 'phantom' && session['engine'] !== target)) throw new Error('Session target mismatch or unavailable');
    if (action === 'send-prompt') {
      const result = await ports.request('POST', `/api/verse/sessions/${handle}/turns`, { text: prompt!.trim() });
      return { ok: result.status === 202, handle };
    }
    const adapter = createPhantomSelfDrive(ports.request);
    return action === 'status' ? adapter.status(handle!) : adapter.collect(handle!);
  };
}
export function createAppAdapters(ports: AppPorts) {
  return Object.fromEntries(DRIVE_TARGETS.map(target => [target, createAppAdapter(target, ports)])) as Record<DriveTarget, ReturnType<typeof createAppAdapter>>;
}

/** Fixed numeric loopback origin, auth required, redirects forbidden. No server or TCC changes. */
export function loopbackAppRequest(origin: string, readToken: string, mutationToken: string): VerseRequest {
  const url = new URL(origin);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.pathname !== '/' || url.search || url.hash || !readToken || !mutationToken) throw new Error('Authenticated 127.0.0.1 origin required');
  return async (method, path, body) => {
    if (!/^\/api\/verse\/(bootstrap|sessions(?:\/[A-Za-z0-9_-]{1,80}(?:\/turns)?)?)$/.test(path)) throw new Error('Invalid drive API path');
    const response = await fetch(new URL(path, url), { method, redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: { 'x-ashlr-token': method === 'GET' ? readToken : mutationToken, 'content-type': 'application/json', origin: url.origin },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, json: await response.json() };
  };
}

/** Uses only an already-live chat turn bearer; never mints grants or confirmations. */
export function loopbackDeskCall(origin: string, bearer: string): ToolCall {
  loopbackAppRequest(origin, 'validate-origin', 'validate-origin');
  if (!/^[A-Za-z0-9_-]{43}$/.test(bearer)) throw new Error('Live turn bearer required');
  return async (name, args) => {
    const response = await fetch(new URL('/api/verse/agent-tools/mcp', origin), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    const body = record(await response.json());
    const result = record(body['result']);
    if (!response.ok || body['error'] || !Array.isArray(result['content'])) throw new Error('DESK refused operation');
    return result as unknown as Awaited<ReturnType<ToolCall>>;
  };
}
