import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdAsks } from '../src/cli/asks.js';
import { handleTelegramAskReply, isVerifiedTelegramOwner } from '../src/core/comms/telegram-ask-reply.js';
import {
  answerAsk, answerAskFromChannel, askOfLine, asksText, listAsks, parseAskReply, raiseAsk, type AsksOptions,
} from '../src/core/fleet/asks.js';
import { listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import { listNeedsMason } from '../src/core/fleet/needs-mason-resolve.js';
import { createAgentBusApi } from '../src/core/verse/agent-bus-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import type { AshlrConfig } from '../src/core/types.js';

const NOW = Date.parse('2026-11-17T15:00:00.000Z');
let home = '';
let opts: Required<Pick<AsksOptions, 'runsDir' | 'bus' | 'now'>>;
const ledger = () => join(opts.runsDir, 'NEEDS-MASON.md');
const busBodies = () => {
  const page = listBusInboxAfter(0, 100, opts.bus);
  return page.status === 'ok' ? page.messages.map(m => m.envelope.body as Record<string, unknown>) : [];
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'example-asks-'));
  mkdirSync(join(home, 'runs'));
  opts = { runsDir: join(home, 'runs'), bus: { root: join(home, 'fleet'), now: () => NOW }, now: () => NOW };
  writeFileSync(join(home, 'runs', 'NEEDS-MASON.md'), [
    '# Needs Mason',
    '- [ ] ask:device Approve the fake-device sign-in on the example-ask laptop (asked 2026-11-17T14:00:00.000Z)',
    '- [ ] Pick a fake vendor for the example-ask landing page',
    '- [ ] Enter the 2FA code for the example-ask account',
    '',
  ].join('\n'));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('listAsks', () => {
  it('lists only the four kinds, with created and age, and counts the rest as the fleet’s own', () => {
    const list = listAsks(opts);
    expect(Object.keys(list)).toEqual(['schema', 'asOf', 'ledger', 'count', 'asks', 'fleetDecides', 'expiredHidden']);
    expect(list).toMatchObject({ schema: 'asks.v1', asOf: '2026-11-17T15:00:00.000Z', ledger: 'available', count: 2, fleetDecides: 1 });
    expect(list.asks.map(ask => Object.keys(ask))).toEqual([
      ['id', 'shortId', 'kind', 'request', 'replies', 'replyHint', 'unblocks', 'subject', 'created', 'ageSeconds', 'expires'],
      ['id', 'shortId', 'kind', 'request', 'replies', 'replyHint', 'unblocks', 'subject', 'created', 'ageSeconds', 'expires']]);
    const [device, code] = list.asks;
    expect(device).toMatchObject({ kind: 'device', request: 'Approve the fake-device sign-in on the example-ask laptop', created: '2026-11-17T14:00:00.000Z', ageSeconds: 3600 });
    expect(device!.id).toMatch(/^nm-[0-9a-f]{12}$/);
    expect(device!.id.slice(3).startsWith(device!.shortId)).toBe(true);
    expect(device!.shortId.length).toBeGreaterThanOrEqual(4);
    expect(code).toMatchObject({ kind: '2fa', created: null, ageSeconds: null });
    expect(asksText(list)[2]).toContain('unknown');
  });

  it('is stable JSON: the same ledger and clock give byte-identical output', () => {
    expect(JSON.stringify(listAsks(opts))).toBe(JSON.stringify(listAsks(opts)));
  });

  it('says missing for no ledger and unavailable for an unreadable one, never a fake empty list', () => {
    rmSync(ledger());
    expect(listAsks(opts)).toMatchObject({ ledger: 'missing', count: 0, asks: [] });
    expect(asksText(listAsks(opts))).toEqual(['Nothing needs you.']);
    mkdirSync(ledger());
    expect(listAsks(opts)).toMatchObject({ ledger: 'unavailable', count: 0 });
    expect(asksText(listAsks(opts))[0]).toMatch(/unknown/);
  });

  it('classifies the four kinds by wording and leaves everything else to the fleet', () => {
    expect(askOfLine('Approve the example-ask payment for the fake plan')?.kind).toBe('payment');
    expect(askOfLine('Type the keychain password for the example-ask build')?.kind).toBe('password');
    expect(askOfLine('Confirm fake-device approval on the phone')?.kind).toBe('device');
    expect(askOfLine('Merge the example-ask pull request')).toBeNull();
  });
});

describe('answerAsk', () => {
  const ids = () => listAsks(opts).asks;

  it('records yes once with source and time, and the ask leaves the list', async () => {
    const [device] = ids();
    const outcome = await answerAsk(device!.shortId, 'yes', 'cli', opts);
    expect(outcome).toEqual({ schema: 'asks.answer.v1', status: 'answered', id: device!.id, kind: 'device', answer: 'yes',
      source: 'cli', answeredAt: '2026-11-17T15:00:00.000Z', reason: null });
    expect(busBodies()).toEqual([expect.objectContaining({ kind: 'needs_mason.resolved', itemId: device!.id, reply: 'yes', source: 'cli', resolvedAt: '2026-11-17T15:00:00.000Z' })]);
    expect(listAsks(opts).asks.map(ask => ask.id)).not.toContain(device!.id);
    expect(listNeedsMason(opts).map(item => item.id)).not.toContain(device!.id);
  });

  it('is idempotent: a second answer, even a different word, changes nothing and returns the first', async () => {
    const [, code] = ids();
    expect((await answerAsk(code!.id, 'done', 'telegram', opts)).status).toBe('answered');
    const before = readFileSync(ledger(), 'utf8');
    const again = await answerAsk(code!.id, 'no', 'cli', { ...opts, now: () => NOW + 60_000 });
    expect(again).toMatchObject({ status: 'already-answered', id: code!.id, answer: 'done', source: 'telegram', answeredAt: '2026-11-17T15:00:00.000Z' });
    expect(busBodies()).toHaveLength(1);
    expect(readFileSync(ledger(), 'utf8')).toBe(before);
  });

  it('refuses an unknown id, a bad word and a malformed id without writing', async () => {
    expect(await answerAsk('ffffffffffff', 'yes', 'cli', opts)).toMatchObject({ status: 'unknown', id: null, reason: 'No ask has that id.' });
    expect(await answerAsk(ids()[0]!.id, 'maybe', 'cli', opts)).toMatchObject({ status: 'invalid' });
    expect(await answerAsk('not an id', 'yes', 'cli', opts)).toMatchObject({ status: 'invalid' });
    expect(busBodies()).toEqual([]);
  });

  it('refuses a ledger line that is not one of the four kinds: the fleet decides this itself', async () => {
    const vendor = listNeedsMason(opts).find(item => item.text.startsWith('Pick a fake vendor'))!;
    const outcome = await answerAsk(vendor.id, 'yes', 'cli', opts);
    expect(outcome).toMatchObject({ status: 'refused', id: vendor.id, reason: 'the fleet decides this itself' });
    expect(busBodies()).toEqual([]);
    expect(listNeedsMason(opts).map(item => item.id)).toContain(vendor.id);
  });

  it('reports unavailable when the bus refuses, and leaves the ask open', async () => {
    const [device] = ids();
    const resolve = vi.fn(async () => ({ ok: false as const, code: 'unavailable' as const, error: 'no bus', inbox: 'failed' as const }));
    expect(await answerAsk(device!.id, 'yes', 'cli', opts, { resolve })).toMatchObject({ status: 'unavailable' });
    expect(ids().map(ask => ask.id)).toContain(device!.id);
  });
});

describe('raiseAsk', () => {
  it('writes a tagged line with the time, dedupes an identical open ask and refuses other kinds', () => {
    const raised = raiseAsk('payment', 'Approve the example-ask top-up for the fake plan', { ...opts, now: () => NOW - 120_000 });
    expect(raised).toMatchObject({ ok: true, duplicate: false });
    expect(raiseAsk('payment', 'Approve the example-ask top-up for the fake plan', opts)).toEqual({ ...raised, duplicate: true });
    const ask = listAsks(opts).asks.find(row => raised.ok && row.id === raised.id);
    expect(ask).toMatchObject({ kind: 'payment', created: '2026-11-17T14:58:00.000Z', ageSeconds: 120 });
    expect(raiseAsk('merge', 'Merge the example-ask change', opts)).toEqual({ ok: false, reason: 'the fleet decides this itself' });
    expect(raiseAsk('2fa', '   ', opts)).toMatchObject({ ok: false });
  });
});

describe('channel replies', () => {
  it('parses one word plus the short id in either order, and nothing else', () => {
    expect(parseAskReply('yes 3f2a')).toEqual({ id: '3f2a', answer: 'yes' });
    expect(parseAskReply('  3F2A done. ')).toEqual({ id: '3f2a', answer: 'done' });
    expect(parseAskReply('No nm-3f2a1b2c3d4e')).toEqual({ id: 'nm-3f2a1b2c3d4e', answer: 'no' });
    for (const text of ['yes', 'yes please', 'yes 3f2a now', 'ok 3f2a', 'yes 3f', 'yes zzzz', '/resolve nm-3f2a1b2c3d4e']) expect(parseAskReply(text)).toBeNull();
  });

  it('answers a verified reply and ignores an unverified sender or an id that matches no ask', async () => {
    const [device] = listAsks(opts).asks;
    expect(await answerAskFromChannel(`yes ${device!.shortId}`, { verified: false, source: 'telegram' }, opts)).toBeNull();
    expect(busBodies()).toEqual([]);
    expect(await answerAskFromChannel('no cafe', { verified: true, source: 'telegram' }, opts)).toBeNull();
    expect(await answerAskFromChannel(`yes ${device!.shortId}`, { verified: true, source: 'telegram' }, opts))
      .toMatchObject({ status: 'answered', source: 'telegram', answer: 'yes' });
  });

  it('Telegram: only Mason’s own private chat reaches answerAsk, and he gets a plain reply', async () => {
    const cfg = { comms: { telegram: { chatId: '4242' } } } as AshlrConfig;
    const send = vi.fn(async () => ({ ok: true as const }));
    const [device] = listAsks(opts).asks;
    const text = `done ${device!.shortId}`;
    for (const evidence of [{ fromChatId: '9999', senderUserId: 9999, privateChat: true }, { fromChatId: '4242', senderUserId: 9999, privateChat: true },
      { fromChatId: '4242', senderUserId: 4242, privateChat: false }, { fromChatId: '4242' }]) {
      const event = { kind: 'text' as const, ...evidence };
      expect(isVerifiedTelegramOwner(event, cfg)).toBe(false);
      expect(await handleTelegramAskReply(event, text, cfg, { send, options: opts })).toBe(false);
    }
    expect(send).not.toHaveBeenCalled();
    expect(busBodies()).toEqual([]);
    const mason = { kind: 'text' as const, fromChatId: '4242', senderUserId: 4242, privateChat: true, messageId: 7 };
    expect(await handleTelegramAskReply(mason, text, cfg, { send, options: opts })).toBe(true);
    expect(send).toHaveBeenLastCalledWith(`Got it: done to device ask ${device!.id.slice(3, 7)}.`, { replyToMessageId: 7 }, cfg);
    expect(await handleTelegramAskReply(mason, text, cfg, { send, options: opts })).toBe(true);
    expect(send).toHaveBeenLastCalledWith(`Already answered done to ask ${device!.id.slice(3, 7)}; nothing changed.`, { replyToMessageId: 7 }, cfg);
    expect(busBodies()).toEqual([expect.objectContaining({ source: 'telegram', reply: 'done' })]);
    expect(await handleTelegramAskReply(mason, 'how is the fleet doing', cfg, { send, options: opts })).toBe(false);
  });
});

describe('phm asks', () => {
  let out: string[] = [];
  beforeEach(() => { out = []; vi.spyOn(console, 'log').mockImplementation((line: string) => { out.push(line); }); vi.spyOn(console, 'error').mockImplementation(() => {}); });
  afterEach(() => vi.restoreAllMocks());

  it('lists as JSON, answers, and refuses with exit codes an agent can branch on', async () => {
    expect(await cmdAsks(['--json'], { options: opts })).toBe(0);
    const list = JSON.parse(out.pop()!) as { count: number; asks: Array<{ id: string; shortId: string }> };
    expect(list.count).toBe(2);
    expect(await cmdAsks(['answer', list.asks[0]!.shortId, 'YES', '--json'], { options: opts })).toBe(0);
    expect(JSON.parse(out.pop()!)).toMatchObject({ status: 'answered', source: 'cli', answer: 'yes' });
    expect(await cmdAsks(['answer', list.asks[0]!.shortId, 'yes'], { options: opts })).toBe(0);
    expect(out.pop()).toMatch(/^Already answered yes/);
    expect(await cmdAsks(['answer', 'ffffffff', 'yes'], { options: opts })).toBe(1);
    expect(await cmdAsks(['answer', list.asks[1]!.id, 'perhaps'], { options: opts })).toBe(2);
    expect(await cmdAsks(['answer'], { options: opts })).toBe(2);
    expect(await cmdAsks(['add', 'merge', 'Merge the example-ask change'], { options: opts })).toBe(1);
    expect(out.pop()).toBe('Not asked: the fleet decides this itself.');
    expect(await cmdAsks(['--help'])).toBe(0);
  });
});

describe('agent-bus asks routes', () => {
  async function call(url: string, method: string, body?: unknown, o: { dispatch?: boolean } = {}) {
    const handler = createAgentBusApi({ asks: { list: () => listAsks(opts), answer: (id, answer) => answerAsk(id, answer, 'desktop', opts) } });
    const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]) as unknown as IncomingMessage;
    req.url = url; req.method = method;
    req.headers = { 'content-type': 'application/json', 'x-ashlr-token': 'example-unlock' };
    let status = 0, wire: Record<string, unknown> = {};
    const res = { headersSent: false, writeHead(code: number) { status = code; this.headersSent = true; },
      end(text: string) { wire = JSON.parse(text) as Record<string, unknown>; } } as unknown as ServerResponse;
    const ctx = { cfg: {}, token: 'example-unlock', allowDispatch: o.dispatch ?? true,
      readSession: { id: 'example-session', expiresAt: Date.now() + 60_000 } } as VerseApiContext;
    await handler(ctx, req, res, url, method);
    return { status, wire };
  }

  it('serves asks.v1 and records a desktop answer behind the mutation gate', async () => {
    const listed = await call('/api/verse/agent-bus/needs-mason/asks', 'GET');
    expect(listed).toMatchObject({ status: 200, wire: { schema: 'asks.v1', count: 2 } });
    const id = (listed.wire.asks as Array<{ id: string }>)[0]!.id;
    const path = '/api/verse/agent-bus/needs-mason/asks/answer';
    expect((await call(path, 'POST', { id, answer: 'yes' }, { dispatch: false })).status).toBe(404);
    expect(busBodies()).toEqual([]);
    expect(await call(path, 'POST', { id, answer: 'yes' })).toMatchObject({ status: 200, wire: { status: 'answered', source: 'desktop' } });
    expect(await call(path, 'POST', { id, answer: 'no' })).toMatchObject({ status: 200, wire: { status: 'already-answered', answer: 'yes' } });
    expect((await call(path, 'POST', { id: 'ffffffffffff', answer: 'yes' })).status).toBe(404);
    expect((await call(path, 'POST', { id, answer: 'yes', extra: 1 })).status).toBe(400);
    const vendor = listNeedsMason(opts).find(item => item.text.startsWith('Pick'))!;
    expect(await call(path, 'POST', { id: vendor.id, answer: 'yes' })).toMatchObject({ status: 403, wire: { reason: 'the fleet decides this itself' } });
    expect((await call(path, 'GET')).status).toBe(404);
  });
});
