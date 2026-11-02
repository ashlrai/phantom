import { mkdtempSync, rmSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveFleetSubcommand } from '../src/cli/fleet-subcommand-resolve.js';
import { cmdFleetBusReply } from '../src/cli/fleet-bus-reply.js';
import { postBusReply } from '../src/core/fleet/bus-reply-post.js';
import { appendBusInbox, listBusInboxAfter, BUS_INBOX_MAX_READ } from '../src/core/fleet/bus-inbox.js';
import { requestBusRoundtrip } from '../src/core/fleet/bus-request-roundtrip.js';
import { MAX_BUS_ENVELOPE_BYTES } from '../src/core/fleet/bus-envelope.js';

let root: string, file: string, now: number;
const request = (id = 'request') => ({ id, from: 'requester', to: 'responder', priority: 'P1' as const, ttl: 10000, body: { token: 'never-output' } });
const options = () => ({ root, now: () => now });
const post = () => appendBusInbox(request(), options());
const invoke = (extra: string[] = []) => {
  const output: string[] = [];
  const code = cmdFleetBusReply(['--request-id', 'request', '--reply-id', 'reply', '--body-file', file, ...extra], options(), { output: text => output.push(text) });
  return { code, text: output.join(''), result: JSON.parse(output[0]!) as { outcome: string; transport: string } };
};
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fleet-reply-')); file = join(root, 'body.json'); now = 1000;
  writeFileSync(file, '{"answer":"opaque","command":"never execute","secret":"never-output"}', { mode: 0o600 });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('convention-loaded bus reply', { timeout: 30000 }, () => {
  it('exports the convention name and resolves the real request waiter using real storage', async () => {
    expect(resolveFleetSubcommand('bus-reply')).toEqual({ module: './fleet-bus-reply.js', exportName: cmdFleetBusReply.name });
    const waiting = requestBusRoundtrip(request(), 25000, 100, options());
    expect(invoke(['--json']).code).toBe(0);
    const result = await waiting;
    expect(result.outcome).toBe('replied');
    expect(result.reply?.envelope).toMatchObject({ id: 'reply', from: 'responder', to: 'requester', priority: 'P1', body: { inReplyTo: 'request' } });
    expect(invoke().text).not.toContain('never-output');
  });

  it('retries after time advances without another message or refreshed TTL and refuses conflicts', () => {
    post(); now += 100;
    expect(invoke().result.outcome).toBe('posted');
    const page = listBusInboxAfter(0, 100, options());
    expect(page.status === 'ok' && page.messages.find(row => row.envelope.id === 'reply')?.envelope.ttl).toBe(9900);
    const snapshot = readFileSync(join(root, 'bus-inbox/messages.json'), 'utf8');
    now += 500;
    expect(invoke().result.outcome).toBe('duplicate');
    expect(readFileSync(join(root, 'bus-inbox/messages.json'), 'utf8')).toBe(snapshot);
    writeFileSync(file, '{"different":true}');
    expect(invoke()).toMatchObject({ code: 4, result: { outcome: 'transport-refused', transport: 'conflict' } });
    expect(readFileSync(join(root, 'bus-inbox/messages.json'), 'utf8')).toBe(snapshot);
  });

  it('distinguishes missing/expired requests without creating or writing storage', () => {
    expect(invoke()).toMatchObject({ code: 3, result: { outcome: 'request-not-found' } });
    post(); const before = readFileSync(join(root, 'bus-inbox/messages.json'), 'utf8');
    now += 10000;
    expect(invoke().code).toBe(3);
    expect(readFileSync(join(root, 'bus-inbox/messages.json'), 'utf8')).toBe(before);
  });

  it('scans multiple bounded pages including high-water cursors beyond retained capacity', () => {
    // Seed valid sparse storage to model earlier expired rows already reclaimed.
    const rows = Array.from({ length: BUS_INBOX_MAX_READ + 1 }, (_, i) => ({
      cursor: 2000 + i, receivedAt: now, envelope: request(i === BUS_INBOX_MAX_READ ? 'request' : `filler-${i}`),
    }));
    post();
    writeFileSync(join(root, 'bus-inbox/messages.json'), JSON.stringify({ version: 2, highWater: 2100, rows }), { mode: 0o600 });
    const calls: number[] = [];
    expect(postBusReply('request', 'reply', {}, options(), { list: (after, limit, opts) => {
      calls.push(limit!); return listBusInboxAfter(after, limit, opts);
    } }).outcome).toBe('posted');
    expect(calls).toEqual([BUS_INBOX_MAX_READ, BUS_INBOX_MAX_READ]);
  });

  it.each(['null', '[]', 'true', '{', '{"inReplyTo":"forged"}', '{"inReplyTo":null}', '1e999'])('rejects invalid/reserved body %s without writing', body => {
    post(); const before = readFileSync(join(root, 'bus-inbox/messages.json'), 'utf8');
    writeFileSync(file, body);
    expect(invoke().code).toBe(2);
    expect(readFileSync(join(root, 'bus-inbox/messages.json'), 'utf8')).toBe(before);
  });

  it('bounds file and envelope reads and rejects symlinks, directories and authority flags', () => {
    post();
    writeFileSync(file, ' '.repeat(MAX_BUS_ENVELOPE_BYTES + 1)); expect(invoke().code).toBe(2);
    writeFileSync(file, JSON.stringify({ text: 'a'.repeat(MAX_BUS_ENVELOPE_BYTES - 20) })); expect(invoke().code).toBe(2);
    rmSync(file); symlinkSync(join(root, 'bus-inbox/messages.json'), file); expect(invoke().code).toBe(2);
    rmSync(file); symlinkSync(root, file); expect(invoke().code).toBe(2);
    expect(invoke(['--root', root]).code).toBe(2);
    let help = ''; expect(cmdFleetBusReply(['--help'], {}, { output: text => { help = text; } })).toBe(0);
    expect(help).toContain('do not authenticate');
  });

  it('reports read and append refusals without writing or leaking payloads', () => {
    post(); const before = readFileSync(join(root, 'bus-inbox/messages.json'), 'utf8');
    expect(postBusReply('request', 'reply', {}, options(), { list: () => ({ status: 'unavailable' }) })).toMatchObject({ outcome: 'transport-refused' });
    expect(postBusReply('request', 'reply', {}, options(), { append: () => ({ status: 'full' }) })).toMatchObject({ outcome: 'transport-refused', transport: 'full' });
    expect(readFileSync(join(root, 'bus-inbox/messages.json'), 'utf8')).toBe(before);
  });

  it('subtracts lookup time and refuses expiry before append', () => {
    post();
    const reply = postBusReply('request', 'reply', {}, options(), { list: (after, limit, opts) => {
      const page = listBusInboxAfter(after, limit, opts); now += 10000; return page;
    }, append: () => { throw new Error('must not append'); } });
    expect(reply.outcome).toBe('request-not-found');
  });
});
