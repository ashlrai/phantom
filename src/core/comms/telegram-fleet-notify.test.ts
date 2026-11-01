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

  it('sends a sanitized held reason and limits each kind, including failed sends', async () => {
    let time = 0;
    const cfg = configured();
    const send = vi.fn(async () => ({ ok: true }));
    const notify = createTelegramFleetNotifier({ cfg, send, now: () => time, minGapMs: 600_000 });
    await notify('fleet-lane-held', { detail: 'codex-personal: usage_limit\n /Users/fake/private sk-fake123' });
    expect(send).toHaveBeenCalledExactlyOnceWith('Fleet: lane codex-personal held — usage_limit [REDACTED] [REDACTED]', undefined, cfg);
    await notify('fleet-lane-held', { detail: 'another: held' });
    expect(send).toHaveBeenCalledTimes(1);
    await notify('fleet-merged', { count: 3, detail: 'private title' });
    expect(send).toHaveBeenLastCalledWith('Fleet: 3 merges in the last hour', undefined, cfg);
    time = 600_000;
    await notify('fleet-lane-held', { detail: 'claude: down usage_limit' });
    expect(send).toHaveBeenLastCalledWith('Fleet: Claude lane down — run ~/.ashlr-runs/bin/fix-claude-lane.sh', undefined, cfg);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('swallows rejected sends and counts them against the gap', async () => {
    const send = vi.fn(async (): Promise<{ ok: boolean }> => { throw new Error('failed'); });
    const notify = createTelegramFleetNotifier({ cfg: configured(), send, now: () => 0 });
    await expect(notify('fleet-lane-held', { detail: 'lane: reason' })).resolves.toBeUndefined();
    await notify('fleet-lane-held', { detail: 'lane: reason' });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each(['needs-you', 'completed'] as const)('ignores %s events', async (kind) => {
    const send = vi.fn(async () => ({ ok: true }));
    await createTelegramFleetNotifier({ cfg: configured(), send })(kind, { detail: 'private session text' });
    expect(send).not.toHaveBeenCalled();
  });
});
