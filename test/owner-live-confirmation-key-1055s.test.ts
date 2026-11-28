import { describe, expect, it } from 'vitest';
import { parseCommsConfirmation } from '../src/core/agents/channel-policy.js';
import { emptyOwnerSettings, OWNER_SECRET_HANDLES, type OwnerThreadSettings } from '../src/core/comms/owner-channel.js';
import { readOwnerLiveStatus } from '../src/core/comms/owner-live-status.js';

const settings: OwnerThreadSettings = {
  ...emptyOwnerSettings(),
  owners: { telegram: 'fake-telegram', email: 'fake-email', imessage: 'fake-phone', slack: 'fake-slack' },
  secretHandles: { ...OWNER_SECRET_HANDLES },
  imessageBridge: 'loopback',
  team: [
    { channel: 'telegram', id: 'fake-telegram' },
    { channel: 'email', id: 'fake-email' },
    { channel: 'imessage', id: 'fake-phone' },
    { channel: 'slack', id: 'fake-slack' },
  ],
};
const noHold = { halted: false, paused: false };

describe('owner live confirmation guidance', () => {
  it('matches the confirmation parser for every configured channel', () => {
    expect(parseCommsConfirmation('confirmed = true')).toBe(false);
    expect(parseCommsConfirmation('confirmedByMason = true')).toBe(true);
    const status = readOwnerLiveStatus(settings, noHold);
    expect(status.channels).toHaveLength(4);
    for (const channel of status.channels) {
      expect(channel.state).toBe('off');
      expect(channel.decidedBy).toContainEqual({
        file: '~/.ashlr/comms.toml', key: 'confirmedByMason = true (Mason confirms the owner)', value: 'not set',
      });
      expect(channel.nextStep).toContain('desktop Comms panel');
      expect(channel.nextStep).toContain('confirmedByMason = true');
      expect(channel.nextStep).not.toMatch(/\bconfirmed\s*=\s*true/);
    }
  });

  it('keeps confirmed channels on and held channels off', () => {
    const confirmed = { ...settings, confirmed: true };
    expect(readOwnerLiveStatus(confirmed, noHold).channels.map(c => c.state)).toEqual(['on', 'on', 'on', 'on']);
    expect(readOwnerLiveStatus(confirmed, { halted: true, paused: false }).channels.map(c => c.state)).toEqual(['off', 'off', 'off', 'off']);
  });
});
