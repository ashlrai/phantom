import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runFleetBusRequest } from '../scripts/fleet-bus-request.js';
import { MAX_BUS_ENVELOPE_BYTES, type BusEnvelope } from '../src/core/fleet/bus-envelope.js';
import { appendBusInbox, listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';

const request: BusEnvelope = { id: 'fake-request', from: 'fake-a', to: 'fake-b', priority: 'P2', ttl: 60_000, body: { text: 'fake request' } };
const reply = (id: string, overrides: Partial<BusEnvelope> = {}): BusEnvelope => ({
  id, from: 'fake-b', to: 'fake-a', priority: 'P2', ttl: 60_000, body: { inReplyTo: request.id, text: 'fake reply' }, ...overrides,
});
let home: string, root: string, file: string, clock: number, storeTime: number, output: string;
const args = () => ['--file', file, '--timeout-ms', '500', '--json'];
const inboxOptions = () => ({ root, now: () => storeTime });
function post(message: BusEnvelope): void { expect(appendBusInbox(message, inboxOptions()).status).toBe('posted'); }
async function run(extra: Parameters<typeof runFleetBusRequest>[1] = {}, argv = args()) {
  output = '';
  const code = await runFleetBusRequest(argv, { inboxOptions: inboxOptions(), now: () => clock,
    sleep: async ms => { clock += ms; }, write: text => { output += text; }, ...extra });
  return { code, result: JSON.parse(output) as Record<string, any> };
}
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'fake-bus-request-'));
  root = join(home, 'fleet'); file = join(home, 'request.json'); clock = 0; storeTime = 1000;
  writeFileSync(file, JSON.stringify(request));
});
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

describe('durable fleet bus request', () => {
  it('resumes a duplicate and finds a reply already present without reposting', async () => {
    post(request); post(reply('fake-reply'));
    const { code, result } = await run();
    expect(code).toBe(0);
    expect(result).toMatchObject({ status: 'reply', post: { status: 'duplicate', cursor: 1 }, reply: { envelope: { id: 'fake-reply' } } });
    expect(listBusInboxAfter(0, 100, inboxOptions())).toMatchObject({ status: 'ok', nextCursor: 2 });
  });

  it('posts once and ignores wrong correlation, sender, recipient, and expired replies across pages', async () => {
    post(reply('fake-expired', { ttl: 1 }));
    // Seed a valid snapshot in bulk; all reads and subsequent posts use the real store.
    const snapshot = join(root, 'bus-inbox', 'messages.json');
    const rows = JSON.parse(readFileSync(snapshot, 'utf8')) as { cursor: number; receivedAt: number; envelope: BusEnvelope }[];
    const add = (envelope: BusEnvelope): void => { rows.push({ cursor: rows.length + 1, receivedAt: storeTime, envelope }); };
    for (let i = 0; i < 405; i++) add(reply(`fake-unmatched-${i}`, { body: { inReplyTo: 'fake-other' } }));
    add(reply('fake-wrong-sender', { from: 'fake-other' }));
    add(reply('fake-wrong-recipient', { to: 'fake-other' }));
    writeFileSync(snapshot, JSON.stringify(rows));
    storeTime++;
    let waits = 0;
    const { code, result } = await run({ sleep: async ms => { waits++; post(reply('fake-match')); clock += ms; } });
    expect(code).toBe(0); expect(waits).toBe(1);
    expect(result).toMatchObject({ status: 'reply', post: { status: 'posted' }, reply: { envelope: { id: 'fake-match' } } });
    const page = listBusInboxAfter(0, 100, inboxOptions());
    expect(page.status).toBe('ok');
    if (page.status === 'ok') expect(page.messages.some(row => row.envelope.id === 'fake-expired')).toBe(false);
  }, 30000);

  it('rejects a conflicting request without waiting or accepting a reply', async () => {
    post({ ...request, body: 'fake different content' }); post(reply('fake-reply'));
    const { code, result } = await run();
    expect(code).toBe(3); expect(result).toMatchObject({ status: 'post-failed', reason: 'conflict', acceptance: 'rejected' });
    expect(clock).toBe(0);
  });

  it('times out distinctly, with a single retained request and bounded sleeps', async () => {
    const waits: number[] = [];
    const { code, result } = await run({ sleep: async ms => { waits.push(ms); clock += ms; } });
    expect(code).toBe(5); expect(result).toMatchObject({ status: 'timeout', post: { status: 'posted' } });
    expect(waits).toEqual([250, 250]);
    expect(listBusInboxAfter(0, 100, inboxOptions())).toMatchObject({ status: 'ok', nextCursor: 1 });
  });

  it('cancels before posting and while waiting, preserving acceptance information', async () => {
    const before = new AbortController(); before.abort();
    expect(await run({ signal: before.signal })).toMatchObject({ code: 130, result: { status: 'interrupted', acceptance: 'not-attempted' } });
    expect(existsSync(root)).toBe(false);
    const during = new AbortController();
    const result = await run({ signal: during.signal, sleep: async () => { during.abort(); throw new Error('cancelled'); } });
    expect(result).toMatchObject({ code: 130, result: { status: 'interrupted', post: { status: 'posted' } } });
  });

  it('rejects invalid arguments, invalid envelopes, unsafe and oversized files before posting', async () => {
    for (const argv of [[], ['--file', 'relative', '--timeout-ms', '1', '--json'],
      ['--file', file, '--timeout-ms', '300001', '--json'], [...args(), '--root', root], [...args(), '--json']]) {
      expect((await run({}, argv)).code).toBe(2);
    }
    writeFileSync(file, '{"id":"fake"}'); expect((await run()).result.status).toBe('invalid-envelope');
    writeFileSync(file, ' '.repeat(MAX_BUS_ENVELOPE_BYTES + 1)); expect((await run()).result.status).toBe('file-unavailable');
    rmSync(file); symlinkSync(join(home, 'missing'), file); expect((await run()).result.status).toBe('file-unavailable');
    expect(existsSync(root)).toBe(false);
  });

  it('executes the real CLI with isolated storage and bounded JSON output', () => {
    const cliRoot = join(home, '.ashlr', 'fleet');
    expect(appendBusInbox(request, { root: cliRoot }).status).toBe('posted');
    expect(appendBusInbox(reply('fake-cli-reply'), { root: cliRoot }).status).toBe('posted');
    const child = spawnSync(process.execPath, ['--import', 'tsx', resolve('scripts/fleet-bus-request.ts'), '--file', file, '--timeout-ms', '20000', '--json'], {
      encoding: 'utf8', env: { HOME: home, USERPROFILE: home, PATH: process.env.PATH }, timeout: 30_000,
    });
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toMatchObject({ status: 'reply', post: { status: 'duplicate' }, reply: { envelope: { id: 'fake-cli-reply' } } });
    expect(Buffer.byteLength(child.stdout)).toBeLessThanOrEqual(MAX_BUS_ENVELOPE_BYTES + 2048);
  }, 30000);
});
