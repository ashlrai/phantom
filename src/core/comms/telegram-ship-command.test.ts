import { beforeEach, describe, expect, it, vi } from 'vitest';
import { recordTelegramToInbox } from './telegram-inbox-bridge.js';
import { shipCommandReply, type ShipCommandDeps } from './telegram-ship-command.js';
import type { InboundEvent, TelegramSendOpts, TelegramSendResult } from '../integrations/telegram.js';
import type { AshlrConfig } from '../types.js';
import type { ReleasePrV1 } from '../verse/ops-release-pr.js';
import type { OpsRunner } from '../verse/ops-releases.js';

const pr = (overrides: Partial<ReleasePrV1> = {}): ReleasePrV1 => ({
  number: 42, title: 'chore(phantom): release 1.2.3', url: null, version: '1.2.3',
  openedAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z',
  mergeable: 'MERGEABLE', checks: [], failing: [], pending: 0, blocked: false,
  summary: '1.2.3 green, waiting for merge', ...overrides,
});
const run: OpsRunner = async () => null;
const setup = () => {
  const probe = vi.fn<NonNullable<ShipCommandDeps['probe']>>(async () => pr());
  const merge = vi.fn<NonNullable<ShipCommandDeps['merge']>>(async () => ({ ok: true, sha: 'abcdef123456' }));
  let time = 1_000;
  return { probe, merge, run, now: () => time, advance: (ms: number) => { time += ms; } };
};
beforeEach(async () => { await shipCommandReply('/ship confirm', { run }); });

describe('Telegram ship command', () => {
  it('arms a green release, confirms once, and reports the merge sha', async () => {
    const deps = setup();
    const reply = await shipCommandReply('/ship@ExampleBot', deps);
    expect(reply).toContain('#42');
    expect(reply).toContain('1.2.3');
    expect(reply).toContain('Reply /ship confirm within 10 minutes to merge.');
    expect(await shipCommandReply('/SHIP confirm', deps)).toContain('Merged #42 (sha abcdef123456)');
    expect(deps.merge).toHaveBeenCalledOnce();
    expect(await shipCommandReply('/ship confirm', deps)).toBe('Nothing armed, send /ship first.');
    expect(deps.merge).toHaveBeenCalledOnce();
  });

  it('expires after ten minutes', async () => {
    const deps = setup();
    await shipCommandReply('/ship', deps);
    deps.advance(10 * 60_000);
    expect(await shipCommandReply('/ship confirm', deps)).toBe('Nothing armed, send /ship first.');
    expect(deps.merge).not.toHaveBeenCalled();
  });

  it('refuses a different PR or changed update time', async () => {
    const deps = setup();
    await shipCommandReply('/ship', deps);
    deps.probe.mockResolvedValueOnce(pr({ number: 43 }));
    expect(await shipCommandReply('/ship confirm', deps)).toContain('changed to #43');
    await shipCommandReply('/ship', deps);
    deps.probe.mockResolvedValueOnce(pr({ updatedAt: '2026-11-01T01:00:00Z' }));
    expect(await shipCommandReply('/ship confirm', deps)).toContain('changed; send /ship first');
    expect(deps.merge).not.toHaveBeenCalled();
  });

  it('names blockers and does not arm, including conflicts', async () => {
    const deps = setup();
    deps.probe.mockResolvedValueOnce(pr({ blocked: true, failing: ['CI'], summary: 'blocked by CI' }));
    expect(await shipCommandReply('/ship', deps)).toContain('CI');
    expect(await shipCommandReply('/ship confirm', deps)).toBe('Nothing armed, send /ship first.');
    deps.probe.mockResolvedValueOnce(pr({ mergeable: 'CONFLICTING' }));
    expect(await shipCommandReply('/ship', deps)).toContain('merge conflicts');
    expect(await shipCommandReply('/ship confirm', deps)).toBe('Nothing armed, send /ship first.');
    expect(deps.merge).not.toHaveBeenCalled();
  });

  it('refuses a PR that becomes red and consumes the confirmation', async () => {
    const deps = setup();
    await shipCommandReply('/ship', deps);
    deps.probe.mockResolvedValueOnce(pr({ pending: 1, summary: 'waiting on checks' }));
    expect(await shipCommandReply('/ship confirm', deps)).toContain('waiting on checks');
    expect(await shipCommandReply('/ship confirm', deps)).toBe('Nothing armed, send /ship first.');
    expect(deps.merge).not.toHaveBeenCalled();
  });

  it('does not allow another arm or confirmation while a merge is in flight', async () => {
    const deps = setup();
    let finish!: (value: { ok: true; sha: string }) => void;
    deps.merge.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await shipCommandReply('/ship', deps);
    const first = shipCommandReply('/ship confirm', deps);
    await vi.waitFor(() => expect(deps.merge).toHaveBeenCalledOnce());
    expect(await shipCommandReply('/ship', deps)).toContain('already in progress');
    expect(await shipCommandReply('/ship confirm', deps)).toContain('already in progress');
    finish({ ok: true, sha: 'abcdef123456' });
    expect(await first).toContain('Merged #42');
    expect(await shipCommandReply('/ship confirm', deps)).toBe('Nothing armed, send /ship first.');
    expect(deps.merge).toHaveBeenCalledOnce();
  });

  it('scrubs merge errors and removes external links', async () => {
    const deps = setup();
    deps.merge.mockResolvedValueOnce({ ok: false, code: 'gh-failed', detail: 'token=example_secret_value https://example.invalid/path' });
    await shipCommandReply('/ship', deps);
    const reply = await shipCommandReply('/ship confirm', deps);
    expect(reply).not.toContain('example_secret_value');
    expect(reply).not.toContain('https://');
  });

  it('only responds to verified owners and replies to the original message', async () => {
    const cfg = { comms: { enabled: true, channel: 'telegram', telegram: { botToken: 'fake', chatId: '123' } } } as AshlrConfig;
    const event: InboundEvent = { updateId: 1, kind: 'text', text: '/ship', fromChatId: '123', senderUserId: 123, privateChat: true, messageId: 77 };
    const ship = setup();
    const send = vi.fn<(text: string, opts?: TelegramSendOpts, cfg?: AshlrConfig) => Promise<TelegramSendResult>>(async () => ({ ok: true, messageId: 99 }));
    expect(await recordTelegramToInbox({ ...event, senderUserId: 456 }, '/ship', cfg, { ship, send })).toEqual({ ok: false, reason: 'sender-not-allowed' });
    expect(send).not.toHaveBeenCalled();
    expect(ship.probe).not.toHaveBeenCalled();
    expect(await recordTelegramToInbox(event, '/ship', cfg, { ship, send })).toEqual({ ok: false, reason: 'status-replied' });
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]?.[1]).toEqual({ replyToMessageId: 77 });
  });
});
