import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  addChannel,
  buildChannelsStatus,
  channelKindForSource,
} from '../src/core/fleet/channels.js';
import { appendInboxEntry } from '../src/core/fleet/mason-inbox.js';
import { loadConfig } from '../src/core/config.js';
import { cmdChannels } from '../src/cli/channels.js';

const roots: string[] = [];
let home: string | undefined;

function useHome(): string {
  const root = mkdtempSync(join(tmpdir(), 'channels-'));
  roots.push(root);
  process.env['HOME'] = root;
  home = root;
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['TELEGRAM_BOT_TOKEN'];
  delete process.env['PHANTOM_OPERATOR_SECRET'];
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('channels status', () => {
  it('reports all six kinds with real zeros on an empty home', async () => {
    const root = useHome();
    const status = await buildChannelsStatus({ homeDir: root, runsDir: join(root, '.ashlr-runs') });
    expect(status.v).toBe(1);
    expect(status.inbox).toBe('missing');
    expect(status.channels.map((c) => c.kind)).toEqual(['email', 'telegram', 'mobile', 'desktop', 'page', 'cli']);
    for (const row of status.channels) {
      expect(row.received).toBe(0);
      if (row.kind === 'email') expect(row.pendingOutbound).toBe('unknown'); // no outbox path to measure
      else expect(row.pendingOutbound).toBe(0);
    }
    const telegram = status.channels.find((c) => c.kind === 'telegram')!;
    expect(telegram.configured).toBe(false);
    expect(telegram.credential).toBe('missing');
    expect(telegram.paired).toBe(false);
    expect(telegram.ready).toBe(false);
    expect(telegram.next).toContain('phm channels add telegram');
    const cli = status.channels.find((c) => c.kind === 'cli')!;
    expect(cli.configured).toBe(true);
    expect(cli.credential).toBe('none-needed');
    expect(cli.ready).toBe(true);
  });

  it('attributes inbox entries to channels and never fabricates counts', async () => {
    const root = useHome();
    const runsDir = join(root, '.ashlr-runs');
    await appendInboxEntry('hold the lane', { runsDir, source: 'telegram' });
    await appendInboxEntry('status?', { runsDir, source: 'Phantom desktop' });
    await appendInboxEntry('note', { runsDir, source: 'cli' });
    const status = await buildChannelsStatus({ homeDir: root, runsDir });
    expect(status.inbox).toBe('healthy');
    const by = Object.fromEntries(status.channels.map((c) => [c.kind, c]));
    expect(by['telegram']!.received).toBe(1);
    expect(by['desktop']!.received).toBe(1);
    expect(by['cli']!.received).toBe(1);
    expect(by['email']!.received).toBe(0);
    expect(by['telegram']!.lastSeenAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it('reports unknown when the inbox is degraded', async () => {
    const root = useHome();
    const runsDir = join(root, '.ashlr-runs');
    mkdirSync(join(runsDir, 'leader'), { recursive: true });
    // A directory where the inbox file should be forces a non-ENOENT failure.
    mkdirSync(join(runsDir, 'leader', 'MASON-INBOX.md'));
    const status = await buildChannelsStatus({ homeDir: root, runsDir });
    expect(status.inbox).toBe('degraded');
    const telegram = status.channels.find((c) => c.kind === 'telegram')!;
    expect(telegram.received).toBe('unknown');
    expect(telegram.lastSeenAt).toBe('unknown');
  });

  it('reads credential custody without exposing the value', async () => {
    const root = useHome();
    process.env['TELEGRAM_BOT_TOKEN'] = 'test-token-value-not-real';
    const status = await buildChannelsStatus({ homeDir: root, runsDir: join(root, '.ashlr-runs') });
    const telegram = status.channels.find((c) => c.kind === 'telegram')!;
    expect(telegram.credential).toBe('environment');
    expect(JSON.stringify(status)).not.toContain('test-token-value-not-real');
  });
});

describe('channels add', () => {
  it('writes telegram config only — never the token', async () => {
    const root = useHome();
    const result = await addChannel('telegram', { chatId: '424242' });
    expect(result.ok).toBe(true);
    expect(result.changed).toEqual(['comms.enabled', 'comms.channel', 'comms.telegram.chatId']);
    expect(result.credential).toBe('missing');
    const cfg = loadConfig();
    expect(cfg.comms?.enabled).toBe(true);
    expect(cfg.comms?.channel).toBe('telegram');
    expect(cfg.comms?.telegram?.chatId).toBe('424242');
    expect(cfg.comms?.telegram?.botToken).toBeUndefined();
    const raw = readFileSync(join(root, '.ashlr', 'config.json'), 'utf8');
    expect(raw).not.toContain('botToken');
    expect(raw).not.toContain('TELEGRAM_BOT_TOKEN');
  });

  it('reports environment custody when the token already lives in the env', async () => {
    useHome();
    process.env['TELEGRAM_BOT_TOKEN'] = 'another-fake-token';
    const result = await addChannel('telegram', { chatId: '7' });
    expect(result.ok).toBe(true);
    expect(result.credential).toBe('environment');
    expect(result.next).not.toContain('another-fake-token');
  });

  it('refuses a bad chat id without writing', async () => {
    const root = useHome();
    for (const chatId of ['', '-3', '0', 'abc', '12.5']) {
      const result = await addChannel('telegram', { chatId });
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('chat id');
    }
    expect(existsSync(join(root, '.ashlr', 'config.json'))).toBe(false);
  });

  it('writes the email drop config and nothing else', async () => {
    const root = useHome();
    const runsDir = join(root, '.ashlr-runs');
    const inbox = join(root, 'mail-in');
    const result = await addChannel('email', {
      runsDir,
      inboxDir: inbox,
      from: ['Mason@Ashlr.AI', 'mason@ashlr.ai', 'second@example.com'],
    });
    expect(result.ok).toBe(true);
    expect(result.path).toBe(join(runsDir, 'queue', 'email-drop.json'));
    const config = JSON.parse(readFileSync(result.path!, 'utf8'));
    expect(config.v).toBe(1);
    expect(config.inboxDir).toBe(inbox);
    expect(config.from).toEqual(['mason@ashlr.ai', 'second@example.com']);
    expect(result.credential).toBe('missing');
    // The channel is now configured; pairing secret still uncustodied.
    const status = await buildChannelsStatus({ homeDir: root, runsDir });
    const email = status.channels.find((c) => c.kind === 'email')!;
    expect(email.configured).toBe(true);
    expect(email.ready).toBe(true);
    expect(email.paired).toBe(false);
  });

  it('refuses email without a verified sender or with a relative inbox dir', async () => {
    const root = useHome();
    const runsDir = join(root, '.ashlr-runs');
    expect((await addChannel('email', { runsDir, inboxDir: join(root, 'in'), from: [] })).ok).toBe(false);
    expect((await addChannel('email', { runsDir, inboxDir: 'relative/in', from: ['a@b.c'] })).ok).toBe(false);
    expect((await addChannel('email', { runsDir, inboxDir: join(root, 'in'), from: ['not-an-email'] })).ok).toBe(false);
    expect(existsSync(join(runsDir, 'queue', 'email-drop.json'))).toBe(false);
  });

  it('counts reply .eml files in the configured outbox as pending outbound', async () => {
    const root = useHome();
    const runsDir = join(root, '.ashlr-runs');
    const inbox = join(root, 'mail-in');
    const outbox = join(root, 'mail-out');
    await addChannel('email', { runsDir, inboxDir: inbox, outboxDir: outbox, from: ['a@b.c'] });
    mkdirSync(outbox, { recursive: true });
    writeFileSync(join(outbox, 'one.reply.eml'), 'x');
    writeFileSync(join(outbox, 'two.eml'), 'x');
    writeFileSync(join(outbox, 'note.txt'), 'x');
    const status = await buildChannelsStatus({ homeDir: root, runsDir });
    expect(status.channels.find((c) => c.kind === 'email')!.pendingOutbound).toBe(2);
  });

  it('leaves built-in channels as a no-op with guidance', async () => {
    const root = useHome();
    const cli = await addChannel('cli');
    expect(cli.ok).toBe(true);
    expect(cli.changed).toEqual([]);
    expect(cli.next).toContain('phm comms inbox post');
    const mobile = await addChannel('mobile', { homeDir: root });
    expect(mobile.ok).toBe(true);
    expect(mobile.next).toContain('verse-remote.json');
  });
});

describe('channelKindForSource', () => {
  it('maps inbox source labels to kinds', () => {
    expect(channelKindForSource('telegram')).toBe('telegram');
    expect(channelKindForSource('Phantom desktop')).toBe('desktop');
    expect(channelKindForSource('Phantom mobile')).toBe('mobile');
    expect(channelKindForSource('mail')).toBe('email');
    expect(channelKindForSource('cli')).toBe('cli');
    expect(channelKindForSource('page')).toBe('page');
    expect(channelKindForSource('fleet-say')).toBe('other');
  });
});

describe('phm channels CLI', () => {
  it('status --json prints parseable rows; add writes and status reflects it', async () => {
    const root = useHome();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await cmdChannels(['status', '--json'])).toBe(0);
    const status = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
    expect(status.channels).toHaveLength(6);

    expect(await cmdChannels(['add', 'telegram', '555777'])).toBe(0);
    const cfg = loadConfig();
    expect(cfg.comms?.telegram?.chatId).toBe('555777');

    expect(await cmdChannels(['status', '--json'])).toBe(0);
    const after = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
    const telegram = after.channels.find((c: { kind: string }) => c.kind === 'telegram');
    expect(telegram.configured).toBe(true);
    expect(telegram.credential).toBe('missing');
    expect(telegram.ready).toBe(false);

    expect(await cmdChannels(['add', 'email', join(root, 'mail-in'), '--from', 'a@b.c'])).toBe(0);
    expect(await cmdChannels(['status'])).toBe(0);
    const table = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(table).toContain('email');
    expect(table).not.toContain('another-fake-token');
    expect(err).not.toHaveBeenCalled();
  });

  it('rejects bad usage with exit 2 and keeps secrets out of every output path', async () => {
    useHome();
    process.env['TELEGRAM_BOT_TOKEN'] = 'sensitive-token-xyz';
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const argv of [
      ['add'],
      ['add', 'carrier-pigeon'],
      ['add', 'telegram'],
      ['add', 'telegram', '0'],
      ['status', '--bogus'],
      ['nope'],
    ]) {
      expect(await cmdChannels(argv)).toBe(2);
    }
    const out = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).not.toContain('sensitive-token-xyz');
  });
});
