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

let stdout = '';
let stderr = '';

beforeEach(() => {
  effects.notify.mockClear();
  effects.desktopNotify.mockClear();
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
  ])('%j prints usage without posting a webhook or desktop notification', async (args) => {
    await expect(cmdNotify(args)).resolves.toBe(0);
    expect(effects.notify).not.toHaveBeenCalled();
    expect(effects.desktopNotify).not.toHaveBeenCalled();
    expect(stdout).toContain('Subcommands:');
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
