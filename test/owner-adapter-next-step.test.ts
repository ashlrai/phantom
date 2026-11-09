import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { cmdCommsOwnerStatus } from '../src/cli/comms-owner-thread.js';
import { adapterStatus, emptyOwnerSettings, OWNER_SECRET_HANDLES } from '../src/core/comms/owner-channel.js';
import type { OwnerChannel } from '../src/core/comms/leader-mailbox.js';

describe('owner adapter next steps', () => {
  it.each([
    ['desktop', 'agent-network.toml'],
    ['telegram', 'owner-adapters.toml'],
    ['email', 'owner-adapters.toml'],
    ['imessage', 'owner-adapters.toml'],
    ['slack', 'owner-adapters.toml'],
  ] as const)('names the setup file for %s', (channel, file) => {
    expect(adapterStatus(channel, emptyOwnerSettings(), false, false).nextStep).toContain(file);
  });

  it('explains the actual blocker without revealing configured identities', () => {
    const settings = emptyOwnerSettings();
    settings.owners.telegram = 'fake-owner-123';
    expect(adapterStatus('telegram', settings, false, false).nextStep).toContain('phm_TELEGRAM_BOT_TOKEN');
    settings.owners.imessage = 'fake-owner-123';
    expect(adapterStatus('imessage', settings, false, false).nextStep).toContain('bridge = "loopback"');
    for (const channel of ['desktop', 'telegram', 'email', 'imessage', 'slack'] as OwnerChannel[]) {
      settings.owners[channel] = 'fake-owner-123';
      expect(adapterStatus(channel, settings, false, false).nextStep ?? '').not.toContain('fake-owner-123');
    }
    settings.secretHandles.telegram = OWNER_SECRET_HANDLES.telegram;
    expect(adapterStatus('telegram', settings, false, false)).toMatchObject({ enabled: true, nextStep: null });
    expect(adapterStatus('telegram', settings, true, false).nextStep).toContain('~/.ashlr/KILL');
    expect(adapterStatus('telegram', settings, false, true).nextStep).toContain('resume comms');
    delete settings.owners.telegram;
    expect(adapterStatus('telegram', settings, false, false).nextStep).toContain('channel = "telegram"');
    expect(adapterStatus('desktop', emptyOwnerSettings(), false, false).nextStep).toContain('channel = "bus", id = "local-owner"');
  });

  it('prints a next line in text status', async () => {
    const runsDir = mkdtempSync(join(tmpdir(), 'owner-next-step-'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(await cmdCommsOwnerStatus(false, { runsDir, settings: emptyOwnerSettings() })).toBe(0);
      expect(log.mock.calls.some(([line]) => String(line).includes('    next: '))).toBe(true);
    } finally {
      log.mockRestore();
      rmSync(runsDir, { recursive: true, force: true });
    }
  });
});
