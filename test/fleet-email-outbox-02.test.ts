import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EMAIL_OUTBOX_MAX_BYTES, macMailTransport, readEmailOutbox, sendEmailOutbox, type EmailOutboxMessage, type EmailTransport, type OsaScriptRunner } from '../src/core/comms/email-outbox.js';
import { recordEmailToInbox } from '../src/core/comms/email-drop-bridge.js';
import { writeEmailDropConfig } from '../src/core/comms/email-drop-config.js';
import { cmdFleetEmailOutbox } from '../src/cli/fleet-email-outbox.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';

let root: string;
let oldHome: string | undefined;
let oldAshlrHome: string | undefined;
let runsDir: string;
let outboxDir: string;
let logs: string[];
let errors: string[];
const sender = 'operator@example.test';
const allowedSenders = new Set([sender]);
const eml = (id: string) =>
  ['From: Operator <operator@example.test>', 'To: phantom@example.test',
    'Subject: Fleet order', `Message-ID: <${id}@example.test>`, '', 'Please check the fleet.', ''].join('\r\n');

const queuedFiles = () => readdirSync(outboxDir).filter((name) => name.endsWith('.reply.eml'));
const sentFiles = () => existsSync(join(outboxDir, 'sent')) ? readdirSync(join(outboxDir, 'sent')) : [];
const okTransport = (calls: EmailOutboxMessage[]): EmailTransport =>
  async (message) => { calls.push(message); return { ok: true }; };
const dropReply = async (id: string): Promise<void> => {
  const result = await recordEmailToInbox(eml(id), { allowedSenders, runsDir, outboxDir });
  expect(result.ok).toBe(true);
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'email-outbox-'));
  oldHome = process.env.HOME; oldAshlrHome = process.env.ASHLR_HOME;
  process.env.HOME = join(root, 'home'); process.env.ASHLR_HOME = join(root, 'home', '.ashlr');
  runsDir = join(root, 'runs'); outboxDir = join(root, 'outbox');
  mkdirSync(runsDir, { recursive: true });
  logs = []; errors = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { logs.push(args.join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.join(' ')); });
});
afterEach(() => {
  vi.restoreAllMocks();
  if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
  if (oldAshlrHome === undefined) delete process.env.ASHLR_HOME; else process.env.ASHLR_HOME = oldAshlrHome;
  rmSync(root, { recursive: true, force: true });
});

describe('email outbox sender', () => {
  it('sends a real bridge reply once into sent/; a second pass sends nothing', async () => {
    await dropReply('order-1');
    const name = queuedFiles()[0]!;
    expect(name).toMatch(/\.reply\.eml$/);
    const calls: EmailOutboxMessage[] = [];
    const first = await sendEmailOutbox({ dir: outboxDir, allowedRecipients: allowedSenders, transport: okTransport(calls) });
    expect(first).toMatchObject({ queued: 0, sent: 1, refused: 0, failed: 0, stuck: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.to).toBe(sender);
    expect(calls[0]!.subject).toBe('Re: Fleet order');
    expect(calls[0]!.body).toContain('Inbox:');
    expect(sentFiles()).toEqual([name]);
    expect(queuedFiles()).toEqual([]);
    const second = await sendEmailOutbox({ dir: outboxDir, allowedRecipients: allowedSenders, transport: okTransport(calls) });
    expect(second).toMatchObject({ queued: 0, sent: 0, refused: 0, failed: 0, stuck: 0 });
    expect(calls).toHaveLength(1);
    expect(readEmailOutbox(outboxDir).counts).toEqual({ queued: 0, sent: 1, stuck: 0 });
  });

  it('sends each file once under two concurrent passes', async () => {
    await dropReply('order-a');
    await dropReply('order-b');
    expect(queuedFiles()).toHaveLength(2);
    const calls: EmailOutboxMessage[] = [];
    const opts = { dir: outboxDir, allowedRecipients: allowedSenders, transport: okTransport(calls) };
    const [a, b] = await Promise.all([sendEmailOutbox(opts), sendEmailOutbox(opts)]);
    expect(a.sent + b.sent).toBe(2);
    expect(calls).toHaveLength(2);
    expect(sentFiles()).toHaveLength(2);
  });

  it('never sends an unlisted To, a two-recipient To, a symlink or an oversized file', async () => {
    mkdirSync(outboxDir, { recursive: true });
    const write = (name: string, to: string) =>
      writeFileSync(join(outboxDir, name), `To: ${to}\r\nSubject: Re: x\r\n\r\nbody\r\n`);
    write('outside.reply.eml', 'stranger@example.test');
    write('two.reply.eml', 'operator@example.test, other@example.test');
    symlinkSync(join(root, 'missing-target'), join(outboxDir, 'link.reply.eml'));
    writeFileSync(join(outboxDir, 'big.reply.eml'), `To: ${sender}\r\nSubject: Re: x\r\n\r\n${'x'.repeat(EMAIL_OUTBOX_MAX_BYTES)}`);
    const calls: EmailOutboxMessage[] = [];
    const result = await sendEmailOutbox({ dir: outboxDir, allowedRecipients: allowedSenders, transport: okTransport(calls) });
    expect(calls).toHaveLength(0);
    expect(result).toMatchObject({ sent: 0, refused: 2, stuck: 2 });
    const reasons = Object.fromEntries(result.details.map((detail) => [detail.name, detail.reason]));
    expect(reasons['outside.reply.eml']).toBe('recipient-not-allowed');
    expect(reasons['two.reply.eml']).toBe('multiple-recipients');
    expect(reasons['link.reply.eml']).toBe('symlink');
    expect(reasons['big.reply.eml']).toBe('oversized');
    expect(queuedFiles().sort()).toEqual(['big.reply.eml', 'link.reply.eml', 'outside.reply.eml', 'two.reply.eml']);
  });

  it('returns a transport failure to the outbox for the next pass', async () => {
    await dropReply('order-1');
    const name = queuedFiles()[0]!;
    let fail = true;
    const calls: EmailOutboxMessage[] = [];
    const transport: EmailTransport = async (message) => {
      calls.push(message);
      return fail ? { ok: false, error: 'mail unavailable' } : { ok: true };
    };
    const first = await sendEmailOutbox({ dir: outboxDir, allowedRecipients: allowedSenders, transport });
    expect(first).toMatchObject({ sent: 0, failed: 1 });
    expect(first.details[0]).toMatchObject({ name, reason: 'mail unavailable' });
    expect(queuedFiles()).toEqual([name]);
    fail = false;
    const second = await sendEmailOutbox({ dir: outboxDir, allowedRecipients: allowedSenders, transport });
    expect(second.sent).toBe(1);
    expect(sentFiles()).toEqual([name]);
    expect(calls).toHaveLength(2);
  });

  it('reports a claim left in sending/ as stuck and never resends it', async () => {
    mkdirSync(join(outboxDir, 'sending'), { recursive: true });
    writeFileSync(join(outboxDir, 'sending', 'orphan.reply.eml'), `To: ${sender}\r\nSubject: Re: x\r\n\r\nbody\r\n`);
    const calls: EmailOutboxMessage[] = [];
    const result = await sendEmailOutbox({ dir: outboxDir, allowedRecipients: allowedSenders, transport: okTransport(calls) });
    expect(calls).toHaveLength(0);
    expect(result.stuck).toBe(1);
    expect(result.details[0]).toMatchObject({ name: 'orphan.reply.eml', outcome: 'stuck', reason: 'interrupted-send' });
    expect(readEmailOutbox(outboxDir).counts).toEqual({ queued: 0, sent: 0, stuck: 1 });
    expect(readEmailOutbox(outboxDir).entries[0]).toMatchObject({ state: 'stuck', reason: 'interrupted-send' });
  });
});

describe('macMailTransport', () => {
  it('passes a hostile subject only as an argv item, never in script source', async () => {
    const hostile = 'quotes "inside" do shell script "danger"';
    const seen: { argv: string[]; timeoutMs: number }[] = [];
    const runner: OsaScriptRunner = async (argv, timeoutMs) => {
      seen.push({ argv, timeoutMs });
      return { code: 0 };
    };
    const result = await macMailTransport(runner)({ to: sender, subject: hostile, body: 'ack body' });
    expect(result.ok).toBe(true);
    const { argv, timeoutMs } = seen[0]!;
    expect(argv[0]).toBe('osascript');
    expect(timeoutMs).toBe(30_000);
    const scriptIndex = argv.indexOf('-e') + 1;
    expect(argv[scriptIndex]).toContain('on run argv');
    expect(argv[scriptIndex]).not.toContain(hostile);
    expect(argv[scriptIndex]).not.toContain('ack body');
    expect(argv.filter((item) => item === hostile)).toEqual([hostile]);
    expect(argv[scriptIndex + 2]).toBe(hostile);
  });

  it('returns a failure on a non-zero exit and never throws', async () => {
    const transport = macMailTransport(async () => ({ code: 1, stderr: 'Mail error' }));
    expect(await transport({ to: sender, subject: 's', body: 'b' })).toEqual({ ok: false, error: 'Mail error' });
    const thrown = macMailTransport(async () => { throw new Error('spawn died'); });
    expect((await thrown({ to: sender, subject: 's', body: 'b' })).ok).toBe(false);
  });

  it('fails without spawning on non-darwin', async () => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { ...original, value: 'linux' });
    try {
      const runner = vi.fn() as unknown as OsaScriptRunner;
      const result = await macMailTransport(runner)({ to: sender, subject: 's', body: 'b' });
      expect(result.ok).toBe(false);
      expect(runner).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, 'platform', original);
    }
  });
});

describe('fleet email-outbox verb', () => {
  it('loads cmdFleetEmailOutbox through the generated registry', async () => {
    const loaded = await FLEET_SUBCOMMAND_LOADERS['email-outbox']!();
    expect(loaded['cmdFleetEmailOutbox']).toBe(cmdFleetEmailOutbox);
  });

  it('lists queued replies read-only and --json parses without a body', async () => {
    await writeEmailDropConfig(runsDir, { v: 1, inboxDir: join(root, 'inbox'), outboxDir, from: [sender] });
    await dropReply('order-1');
    expect(await cmdFleetEmailOutbox(['--json'], { runsDir })).toBe(0);
    const listed = JSON.parse(logs[0]!);
    expect(listed.counts).toEqual({ queued: 1, sent: 0, stuck: 0 });
    expect(listed.entries[0]).toMatchObject({ state: 'queued', to: sender });
    expect(logs[0]).not.toContain('Please check the fleet');
    expect(await cmdFleetEmailOutbox([], { runsDir })).toBe(0);
    expect(logs[1]).toContain('email-outbox: queued=1 sent=0 stuck=0');
    expect(errors).toEqual([]);
  });

  it('--send drains through the injected transport; missing allowlist exits 2 sending nothing', async () => {
    await dropReply('order-1');
    const calls: EmailOutboxMessage[] = [];
    const deps = { runsDir, transport: okTransport(calls) };
    expect(await cmdFleetEmailOutbox(['--send'], deps)).toBe(2);
    expect(calls).toHaveLength(0);
    expect(errors.join('\n')).toContain('no allowlist');
    await writeEmailDropConfig(runsDir, { v: 1, inboxDir: join(root, 'inbox'), outboxDir, from: [sender] });
    logs.length = 0;
    expect(await cmdFleetEmailOutbox(['--send', '--json'], deps)).toBe(0);
    expect(JSON.parse(logs[0]!)).toMatchObject({ sent: 1, refused: 0, failed: 0, stuck: 0 });
    expect(calls).toHaveLength(1);
    expect(sentFiles()).toHaveLength(1);
  });

  it('exits 2 on invalid config and sends nothing', async () => {
    mkdirSync(join(runsDir, 'queue'), { recursive: true });
    writeFileSync(join(runsDir, 'queue', 'email-drop.json'), '{}');
    const calls: EmailOutboxMessage[] = [];
    expect(await cmdFleetEmailOutbox(['--send', '--dir', outboxDir], { runsDir, transport: okTransport(calls) })).toBe(2);
    expect(calls).toHaveLength(0);
  });
});
