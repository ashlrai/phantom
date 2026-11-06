import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSlackApi, deliverSlackEnvelope, observeSlackAudience, openSlackSocket, receiveSlackSocketEnvelope, verifySlackIdentity, type SlackCall } from '../src/core/agents/slack-transport.js';
import { slackEventToBus, unwrapSlackSocketEnvelope } from '../src/core/agents/slack-inbound.js';
import { evaluateSlackAudience } from '../src/core/agents/slack-audience.js';
import type { SlackBridgeConfig } from '../src/core/agents/slack-network.js';
import type { BusEnvelope } from '../src/core/fleet/bus-envelope.js';

const roots: string[] = [];
const root = (): string => { const p = mkdtempSync(join(tmpdir(), 'slack-transport-')); roots.push(p); return p; };
afterEach(() => { roots.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })); });
const config: SlackBridgeConfig = { bridgeId: 'slack', teamId: 'T0TEAM', ownUserId: 'U0BOT', ownBotId: 'B0BOT',
  botTokenRef: 'phm_SLACK_AGENTNET_BOT_TOKEN', appTokenRef: 'phm_SLACK_AGENTNET_APP_TOKEN', map: [{ topic: 'leader', channel: 'D0LEADER' }] };
const team = [{ channel: 'slack' as const, id: 'U0MASON' }];
const envelope: BusEnvelope = { id: 'result-1', from: 'phantom:leader', to: 'leader', ttl: 60000, priority: 'P1', body: { kind: 'note', text: 'The signed candidate is ready for verification.' } };
const identity = { ok: true, team_id: 'T0TEAM', user_id: 'U0BOT', bot_id: 'B0BOT' };
function fakeCall(options: { post?: (input: Record<string, unknown>) => Promise<Record<string, unknown>>; history?: () => Record<string, unknown>; auth?: Record<string, unknown> } = {}): SlackCall {
  return vi.fn(async (method, input = {}) => {
    if (method === 'auth.test') return options.auth ?? identity;
    if (method === 'conversations.info') return { channel: { id: input.channel, is_im: true, context_team_id: config.teamId } };
    if (method === 'conversations.members') return { members: ['U0BOT', 'U0MASON'], response_metadata: { next_cursor: '' } };
    if (method === 'users.info') return { user: { id: input.user, team_id: config.teamId, ...(input.user === 'U0BOT' ? { is_bot: true } : {}) } };
    if (method === 'chat.postMessage') return options.post ? options.post(input) : { channel: input.channel, ts: '1793920000.000001' };
    if (method === 'conversations.history' || method === 'conversations.replies') return options.history?.() ?? { messages: [] };
    throw new Error('unexpected-fake-method');
  });
}
const deliveryInput = (call: SlackCall, stateRoot = root()) => ({ config, teamIdentities: team, confirmedByMason: true, call, stateRoot });
const event = { type: 'message', channel: 'D0LEADER', user: 'U0MASON', ts: '1793920000.000001', text: 'What actually shipped?' };
const socketEnvelope = { type: 'events_api', envelope_id: 'delivery-1', payload: { team_id: 'T0TEAM', event_id: 'Ev1', event } };

describe('Slack authenticated receive and delivery', () => {
  it('reads portable stream chunks and decodes split UTF-8 only after assembly', async () => {
    const bytes = Buffer.from(JSON.stringify({ ok: true, text: 'FAKE café' }));
    const split = bytes.indexOf(0xc3) + 1;
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(bytes.subarray(0, split)); controller.enqueue(bytes.subarray(split)); controller.close();
    } });
    Object.defineProperty(stream, Symbol.asyncIterator, { value: undefined });
    const call = createSlackApi({ config, resolveCredential: () => 'FAKE_EXAMPLE_BOT_CREDENTIAL',
      fetch: vi.fn(async () => new Response(stream)) as typeof fetch });
    await expect(call('auth.test')).resolves.toMatchObject({ text: 'FAKE café' });
    expect(stream.locked).toBe(false);
  });
  it('cancels the acquired reader on total size overflow and releases its lock', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new Uint8Array(600_000)); controller.enqueue(new Uint8Array(600_000));
    }, cancel });
    const call = createSlackApi({ config, resolveCredential: () => 'FAKE_EXAMPLE_BOT_CREDENTIAL',
      fetch: vi.fn(async () => new Response(stream)) as typeof fetch });
    await expect(call('auth.test')).rejects.toThrow('slack-response-too-large');
    expect(cancel).toHaveBeenCalledOnce(); expect(stream.locked).toBe(false);
  });
  it('keeps the request deadline signal and hides response-reader failures', async () => {
    const session = new AbortController();
    let requestSignal: AbortSignal | null | undefined;
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      session.signal.addEventListener('abort', () => controller.error(new Error('FAKE private response')), { once: true });
    } });
    const request: typeof fetch = async (_url, init) => { requestSignal = init?.signal; return new Response(stream); };
    const call = createSlackApi({ config, signal: session.signal, resolveCredential: () => 'FAKE_EXAMPLE_BOT_CREDENTIAL', fetch: request });
    const pending = call('auth.test'); session.abort();
    await expect(pending).rejects.toThrow('slack-network-uncertain');
    expect(requestSignal?.aborted).toBe(true); expect(stream.locked).toBe(false);
  });
  it('binds real Events API outer workspace and marks origin to suppress echoes', () => {
    const raw = unwrapSlackSocketEnvelope(socketEnvelope);
    expect('event' in raw && raw.event).toMatchObject({ team: 'T0TEAM' });
    const result = slackEventToBus('event' in raw ? raw.event : null, { config, teamIdentities: team });
    expect(result).toMatchObject({ status: 'ingest', envelope: { to: 'leader', origin_bridge: 'slack', sender: { human: true } } });
    const conflict = unwrapSlackSocketEnvelope({ ...socketEnvelope, payload: { ...socketEnvelope.payload, event: { ...event, team: 'T0OTHER' } } });
    expect(slackEventToBus('event' in conflict ? conflict.event : null, { config, teamIdentities: team })).toMatchObject({ status: 'ignore', reason: 'foreign-team' });
  });
  it('acknowledges only after durable bus acceptance', () => {
    const ack = vi.fn(), ctx = { config, teamIdentities: team, runsDir: root(), publish: vi.fn(() => ({ status: 'unavailable' as const })) };
    expect(receiveSlackSocketEnvelope(socketEnvelope, ctx, ack)).toBe(false);
    expect(ack).not.toHaveBeenCalled();
    expect(receiveSlackSocketEnvelope(socketEnvelope, { ...ctx, publish: () => ({ status: 'duplicate', id: 'same', cursor: 1 }) }, ack)).toBe(true);
    expect(ack).toHaveBeenCalledExactlyOnceWith('delivery-1');
  });
  it('rejects wrong workspace and bot identities before any socket or post', async () => {
    const call = fakeCall({ auth: { ...identity, team_id: 'T0OTHER' } });
    await expect(verifySlackIdentity(call, config)).rejects.toThrow('slack-identity-mismatch');
    expect(await deliverSlackEnvelope(envelope, deliveryInput(call))).toMatchObject({ status: 'uncertain' });
    expect(vi.mocked(call).mock.calls.every(c => c[0] === 'auth.test')).toBe(true);
  });
  it('posts once to an explicitly mapped proved direct conversation and saves no body', async () => {
    const call = fakeCall(), input = deliveryInput(call);
    expect(await deliverSlackEnvelope(envelope, input)).toMatchObject({ status: 'sent' });
    expect(await deliverSlackEnvelope(envelope, input)).toMatchObject({ status: 'duplicate' });
    expect(vi.mocked(call).mock.calls.filter(c => c[0] === 'chat.postMessage')).toHaveLength(1);
    const saved = readFileSync(join(input.stateRoot, 'messages.json'), 'utf8');
    expect(saved).not.toContain('signed candidate');
    expect(saved).not.toContain('SLACK_AGENTNET');
  });
  it('persists intent before sending and reconciles an uncertain send without repeating it', async () => {
    let sentId = '';
    const stateRoot = root();
    const call = fakeCall({ post: async args => {
      sentId = args.client_msg_id as string;
      expect(readFileSync(join(stateRoot, 'messages.json'), 'utf8')).toContain('attempted');
      throw new Error('FAKE network accepted then disconnected');
    }, history: () => ({ messages: [{ client_msg_id: sentId, user: 'U0BOT', ts: '1793920000.000002' }] }) });
    const input = deliveryInput(call, stateRoot);
    expect(await deliverSlackEnvelope(envelope, input)).toMatchObject({ status: 'uncertain' });
    expect(await deliverSlackEnvelope(envelope, input)).toMatchObject({ status: 'sent', reason: 'delivery-reconciled' });
    expect(vi.mocked(call).mock.calls.filter(c => c[0] === 'chat.postMessage')).toHaveLength(1);
  });
  it('never retries absent or spoofed uncertain-send evidence', async () => {
    const call = fakeCall({ post: async () => { throw new Error('FAKE timeout'); }, history: () => ({ messages: [{ client_msg_id: 'other', user: 'U0MASON', ts: '1793920000.000002' }] }) });
    const input = deliveryInput(call);
    await deliverSlackEnvelope(envelope, input);
    expect(await deliverSlackEnvelope(envelope, input)).toMatchObject({ status: 'uncertain', reason: 'delivery-needs-reconciliation' });
    expect(vi.mocked(call).mock.calls.filter(c => c[0] === 'chat.postMessage')).toHaveLength(1);
  });
  it('refuses message-ID reuse with changed context', async () => {
    const input = deliveryInput(fakeCall()); await deliverSlackEnvelope(envelope, input);
    expect(await deliverSlackEnvelope({ ...envelope, body: { kind: 'note', text: 'Different action' } }, input)).toMatchObject({ status: 'refused', reason: 'message-identity-conflict' });
  });
  it('requires current human communication confirmation before sending', async () => {
    const call = fakeCall();
    expect(await deliverSlackEnvelope(envelope, { ...deliveryInput(call), confirmedByMason: false })).toMatchObject({ status: 'refused', reason: 'communication-not-approved' });
    expect(vi.mocked(call).mock.calls.some(c => c[0] === 'chat.postMessage')).toBe(false);
  });
  it('refuses outside membership, guests and incomplete pagination', async () => {
    const snapshot = { conversation: { id: 'D0LEADER', is_im: true }, members: [{ id: 'U0MASON', team_id: 'T0TEAM' }], complete: true };
    expect(evaluateSlackAudience(config, team, 'D0LEADER', snapshot).status).toBe('postable');
    expect(evaluateSlackAudience(config, team, 'D0LEADER', { ...snapshot, complete: false }).status).toBe('uncertain');
    expect(evaluateSlackAudience(config, team, 'D0LEADER', { ...snapshot, members: [{ id: 'U0MASON', team_id: 'T0OTHER' }] }).status).toBe('refused');
    expect(evaluateSlackAudience(config, team, 'D0LEADER', { ...snapshot, members: [{ id: 'U0MASON', team_id: 'T0TEAM', is_restricted: true }] }).status).toBe('refused');
    const call: SlackCall = async method => method === 'conversations.info' ? { channel: { id: 'D0LEADER' } } : { members: ['U0MASON'], response_metadata: { next_cursor: 'same' } };
    await expect(observeSlackAudience(call, 'D0LEADER')).rejects.toThrow('slack-membership-duplicate');
  });
  it('does not forward an inbound bridge echo back to Slack', async () => {
    const call = fakeCall();
    expect(await deliverSlackEnvelope({ ...envelope, channel: 'slack', channel_ref: 'slack:T0TEAM:D0LEADER:1793920000.000001',
      sender: { agent_id: 'U0MASON', vendor: 'slack', human: true, team: true }, external: false, origin_bridge: 'slack' }, deliveryInput(call))).toMatchObject({ status: 'refused', reason: 'own-bridge' });
    expect(call).not.toHaveBeenCalled();
  });
  it('keeps private channel bodies local even when the local topic is mapped to Slack', async () => {
    const call = fakeCall();
    expect(await deliverSlackEnvelope({ ...envelope, channel: 'imessage', channel_ref: 'imessage:local',
      sender: { agent_id: 'dot', vendor: 'local', human: false, team: true }, external: false }, deliveryInput(call))).toMatchObject({ status: 'refused', reason: 'private-source' });
    expect(call).not.toHaveBeenCalled();
  });
  it('reclaims terminal receipts after their bus TTL while retaining uncertain intents', async () => {
    const input = deliveryInput(fakeCall());
    await deliverSlackEnvelope(envelope, input);
    const path = join(input.stateRoot, 'messages.json');
    const saved = JSON.parse(readFileSync(path, 'utf8'));
    Object.values(saved.messages).forEach(value => { (value as { expiresAt: number }).expiresAt = Date.now() - 1; });
    writeFileSync(path, JSON.stringify(saved), { mode: 0o600 });
    expect(await deliverSlackEnvelope({ ...envelope, id: 'new-result' }, input)).toMatchObject({ status: 'sent' });
    expect(Object.keys(JSON.parse(readFileSync(path, 'utf8')).messages)).toHaveLength(1);
  });
  it('keeps credential values in fixed-origin HTTP headers, never API arguments or errors', async () => {
    const request = vi.fn(async () => new Response(JSON.stringify(identity)));
    const call = createSlackApi({ config, resolveCredential: () => 'FAKE_EXAMPLE_BOT_CREDENTIAL', fetch: request as typeof fetch });
    await call('auth.test');
    expect(request.mock.calls).toHaveLength(1);
    await expect(call('arbitrary.method')).rejects.toThrow('slack-method-refused');
    const fail = createSlackApi({ config, resolveCredential: () => 'FAKE_EXAMPLE_BOT_CREDENTIAL', fetch: vi.fn(async () => { throw new Error('FAKE_EXAMPLE_BOT_CREDENTIAL'); }) as typeof fetch });
    await expect(fail('auth.test')).rejects.toThrow('slack-network-uncertain');
  });
  it('opens only an identity-bound Slack socket and never acknowledges failed append', async () => {
    let handler: ((event: { data?: unknown }) => void) | undefined;
    const socket = { readyState: 1, addEventListener: (_: string, fn: typeof handler) => { handler = fn; }, send: vi.fn(), close: vi.fn() };
    const call: SlackCall = async method => method === 'auth.test' ? identity : { url: 'wss://wss-primary.slack.com/FAKE-EXAMPLE' };
    await openSlackSocket({ call, config, ingest: { config, teamIdentities: team, runsDir: root(), publish: () => ({ status: 'unavailable' }) }, connect: () => socket });
    handler?.({ data: JSON.stringify(socketEnvelope) }); expect(socket.send).not.toHaveBeenCalled();
    const connect = vi.fn(() => socket);
    await expect(openSlackSocket({ call: async method => method === 'auth.test' ? identity : { url: 'wss://attacker.example/FAKE-EXAMPLE' }, config, ingest: { config, teamIdentities: team }, connect })).rejects.toThrow('slack-socket-url-invalid');
    expect(connect).not.toHaveBeenCalled();
  });
  it('refuses to report a healthy session when the WebSocket cannot open', async () => {
    const handlers: Record<string, (event: { data?: unknown }) => void> = {};
    const call: SlackCall = async method => method === 'auth.test' ? identity : { url: 'wss://wss-primary.slack.com/FAKE-EXAMPLE' };
    await expect(openSlackSocket({ call, config, ingest: { config, teamIdentities: team }, connect: () => {
      queueMicrotask(() => handlers.error?.({}));
      return { readyState: 0, addEventListener: (name, fn) => { handlers[name] = fn; }, send: vi.fn(), close: vi.fn() };
    } })).rejects.toThrow('slack-socket-unavailable');
  });
});
