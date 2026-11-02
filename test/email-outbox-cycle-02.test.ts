import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EmailOutboxMessage } from '../src/core/comms/email-outbox.js';

// The cycle seam: comms.ts builds its transport through macMailTransport(), so
// the mock swaps in a recording fake while sendEmailOutbox stays real.
const mock = vi.hoisted(() => ({
  fail: false,
  built: 0,
  sent: [] as EmailOutboxMessage[],
}));
vi.mock('../src/core/comms/dispatch.js', () => ({ runCommsCycle: vi.fn(async () => ({ sent: 0, resolved: 0 })) }));
vi.mock('../src/core/config.js', () => ({ loadConfig: vi.fn(async () => ({ comms: { enabled: false } })) }));
vi.mock('../src/core/comms/handlers.js', () => ({ registerCommsHandlers: vi.fn() }));
vi.mock('../src/cli/leader.js', () => ({ wakeLeaderIfDue: vi.fn(async () => ({ started: false })) }));
vi.mock('../src/core/comms/email-outbox.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/comms/email-outbox.js')>();
  return {
    ...actual,
    macMailTransport: () => {
      mock.built += 1;
      return async (message: EmailOutboxMessage) => {
        mock.sent.push(message);
        return mock.fail ? { ok: false, error: 'mail unavailable' } : { ok: true };
      };
    },
  };
});

import { cmdComms } from '../src/cli/comms.js';
import { writeEmailDropConfig } from '../src/core/comms/email-drop-config.js';

let home: string;
let oldHome: string | undefined;
let oldAshlrHome: string | undefined;
let runs: string;
let inbox: string;
let outbox: string;
let logs: string[];
let errors: string[];
const sender = 'operator@example.test';
const eml = ['From: Operator <operator@example.test>', 'To: phantom@example.test',
  'Subject: Fleet order', 'Message-ID: <order-1@example.test>', '', 'Please check the fleet.', ''].join('\r\n');

const sentFiles = () => existsSync(join(outbox, 'sent')) ? readdirSync(join(outbox, 'sent')) : [];
const queuedFiles = () => existsSync(outbox) ? readdirSync(outbox).filter((n) => n.endsWith('.reply.eml')) : [];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'email-cycle-send-'));
  oldHome = process.env.HOME; oldAshlrHome = process.env.ASHLR_HOME;
  process.env.HOME = home; process.env.ASHLR_HOME = join(home, '.ashlr');
  runs = join(home, '.ashlr-runs'); inbox = join(home, 'mail', 'inbox'); outbox = join(home, 'mail', 'outbox');
  mkdirSync(inbox, { recursive: true });
  logs = []; errors = [];
  mock.fail = false; mock.built = 0; mock.sent.length = 0;
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { logs.push(args.join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.join(' ')); });
});
afterEach(() => {
  vi.restoreAllMocks();
  if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
  if (oldAshlrHome === undefined) delete process.env.ASHLR_HOME; else process.env.ASHLR_HOME = oldAshlrHome;
  rmSync(home, { recursive: true, force: true });
});

describe('email outbox send in comms cycle', () => {
  it('never builds a transport when sendReplies is absent from the config', async () => {
    await writeEmailDropConfig(runs, { v: 1, inboxDir: inbox, outboxDir: outbox, from: [sender] });
    writeFileSync(join(inbox, 'order.eml'), eml);
    expect(await cmdComms(['cycle'])).toBe(0);
    expect(logs).toContain('cycle: email-drop accepted=1 duplicate=0 refused=0 failed=0');
    expect(logs.some((line) => line.includes('email-outbox'))).toBe(false);
    expect(mock.built).toBe(0);
    expect(mock.sent).toHaveLength(0);
    expect(queuedFiles()).toHaveLength(1); // reply stays queued for a later opt-in
  });

  it('sends the queued reply through Mail.app when sendReplies is true', async () => {
    await writeEmailDropConfig(runs, { v: 1, inboxDir: inbox, outboxDir: outbox, from: [sender], sendReplies: true });
    writeFileSync(join(inbox, 'order.eml'), eml);
    expect(await cmdComms(['cycle'])).toBe(0);
    expect(logs).toContain('cycle: email-outbox queued=0 sent=1 refused=0 failed=0 stuck=0');
    expect(mock.built).toBe(1);
    expect(mock.sent).toHaveLength(1);
    expect(mock.sent[0]!.to).toBe(sender);
    expect(mock.sent[0]!.subject).toBe('Re: Fleet order');
    expect(sentFiles()).toHaveLength(1);
    expect(queuedFiles()).toHaveLength(0);
    // A second cycle finds an empty outbox and sends nothing more.
    logs.length = 0;
    expect(await cmdComms(['cycle'])).toBe(0);
    expect(logs).toContain('cycle: email-outbox queued=0 sent=0 refused=0 failed=0 stuck=0');
    expect(mock.sent).toHaveLength(1);
  });

  it('reports a transport failure without failing the cycle and retries next pass', async () => {
    await writeEmailDropConfig(runs, { v: 1, inboxDir: inbox, outboxDir: outbox, from: [sender], sendReplies: true });
    writeFileSync(join(inbox, 'order.eml'), eml);
    mock.fail = true;
    expect(await cmdComms(['cycle'])).toBe(0);
    expect(logs).toContain('cycle: email-outbox queued=0 sent=0 refused=0 failed=1 stuck=0');
    expect(errors).toEqual([]);
    expect(queuedFiles()).toHaveLength(1);
    mock.fail = false;
    logs.length = 0;
    expect(await cmdComms(['cycle'])).toBe(0);
    expect(logs).toContain('cycle: email-outbox queued=0 sent=1 refused=0 failed=0 stuck=0');
    expect(sentFiles()).toHaveLength(1);
    expect(mock.sent).toHaveLength(2);
  });

  it('writes sendReplies only when --send-replies accompanies --save-config', async () => {
    const configPath = join(runs, 'queue', 'email-drop.json');
    expect(await cmdComms(['email-drop', inbox, '--from', sender, '--save-config'])).toBe(0);
    expect(JSON.parse(readFileSync(configPath, 'utf8'))).not.toHaveProperty('sendReplies');
    expect(await cmdComms(['email-drop', inbox, '--from', sender, '--save-config', '--send-replies'])).toBe(0);
    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toMatchObject({ sendReplies: true });
    expect(logs.some((line) => line.includes('sends queued replies via Mail.app'))).toBe(true);
  });
});
