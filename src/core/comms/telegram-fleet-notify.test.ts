import { describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../config.js';
import { createTelegramFleetNotifier } from './telegram-fleet-notify.js';

const configured = () => ({ ...defaultConfig(), comms: {
  enabled: true, channel: 'telegram' as const, telegram: { chatId: '12345', botToken: 'fake-token-123' },
} });

describe('Telegram fleet notifier', () => {
  it('does nothing without a configured chat id', async () => {
    const send = vi.fn(async () => ({ ok: true }));
    const cfg = configured();
    cfg.comms.telegram.chatId = '';
    await createTelegramFleetNotifier({ cfg, send })('fleet-lane-held', { detail: 'codex-personal: usage_limit' });
    expect(send).not.toHaveBeenCalled();
  });

  it('sends a release or a human-only incident and stays quiet otherwise', async () => {
    let time = 0;
    const cfg = configured();
    const send = vi.fn(async () => ({ ok: true }));
    const notify = createTelegramFleetNotifier({ cfg, send, now: () => time, minGapMs: 600_000 });
    await notify('fleet-lane-held', { detail: 'codex-personal: usage_limit\n /Users/fake/private sk-fake123' });
    await notify('fleet-merged', { count: 3, detail: 'private title' });
    await notify('completed', { detail: 'done' });
    expect(send).not.toHaveBeenCalled();
    await notify('needs-you', { detail: 'approve the release' });
    expect(send).toHaveBeenCalledExactlyOnceWith('Needs you.', undefined, cfg);
    await notify('fleet-merged', { detail: 'weekly release' });
    expect(send).toHaveBeenLastCalledWith('Release shipped.', undefined, cfg);
    time = 600_000;
    await notify('fleet-lane-held', { detail: 'claude: down' });
    expect(send).toHaveBeenLastCalledWith('Claude lane is down. It needs you.', undefined, cfg);
    expect(send).toHaveBeenCalledTimes(3);
    await notify('fleet-lane-held', { detail: 'claude: down again' });
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('swallows rejected sends and counts them against the gap', async () => {
    const send = vi.fn(async (): Promise<{ ok: boolean }> => { throw new Error('failed'); });
    const notify = createTelegramFleetNotifier({ cfg: configured(), send, now: () => 0 });
    await expect(notify('needs-you', { detail: 'lane: reason' })).resolves.toBeUndefined();
    await notify('needs-you', { detail: 'lane: reason' });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each(['needs-you', 'completed'] as const)('ignores %s events', async (kind) => {
    const send = vi.fn(async () => ({ ok: true }));
    await createTelegramFleetNotifier({ cfg: configured(), send })(kind, { detail: 'private session text' });
    expect(send).not.toHaveBeenCalled();
  });
});
