import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const effects = vi.hoisted(() => ({
  notify: vi.fn(async () => true),
  desktopNotify: vi.fn(async () => true),
  loadConfig: vi.fn(() => ({
    notify: { slackWebhook: 'https://hooks.slack.invalid/services/test' },
    desktopNotify: true,
  })),
}));

vi.mock('../src/core/config.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/core/config.js')>(),
  loadConfig: effects.loadConfig,
}));

vi.mock('../src/core/integrations/notify.js', () => ({
  notify: effects.notify,
}));

vi.mock('../src/core/integrations/desktop-notify.js', () => ({
  desktopNotify: effects.desktopNotify,
  desktopNotifyEnabled: () => true,
}));

import { cmdNotify } from '../src/cli/notify.js';
import { emptyOwnerSettings, NOTIFY_ROUTES, ownerAllowed, planNotifyRoute } from '../src/core/comms/owner-channel.js';

let stdout = '';
let stderr = '';

beforeEach(() => {
  effects.notify.mockClear();
  effects.desktopNotify.mockClear();
  effects.loadConfig.mockClear();
  stdout = '';
  stderr = '';
  vi.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => { stdout += parts.join(' ') + '\n'; });
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => { stdout += String(chunk); return true; });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => { stderr += String(chunk); return true; });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('notify <verb> --help never sends anything', () => {
  it.each([
    [['test', '--help']],
    [['test', '--json', '-h']],
    [['session', '--help']],
    [['session', '--event', 'stop', '-h']],
    [['route', 'approval', '--help']],
  ])('%j prints usage without posting a webhook or desktop notification', async (args) => {
    await expect(cmdNotify(args)).resolves.toBe(0);
    expect(effects.notify).not.toHaveBeenCalled();
    expect(effects.desktopNotify).not.toHaveBeenCalled();
    expect(stdout).toContain('Subcommands:');
  });
});

describe('notify route is a dry-run owner-thread plan', () => {
  afterEach(() => {
    expect(effects.loadConfig).not.toHaveBeenCalled();
    expect(effects.notify).not.toHaveBeenCalled();
    expect(effects.desktopNotify).not.toHaveBeenCalled();
  });

  const fixtures = [
    ['decision', 'imessage', 'desktop', 'now', 'YES or NO'],
    ['approval', 'imessage', 'desktop', 'now', 'YES or NO'],
    ['digest', 'email', 'desktop', 'now', null],
    ['incident', 'imessage', 'desktop', 'now', null],
    ['merged', 'email', 'desktop', 'next-digest', null],
    ['status', 'desktop', 'email', 'now', null],
  ] as const;

  it.each(fixtures)('%s chooses %s with fallback %s', async (type, channel, fallback, delivery, replyFormat) => {
    expect(await cmdNotify(['route', type, '--available', channel])).toBe(0);
    const result = JSON.parse(stdout);
    expect(result).toMatchObject({ schemaVersion: 'notify.route.v1', dryRun: true, sent: false,
      threadId: 'owner', updateType: type, preferredChannel: channel, channel, fallbackChannel: fallback,
      availability: 'available', delivery, wouldSendNow: delivery === 'now', replyFormat,
      verifiedSenderCheck: 'src/core/comms/owner-channel.ts#ownerAllowed' });
    expect(result.reason).toEqual(expect.any(String));
    expect(result.reason.length).toBeGreaterThan(0);
  });

  it('keeps unknown readiness explicit and produces stable JSON keys and bytes', async () => {
    expect(Object.keys(NOTIFY_ROUTES)).toEqual(fixtures.map(row => row[0]));
    expect(await cmdNotify(['route', 'approval'])).toBe(0);
    const first = stdout;
    const result = JSON.parse(first);
    expect(result).toMatchObject({ channel: 'imessage', availability: 'unknown', wouldSendNow: 'unknown' });
    expect(Object.keys(result)).toEqual(['schemaVersion', 'dryRun', 'sent', 'threadId', 'updateType',
      'preferredChannel', 'channel', 'fallbackChannel', 'availability', 'delivery', 'wouldSendNow',
      'reason', 'replyFormat', 'verifiedSenderCheck']);
    stdout = '';
    expect(await cmdNotify(['route', 'approval', '--dry-run', '--json'])).toBe(0);
    expect(stdout).toBe(first);
  });

  it('falls back to desktop when iMessage is unavailable', async () => {
    expect(await cmdNotify(['route', 'approval', '--unavailable', 'imessage', '--available', 'desktop'])).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ preferredChannel: 'imessage', channel: 'desktop',
      fallbackChannel: 'desktop', delivery: 'now', wouldSendNow: true, replyFormat: 'YES or NO' });
    expect(JSON.parse(stdout).reason).toContain('unavailable');
  });

  it('batches merged updates and email fallbacks for live status', () => {
    expect(planNotifyRoute('merged', { email: 'available' })).toMatchObject({ delivery: 'next-digest', wouldSendNow: false });
    expect(planNotifyRoute('status', { desktop: 'unavailable', email: 'available' }))
      .toMatchObject({ channel: 'email', delivery: 'next-digest', wouldSendNow: false });
    expect(planNotifyRoute('approval', { imessage: 'unavailable' }))
      .toMatchObject({ channel: 'desktop', availability: 'unknown', wouldSendNow: 'unknown' });
  });

  it('blocks when both destinations are unavailable', () => {
    expect(planNotifyRoute('approval', { imessage: 'unavailable', desktop: 'unavailable' }))
      .toMatchObject({ channel: null, availability: 'unavailable', delivery: 'blocked', wouldSendNow: false });
  });

  it('renders a human-readable plan without sending', async () => {
    expect(await cmdNotify(['route', 'approval', '--text'])).toBe(0);
    expect(stdout).toContain('imessage');
    expect(stdout).toContain('YES or NO');
    expect(stdout).toContain('unknown');
  });

  it.each([
    [], ['bogus'], ['approval', 'extra'], ['approval', '--send'], ['approval', '--apply'],
    ['approval', '--text', '--json'], ['approval', '--available'], ['approval', '--unavailable'],
    ['approval', '--available', 'slack'], ['approval', '--available', '--text'],
    ['approval', '--available', 'email', '--available', 'email'],
    ['approval', '--available', 'email', '--unavailable', 'email'],
    ['approval', '--unavailable', 'email', '--unavailable', 'email'],
  ])('rejects invalid route arguments %j without effects', async (...args: string[]) => {
    expect(await cmdNotify(['route', ...args])).toBe(2);
    expect(stderr).not.toBe('');
  });

  it('references the existing exact owner check for fake phone and email identities', () => {
    const settings = emptyOwnerSettings();
    settings.owners = { imessage: '+12025550123', email: 'owner@example.test' };
    expect(ownerAllowed('imessage', '+12025550123', settings)).toBe(true);
    expect(ownerAllowed('email', 'owner@example.test', settings)).toBe(true);
    expect(ownerAllowed('imessage', '+12025550124', settings)).toBe(false);
    expect(ownerAllowed('email', 'outsider@example.test', settings)).toBe(false);
    expect(ownerAllowed('desktop', '', settings)).toBe(false);
  });
});

describe('notify test refuses unknown flags', () => {
  it('a mistyped flag is refused before any ping is sent', async () => {
    await expect(cmdNotify(['test', '--jsno'])).resolves.toBe(2);
    expect(effects.notify).not.toHaveBeenCalled();
    expect(effects.desktopNotify).not.toHaveBeenCalled();
    expect(stderr).toContain('unknown notify test option');
  });

  it('a plain notify test still sends the ping', async () => {
    await expect(cmdNotify(['test', '--json'])).resolves.toBe(0);
    expect(effects.notify).toHaveBeenCalledTimes(1);
  });
});
