import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseResolveCommand, renderNeedsCommandReply, runTelegramNeedsCommand, type TelegramNeedsCommandDeps } from '../src/core/comms/telegram-needs-command.js';
import { listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import { listNeedsMason, resolveNeedsMason } from '../src/core/fleet/needs-mason-resolve.js';
import { handleSlashCommand } from '../src/core/comms/telegram-channel.js';
import { setTelegramSendClockForTests, setTelegramTransportForTests, type InboundEvent } from '../src/core/integrations/telegram.js';
import type { AshlrConfig } from '../src/core/types.js';

const id = 'nm-0123456789ab';
const item = (n: number, text = `fake item ${n}`) => ({ id: `nm-${String(n).padStart(12, '0')}`, text });
const deps = (): TelegramNeedsCommandDeps => ({
  list: vi.fn().mockReturnValue([item(1)]),
  resolve: vi.fn().mockReturnValue({ ok: true, itemId: id, cursor: 1, duplicate: false }),
});
const cfg = { comms: { enabled: true, channel: 'telegram', telegram: { chatId: '4242', botToken: 'fake' } } } as AshlrConfig;

describe('parseResolveCommand', () => {
  it('accepts an id with and without reply, and the @bot suffix', () => {
    expect(parseResolveCommand(`/resolve ${id}`)).toEqual({ itemId: id });
    expect(parseResolveCommand(`/resolve@somebot ${id}  ship it\nnow `)).toEqual({ itemId: id, reply: 'ship it now' });
  });
  it.each(['/resolve', '/resolve nm-0123456789a', '/resolve nm-0123456789abc', '/resolve nm-0123456789zz', '/resolve NM-0123456789AB', '/resolve 0123456789ab'])('rejects %s', text => {
    expect(parseResolveCommand(text)).toBeNull();
  });
});

describe('runTelegramNeedsCommand', () => {
  it('lists, caps at 10 with +N more, clips text, and handles empty', async () => {
    const many = Array.from({ length: 13 }, (_, i) => item(i + 1, i === 0 ? 'x'.repeat(300) : undefined));
    const d = deps();
    vi.mocked(d.list).mockReturnValue(many);
    const lines = renderNeedsCommandReply(await runTelegramNeedsCommand('/needs', d)).split('\n');
    expect(lines).toHaveLength(11);
    expect(lines[0]).toBe(`${many[0]!.id}: ${'x'.repeat(99)}…`);
    expect(lines[10]).toBe('+3 more');
    vi.mocked(d.list).mockReturnValue([]);
    expect(renderNeedsCommandReply(await runTelegramNeedsCommand('/needs@somebot', d))).toBe('Nothing needs you.');
  });

  it('resolves with source telegram and the reply', async () => {
    const d = deps();
    expect(renderNeedsCommandReply(await runTelegramNeedsCommand(`/resolve ${id} approved`, d))).toBe(`Resolved ${id}.`);
    expect(d.resolve).toHaveBeenCalledWith({ itemId: id, reply: 'approved' }, { source: 'telegram' });
  });

  it('returns usage without resolving for a bad id', async () => {
    const d = deps();
    expect(renderNeedsCommandReply(await runTelegramNeedsCommand('/resolve nope', d))).toBe('Usage: /resolve <nm-id> [reply]');
    expect(d.resolve).not.toHaveBeenCalled();
  });

  it.each([
    ['unknown', 'no such needs-you item'], ['already-resolved', 'item is already resolved'],
    ['reply-too-long', 'reply is too long'], ['invalid', 'request was not valid'],
  ] as const)('maps refusal %s to fixed text', async (code, text) => {
    const d = deps();
    vi.mocked(d.resolve).mockReturnValue({ ok: false, code, error: '/secret/path leaked' });
    expect(renderNeedsCommandReply(await runTelegramNeedsCommand(`/resolve ${id}`, d))).toBe(`Resolve refused: ${text}.`);
  });

  it('reports failed without leaking error text when a dep throws or is unavailable', async () => {
    const d = deps();
    vi.mocked(d.resolve).mockImplementation(() => { throw new Error('EACCES /Users/fake/secret'); });
    vi.mocked(d.list).mockImplementation(() => { throw new Error('EACCES /Users/fake/secret'); });
    for (const text of ['/needs', `/resolve ${id}`]) {
      const reply = await runTelegramNeedsCommand(text, d);
      expect(reply.status).toBe('failed');
      expect(renderNeedsCommandReply(reply)).not.toMatch(/EACCES|secret|Users/);
    }
    vi.mocked(d.resolve).mockReturnValue({ ok: false, code: 'unavailable', error: '/secret' });
    expect((await runTelegramNeedsCommand(`/resolve ${id}`, d)).status).toBe('failed');
  });
});

describe('real resolveNeedsMason', () => {
  let home = '';
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'fake-tg-needs-')); mkdirSync(join(home, 'runs')); });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('records source telegram on the bus envelope', async () => {
    writeFileSync(join(home, 'runs', 'NEEDS-MASON.md'), '# Needs\n- [ ] Approve the fake deploy\n');
    const now = () => 1_800_000_000_000;
    const o = { runsDir: join(home, 'runs'), bus: { root: join(home, 'fleet'), now }, now };
    const [first] = listNeedsMason(o);
    const reply = await runTelegramNeedsCommand(`/resolve ${first!.id} go`, { list: listNeedsMason, resolve: (input, opts) => resolveNeedsMason(input, { ...o, ...opts }) });
    expect(reply.status).toBe('resolved');
    const page = listBusInboxAfter(0, 10, o.bus);
    const bodies = page.status === 'ok' ? page.messages.map(m => m.envelope.body as Record<string, unknown>) : [];
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ source: 'telegram', reply: 'go', itemId: first!.id });
  });
});

describe('handleSlashCommand identity', () => {
  let sent: Record<string, unknown>[] = [];
  beforeEach(() => {
    sent = [];
    let now = 0;
    setTelegramSendClockForTests({ now: () => now, sleep: async ms => { now += ms; } });
    setTelegramTransportForTests(async (_m, body) => { sent.push(body); return { ok: true, result: { message_id: 55 } }; });
  });
  afterEach(() => { setTelegramTransportForTests(null); setTelegramSendClockForTests(null); });

  it('gives a non-private chat no reply', async () => {
    const event: InboundEvent = { kind: 'text', fromChatId: '4242', senderUserId: 4242, privateChat: false, messageId: 10 };
    expect(await handleSlashCommand(event, '/needs', cfg)).toBe(true);
    expect(await handleSlashCommand(event, `/resolve ${id}`, cfg)).toBe(true);
    expect(sent).toEqual([]);
  });
});
