import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordTelegramToInbox } from '../src/core/comms/telegram-inbox-bridge.js';
import { readFleetRunsDirState } from '../src/core/fleet/runs-dir-state.js';
import { listLiveWorkers } from '../src/core/fleet/runs-live-workers.js';
import type { InboundEvent, TelegramSendOpts, TelegramSendResult } from '../src/core/integrations/telegram.js';
import type { AshlrConfig } from '../src/core/types.js';

const at = new Date('2026-11-01T04:08:00.000Z');
const cfg = { comms: { enabled: true, channel: 'telegram', telegram: { botToken: 'fake-token', chatId: '12345' } } } as AshlrConfig;
const event: InboundEvent = { updateId: 1, kind: 'text', text: '/fleet-status', fromChatId: '12345', senderUserId: 12345, privateChat: true, messageId: 77 };
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function setup() {
  const runsDir = mkdtempSync(join(tmpdir(), 'tg-status-')); dirs.push(runsDir);
  mkdirSync(join(runsDir, 'queue'));
  writeFileSync(join(runsDir, 'queue', 'status.json'), JSON.stringify({
    last_tick: '2026-11-01T04:07:00Z', paused: false, mem_free_pct: 50,
    lanes: { 'codex-personal': { running: 4, target: 3, queued: 2, held: true, held_reason: '/private/prompt secret' } },
  }));
  const readRuns = vi.fn(() => readFleetRunsDirState({ runsDir, now: () => at.getTime() }));
  const readWorkers = vi.fn(() => listLiveWorkers({ now: () => at.getTime(), runPs: async () => [
    '1 00:01 /private/bin/launch.sh FAKE phantom codex-personal work prompt=private',
    '2 00:01 /private/bin/launch.sh FAKE2 phantom mystery work',
  ].join('\n') }));
  const send = vi.fn<(text: string, opts?: TelegramSendOpts, cfg?: AshlrConfig) => Promise<TelegramSendResult>>(async () => ({ ok: true, messageId: 99 }));
  return { runsDir, readRuns, readWorkers, send, now: () => at };
}

describe('Telegram fleet status bridge', () => {
  it.each([
    { privateChat: false }, { privateChat: undefined }, { senderUserId: undefined }, { senderUserId: 98765 },
  ])('does no reads or sends for unverified or foreign sender: %j', async over => {
    const deps = setup();
    expect(await recordTelegramToInbox({ ...event, ...over }, '/fleet-status', cfg, deps)).toEqual({ ok: false, reason: 'sender-not-allowed' });
    expect(deps.readRuns).not.toHaveBeenCalled();
    expect(deps.readWorkers).not.toHaveBeenCalled();
    expect(deps.send).not.toHaveBeenCalled();
    expect(existsSync(join(deps.runsDir, 'leader'))).toBe(false);
  });

  it.each(['/fleet-status', '/fleet-status@ExampleBot'])('replies once with a bounded projection and no inbox write for %s', async command => {
    const deps = setup();
    const result = await recordTelegramToInbox(event, command, cfg, deps);
    expect(result).toEqual({ ok: false, reason: 'status-replied' });
    expect(deps.readRuns).toHaveBeenCalledOnce();
    expect(deps.readWorkers).toHaveBeenCalledOnce();
    expect(deps.send).toHaveBeenCalledOnce();
    const [body, options] = deps.send.mock.calls[0]!;
    expect(options).toEqual({ replyToMessageId: 77 });
    expect(body).toContain('Fleet status at 2026-11-01T04:08:00.000Z');
    expect(body).toContain('codex-personal: observed 1; reported 4; queue 2; target 3; held yes; tokens/1h unavailable');
    expect(body).toContain('Other lanes: observed 1');
    expect(body).toContain('Last tick: 2026-11-01T04:07:00.000Z');
    expect(body).toContain('runs=degraded, workers=healthy');
    expect(body).toContain('metrics=missing');
    expect(body.length).toBeLessThan(4096);
    expect(body).not.toMatch(/\/private|prompt|fake-token|launch\.sh|FAKE/);
    expect(existsSync(join(deps.runsDir, 'leader'))).toBe(false);
  });

  it('reports known completed-job usage from local metrics', async () => {
    const deps = setup();
    mkdirSync(join(deps.runsDir, 'metrics'));
    writeFileSync(join(deps.runsDir, 'metrics', 'jobs.jsonl'), JSON.stringify({
      event: 'finish', job: 'FAKE', lane: 'codex-personal', tokens_total: 123,
      ts: '2026-11-01T04:00:00Z',
    }) + '\n');
    await recordTelegramToInbox(event, '/fleet-status', cfg, deps);
    expect(deps.send.mock.calls[0]![0]).toContain('held yes; tokens/1h 123');
  });

  it('keeps available data when a reader fails and never sends its error', async () => {
    const deps = setup();
    deps.readWorkers.mockRejectedValue(new Error('/private/prompt credential metadata'));
    const result = await recordTelegramToInbox(event, '/fleet-status', cfg, deps);
    expect(result).toEqual({ ok: false, reason: 'status-replied' });
    const body = deps.send.mock.calls[0]![0];
    expect(body).toContain('codex-personal: observed unavailable; reported 4; queue 2; target 3; held yes');
    expect(body).toContain('workers=unavailable');
    expect(body).not.toMatch(/\/private|prompt|credential/);
  });

  it('retains observed workers if the runs reader fails', async () => {
    const deps = setup();
    deps.readRuns.mockRejectedValue(new Error('/private/failure'));
    await recordTelegramToInbox(event, '/fleet-status', cfg, deps);
    const body = deps.send.mock.calls[0]![0];
    expect(body).toContain('codex-personal: observed 1; reported unavailable; queue unavailable');
    expect(body).toContain('runs=unavailable, workers=healthy');
    expect(body).toContain('Last tick: unavailable');
  });

  it('reports transport failure without claiming an inbox write', async () => {
    const deps = setup();
    deps.send.mockResolvedValue({ ok: false });
    expect(await recordTelegramToInbox(event, '/fleet-status', cfg, deps)).toEqual({ ok: false, reason: 'status-send-failed' });
    expect(deps.send).toHaveBeenCalledOnce();
  });

  it('keeps non-exact text on the ordinary inbox path', async () => {
    const deps = setup();
    const result = await recordTelegramToInbox(event, '/fleet-status please', cfg, deps);
    expect(result).toMatchObject({ ok: true, ack: { status: 'accepted' } });
    expect(deps.readRuns).not.toHaveBeenCalled();
    expect(deps.readWorkers).not.toHaveBeenCalled();
    expect(existsSync(join(deps.runsDir, 'leader', 'MASON-INBOX.md'))).toBe(true);
  });
});
