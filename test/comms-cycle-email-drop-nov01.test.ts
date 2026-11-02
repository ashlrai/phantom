import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mock = vi.hoisted(() => ({ fail: false, cycle: vi.fn(async () => ({ sent: 0, resolved: 0 })) }));
vi.mock('../src/core/comms/dispatch.js', () => ({ runCommsCycle: mock.cycle }));
vi.mock('../src/core/config.js', () => ({ loadConfig: vi.fn(async () => ({ comms: { enabled: false } })) }));
vi.mock('../src/core/comms/handlers.js', () => ({ registerCommsHandlers: vi.fn() }));
vi.mock('../src/cli/leader.js', () => ({ wakeLeaderIfDue: vi.fn(async () => ({ started: false })) }));
vi.mock('../src/core/comms/email-drop-bridge.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/comms/email-drop-bridge.js')>();
  return { ...actual, runEmailDropOnce: async (...args: Parameters<typeof actual.runEmailDropOnce>) => {
    if (mock.fail) throw new Error('private details\nsecret');
    return actual.runEmailDropOnce(...args);
  } };
});

import { cmdComms } from '../src/cli/comms.js';
import { writeEmailDropConfig } from '../src/core/comms/email-drop-config.js';
import { listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';

let home: string;
let oldHome: string | undefined;
let oldAshlrHome: string | undefined;
let runs: string;
let inbox: string;
let outbox: string;
let processed: string;
let logs: string[];
let errors: string[];
const sender = 'fleet-test@example.invalid';
const eml = ['From: Fleet Test <fleet-test@example.invalid>', 'To: phantom@example.invalid',
  'Subject: Fleet order', 'Message-ID: <order-1@example.invalid>', '', 'Please check the fleet.', ''].join('\r\n');

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'email-cycle-'));
  oldHome = process.env.HOME; oldAshlrHome = process.env.ASHLR_HOME;
  process.env.HOME = home; process.env.ASHLR_HOME = join(home, '.ashlr');
  runs = join(home, '.ashlr-runs'); inbox = join(home, 'mail', 'inbox');
  outbox = join(home, 'mail', 'outbox'); processed = join(home, 'mail', 'processed');
  mkdirSync(inbox, { recursive: true });
  logs = []; errors = []; mock.fail = false;
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { logs.push(args.join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.join(' ')); });
});
afterEach(() => {
  vi.restoreAllMocks();
  if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
  if (oldAshlrHome === undefined) delete process.env.ASHLR_HOME; else process.env.ASHLR_HOME = oldAshlrHome;
  rmSync(home, { recursive: true, force: true });
});

describe('email drop in comms cycle', () => {
  it('receives, mirrors, replies and moves once, then finds an empty inbox', async () => {
    await writeEmailDropConfig(runs, { v: 1, inboxDir: inbox, outboxDir: outbox, processedDir: processed, from: [sender] });
    writeFileSync(join(inbox, 'order.eml'), eml);
    expect(await cmdComms(['cycle'])).toBe(0);
    expect(logs).toContain('cycle: email-drop accepted=1 duplicate=0 refused=0 failed=0');
    expect(readFileSync(join(runs, 'leader', 'MASON-INBOX.md'), 'utf8')).toContain('Please check the fleet.');
    expect(readFileSync(join(outbox, readdirSync(outbox)[0]!), 'utf8')).toContain('In-Reply-To: <order-1@example.invalid>');
    expect(existsSync(join(processed, 'order.eml'))).toBe(true);
    expect(existsSync(join(inbox, 'order.eml'))).toBe(false);
    expect(readFileSync(join(runs, 'queue', 'email-drop-seen.jsonl'), 'utf8')).toContain('order-1@example.invalid');
    expect(listBusInboxAfter(0, 50, { root: join(home, '.ashlr', 'fleet') })).toMatchObject({ status: 'ok', messages: [expect.anything()] });
    logs.length = 0;
    expect(await cmdComms(['cycle'])).toBe(0);
    expect(logs).toContain('cycle: email-drop accepted=0 duplicate=0 refused=0 failed=0');
    writeFileSync(join(inbox, 'redelivery.eml'), eml);
    logs.length = 0;
    expect(await cmdComms(['cycle'])).toBe(0);
    expect(logs).toContain('cycle: email-drop accepted=0 duplicate=1 refused=0 failed=0');
    expect(readFileSync(join(runs, 'leader', 'MASON-INBOX.md'), 'utf8').match(/Please check the fleet\./g)).toHaveLength(1);
  });

  it('uses default sibling folders and writes a threaded fleet status reply', async () => {
    await writeEmailDropConfig(runs, { v: 1, inboxDir: inbox, from: [sender] });
    writeFileSync(join(inbox, 'status.eml'), eml.replace('Please check the fleet.', '/fleet-status'));
    expect(await cmdComms(['cycle'])).toBe(0);
    expect(logs).toContain('cycle: email-drop accepted=1 duplicate=0 refused=0 failed=0');
    expect(existsSync(join(processed, 'status.eml'))).toBe(true);
    const reply = readFileSync(join(outbox, readdirSync(outbox)[0]!), 'utf8');
    expect(reply).toContain('Phantom fleet status');
    expect(reply).toContain('In-Reply-To: <order-1@example.invalid>');
  });

  it('leaves output unchanged with no config and reports invalid config without failing', async () => {
    expect(await cmdComms(['cycle'])).toBe(0);
    expect(logs).toEqual(['cycle complete: sent=0 resolved=0']);
    expect(errors).toEqual([]);
    mkdirSync(join(runs, 'queue'), { recursive: true });
    const path = join(runs, 'queue', 'email-drop.json');
    writeFileSync(path, '{}');
    expect(await cmdComms(['cycle'])).toBe(0);
    expect(errors).toEqual([`cycle: email-drop config invalid at ${path}`]);
  });

  it('isolates unexpected email errors from the cycle and does not expose error details', async () => {
    await writeEmailDropConfig(runs, { v: 1, inboxDir: inbox, from: [sender] });
    mock.fail = true;
    expect(await cmdComms(['cycle'])).toBe(0);
    expect(errors).toEqual(['cycle: email-drop failed']);
  });

  it('saves normalized configuration, supports JSON, and requires --from before writing', async () => {
    expect(await cmdComms(['email-drop', inbox, '--save-config'])).toBe(2);
    expect(errors.join('\n')).toContain('email-drop needs at least one --from');
    expect(existsSync(join(runs, 'queue', 'email-drop.json'))).toBe(false);
    expect(await cmdComms(['email-drop', inbox, '--from', ' Fleet-Test@Example.Invalid ', '--save-config', '--json'])).toBe(0);
    const path = join(runs, 'queue', 'email-drop.json');
    expect(JSON.parse(logs[0]!)).toMatchObject({ accepted: 0, savedConfig: path });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ v: 1, inboxDir: inbox, outboxDir: outbox, processedDir: processed, from: [sender] });
  });

  it('announces saved config and runs the original one-shot pass', async () => {
    expect(await cmdComms(['email-drop', inbox, '--from', sender, '--save-config'])).toBe(0);
    expect(logs).toEqual([`saved ${join(runs, 'queue', 'email-drop.json')}; \`ashlr comms cycle\` now runs the email drop every pass`,
      'email-drop: accepted=0 duplicate=0 refused=0 failed=0']);
  });
});
