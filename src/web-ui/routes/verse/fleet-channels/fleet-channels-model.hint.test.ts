import { describe, expect, it } from 'vitest';
import { channelSetupHint, EMAIL_DROP_USAGE, rollupChannels, SETUP_TELEGRAM_USAGE } from './fleet-channels-model.js';
import type { ChannelKey, ChannelRow } from './fleet-channels-model.js';

const now = Date.parse('2026-10-31T05:00:00Z');
const row = (key: ChannelKey, total = 0): ChannelRow => ({ key, label: key, lastAt: null, preview: null, lastHour: 0, last24h: 0, total, rawSources: [] });

describe('channelSetupHint', () => {
  it('returns the email drop usage line verbatim from src/cli/comms.ts, plus the folder defaults', () => {
    const hint = channelSetupHint('email', row('email'))!;
    // Byte-identical to EMAIL_DROP_USAGE in src/cli/comms.ts (mirrored constant).
    expect(hint.command).toBe('usage: phm comms email-drop <inboxDir> --from <address> [--from <address> ...] [--outbox <dir>] [--processed <dir>] [--once | --watch <seconds>] [--json]');
    expect(hint.command).toBe(EMAIL_DROP_USAGE);
    expect(hint.runCommand).toBe('phm comms email-drop <inboxDir> --from <address> [--from <address> ...] [--outbox <dir>] [--processed <dir>] [--once | --watch <seconds>] [--json]');
    expect(hint.detail).toContain('<inboxDir>');
    expect(hint.detail).toContain('<inboxDir>/../processed');
    expect(hint.detail).toContain('<inboxDir>/../outbox');
    expect(hint.detail).toContain('reply .eml');
  });
  it('fires on a real silent rollup row, not just a synthetic one', () => {
    const silent = rollupChannels({ inbox: [], sources: {}, generatedAt: null }, now)!.rows.find(r => r.key === 'email')!;
    expect(channelSetupHint('email', silent)?.command).toBe(EMAIL_DROP_USAGE);
  });
  it('points telegram at setup-telegram while the channel is silent', () => {
    const hint = channelSetupHint('telegram', row('telegram'))!;
    // Verbatim 'setup-telegram' spec usage from src/cli/comms.ts.
    expect(hint.command).toBe('usage: phm comms setup-telegram');
    expect(hint.command).toBe(SETUP_TELEGRAM_USAGE);
    expect(hint.runCommand).toBe('phm comms setup-telegram');
  });
  it('returns null once a message has landed, however old', () => {
    expect(channelSetupHint('email', row('email', 1))).toBeNull();
    expect(channelSetupHint('telegram', row('telegram', 3))).toBeNull();
  });
  it('returns null for channels with nothing to enable, even when silent', () => {
    for (const key of ['desktop', 'page', 'terminal', 'fleet-say', 'mobile', 'other'] as const) {
      expect(channelSetupHint(key, row(key))).toBeNull();
    }
  });
});
