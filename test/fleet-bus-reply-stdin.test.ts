import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetBusReplyStdin } from '../src/cli/fleet-bus-reply-stdin.js';
import { resolveFleetSubcommand } from '../src/cli/fleet-subcommand-resolve.js';
import { MAX_BUS_ENVELOPE_BYTES } from '../src/core/fleet/bus-envelope.js';
import { appendBusInbox, listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';

let root: string, now: number;
const args = ['--request-id', 'request', '--reply-id', 'reply'];
const options = () => ({ root, now: () => now });
const post = () => appendBusInbox({ id: 'request', from: 'requester', to: 'worker',
  priority: 'P1', ttl: 10000, body: { question: 'hello' } }, options());
const snapshot = () => readFileSync(join(root, 'bus-inbox/messages.json'), 'utf8');
const run = async (input: Readable, flags = args, extra: Parameters<typeof cmdFleetBusReplyStdin>[2] = {}) => {
  const output: string[] = [];
  const code = await cmdFleetBusReplyStdin(flags, options(), { ...extra, input, output: text => output.push(text) });
  return { code, text: output.join(''), result: JSON.parse(output[0]!) as { outcome: string; transport: string | null } };
};
const stream = (text: string | Buffer) => Readable.from([Buffer.from(text)]);
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'reply-stdin-')); now = 1000; });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('bus reply stdin', { timeout: 30000 }, () => {
  it('resolves its convention name and streams UTF-8 into the real reader, with stable retries', async () => {
    expect(resolveFleetSubcommand('bus-reply-stdin')).toEqual({ module: './fleet-bus-reply-stdin.js', exportName: cmdFleetBusReplyStdin.name });
    expect(post().status).toBe('posted');
    const input = new PassThrough();
    const first = run(input, [...args, '--input-timeout-ms', '30000', '--json']);
    const bytes = Buffer.from('{"answer":"café"}');
    const split = bytes.indexOf(Buffer.from('é')) + 1;
    const beforeEof = snapshot();
    input.write(bytes.subarray(0, split));
    expect(snapshot()).toBe(beforeEof);
    input.end(bytes.subarray(split));
    expect(await first).toMatchObject({ code: 0, result: { outcome: 'posted' } });
    const page = listBusInboxAfter(0, 100, options());
    expect(page.status).toBe('ok');
    if (page.status !== 'ok') throw new Error('read failed');
    expect(page.messages).toHaveLength(2);
    expect(page.messages[1]?.envelope).toMatchObject({ id: 'reply', from: 'worker', to: 'requester', priority: 'P1', body: { answer: 'café', inReplyTo: 'request' } });
    const before = snapshot(); now += 500;
    expect(await run(stream(bytes))).toMatchObject({ code: 0, result: { outcome: 'duplicate' } });
    expect(await run(stream('{"answer":"changed"}'))).toMatchObject({ code: 4, result: { outcome: 'transport-refused', transport: 'conflict' } });
    expect(snapshot()).toBe(before);
  });

  it.each(['', '  ', '{', 'null', '[]', 'true', '42', '"text"', '{"inReplyTo":"request"}', '{"x":1e999}'])('refuses invalid or reserved body without a receipt', async body => {
    post(); const before = snapshot();
    const result = await run(stream(body));
    expect(result).toMatchObject({ code: 2, result: { outcome: 'invalid-input' } });
    expect(result.text).not.toContain('inReplyTo');
    expect(snapshot()).toBe(before);
  });

  it('rejects invalid UTF-8 without echoing the input or parser error', async () => {
    post(); const before = snapshot();
    const result = await run(stream(Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d])));
    expect(result).toMatchObject({ code: 2, result: { outcome: 'invalid-input' } });
    expect(result.text).not.toContain('encoded'); expect(snapshot()).toBe(before);
  });

  it('stops reading an oversized stream promptly and removes listeners', async () => {
    post(); const before = snapshot();
    const input = new PassThrough();
    const pending = run(input);
    input.write(Buffer.alloc(MAX_BUS_ENVELOPE_BYTES));
    input.write(Buffer.from('x'));
    expect((await pending).code).toBe(2);
    expect(input.isPaused()).toBe(true);
    expect(input.listenerCount('data')).toBe(0);
    expect(snapshot()).toBe(before);
    input.destroy();
  });

  it('refuses a timeout, TTY, already-ended input, premature close, errors and interruption', async () => {
    post(); const before = snapshot();
    const stalled = new PassThrough();
    const sigintCount = process.listenerCount('SIGINT'), sigtermCount = process.listenerCount('SIGTERM');
    expect((await run(stalled, [...args, '--input-timeout-ms', '10'])).code).toBe(2);
    expect(stalled.listenerCount('data')).toBe(0);
    expect(process.listenerCount('SIGINT')).toBe(sigintCount); expect(process.listenerCount('SIGTERM')).toBe(sigtermCount);
    const tty = new PassThrough() as PassThrough & { isTTY: boolean }; tty.isTTY = true;
    expect((await run(tty)).code).toBe(2);
    const ended = stream(''); ended.resume(); await new Promise(resolve => ended.once('end', resolve));
    expect((await run(ended)).code).toBe(2);
    const closed = new PassThrough(); const closeResult = run(closed); closed.destroy();
    expect((await closeResult).code).toBe(2);
    const errored = new PassThrough(); const errorResult = run(errored); errored.destroy(new Error('private input'));
    expect((await errorResult).text).not.toContain('private input');
    const controller = new AbortController(), interrupted = new PassThrough();
    const interruptedResult = run(interrupted, args, { signal: controller.signal }); controller.abort();
    expect((await interruptedResult).code).toBe(2);
    expect(interrupted.listenerCount('data')).toBe(0);
    expect(snapshot()).toBe(before);
    stalled.destroy(); tty.destroy(); interrupted.destroy();
  });

  it('rejects duplicate, unknown and malformed flags without reading or calling the writer', async () => {
    const list = vi.fn();
    for (const flags of [[], [...args, '--json', '--json'], [...args, '--request-id', 'other'],
      [...args, '--unknown'], [...args, '--input-timeout-ms', '9'], [...args, '--input-timeout-ms=30001'],
      [...args, '--input-timeout-ms', '1e2'], [...args, '--input-timeout-ms'], [...args, '--input-timeout-ms=10', '--input-timeout-ms=20']]) {
      const input = new PassThrough();
      expect((await run(input, flags, { list })).code).toBe(2);
      expect(input.listenerCount('data')).toBe(0); input.destroy();
    }
    expect(list).not.toHaveBeenCalled();
  });

  it('honors expiry and never exposes body text in output', async () => {
    post(); const before = snapshot(); now += 10000;
    const result = await run(stream('{"answer":"private-value"}'));
    expect(result).toMatchObject({ code: 3, result: { outcome: 'request-not-found' } });
    expect(result.text).not.toContain('private-value'); expect(snapshot()).toBe(before);
  });

  it('documents the finite wait and routing limitations', async () => {
    const output: string[] = [];
    expect(await cmdFleetBusReplyStdin(['--help'], {}, { output: text => output.push(text) })).toBe(0);
    expect(output[0]).toContain('10 to 30000 ms'); expect(output[0]).toContain('do not authenticate');
  });
});
