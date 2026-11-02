import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { runBusReplyFile } from '../examples/agents/bus-reply-file.js';
import { MAX_BUS_ENVELOPE_BYTES } from '../src/core/fleet/bus-envelope.js';
import type { BusInboxOptions, BusInboxPost } from '../src/core/fleet/bus-inbox.js';

const request = { id: 'fake-request', from: 'fake-requester', to: 'fake-worker', priority: 'P1', ttl: 5000, body: { task: 'fixture' } };
const args = ['--request-file', 'request.json', '--body-file', 'body.json', '--from', 'fake-responder', '--id', 'fake-reply', '--ttl', '60000'];
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function setup(requestText = JSON.stringify(request), bodyText = '{"answer":42}') {
  const write = vi.fn((_line: string) => {});
  const append = vi.fn((_value: unknown, _options?: BusInboxOptions): BusInboxPost => ({ status: 'posted', id: 'fake-reply', cursor: 7 }));
  const readFile = vi.fn((path: string) => path === 'request.json' ? requestText : bodyText);
  const now = () => 123;
  const run = (input = args) => {
    write.mockClear();
    const code = runBusReplyFile(input, { readFile, append, write, options: { now } });
    expect(write).toHaveBeenCalledTimes(1);
    return { code, result: JSON.parse(write.mock.calls[0][0] as string) };
  };
  return { run, append, readFile, now };
}

it('addresses and correlates one response, using the caller sender and request priority', () => {
  const { run, append, now } = setup();
  expect(run()).toEqual({ code: 0, result: { status: 'posted', id: 'fake-reply', cursor: 7 } });
  expect(append).toHaveBeenCalledOnce();
  expect(append).toHaveBeenCalledWith({
    id: 'fake-reply', from: 'fake-responder', to: 'fake-requester', priority: 'P1', ttl: 60000,
    body: { replyTo: 'fake-request', payload: { answer: 42 } },
  }, { now });
});

it('accepts a priority override and preserves a duplicate transport receipt', () => {
  const { run, append } = setup();
  append.mockReturnValue({ status: 'duplicate', id: 'fake-reply', cursor: 7 });
  expect(run([...args, '--priority', 'P0'])).toEqual({ code: 0, result: { status: 'duplicate', id: 'fake-reply', cursor: 7 } });
  expect(append.mock.calls[0][0]).toMatchObject({ priority: 'P0' });
});

it('rejects invalid or missing required options and TTL without reading or appending', () => {
  const { run, readFile, append } = setup();
  for (const input of [args.slice(0, -2), args.filter((_, i) => i !== 4 && i !== 5),
    [...args.slice(0, -1), '0'], [...args.slice(0, -1), '1e3'], [...args.slice(0, -1), '9007199254740992'],
    [...args, '--root', 'relative'], [...args, '--ttl', '1'], [...args, '--unknown', 'x']]) {
    expect(run(input)).toEqual({ code: 2, result: { status: 'invalid-arguments' } });
  }
  expect(readFile).not.toHaveBeenCalled();
  expect(append).not.toHaveBeenCalled();
});

it('rejects bad request and body JSON and invalid response fields without appending', () => {
  for (const [requestText, bodyText, status] of [
    ['{', '{}', 'invalid-request'],
    [JSON.stringify({ ...request, from: 'bad address' }), '{}', 'invalid-request'],
    [JSON.stringify(request), '{', 'invalid-body'],
  ]) {
    const { run, append } = setup(requestText, bodyText);
    expect(run()).toMatchObject({ code: 2, result: { status } });
    expect(append).not.toHaveBeenCalled();
  }
  for (const extra of [['--priority', 'P4'], ['--from', 'bad address']]) {
    const { run, append } = setup();
    const input = extra[0] === '--from' ? [...args.slice(0, 5), extra[1], ...args.slice(6)] : [...args, ...extra];
    expect(run(input)).toMatchObject({ code: 2, result: { status: 'invalid-response' } });
    expect(append).not.toHaveBeenCalled();
  }
});

it('enforces the production UTF-8 response limit after composing the wrapper', () => {
  const body = JSON.stringify('é'.repeat(32730));
  expect(Buffer.byteLength(body)).toBeLessThanOrEqual(MAX_BUS_ENVELOPE_BYTES);
  const { run, append } = setup(JSON.stringify(request), body);
  expect(run()).toMatchObject({ code: 2, result: { status: 'invalid-response', issues: [{ code: 'too-large' }] } });
  expect(append).not.toHaveBeenCalled();
});

it('returns conflict and full distinctly, with no retry', () => {
  for (const status of ['conflict', 'full', 'retryable', 'unavailable'] as const) {
    const { run, append } = setup();
    append.mockReturnValue({ status });
    expect(run()).toEqual({ code: 3, result: { status } });
    expect(append).toHaveBeenCalledOnce();
  }
});

it('reads bounded regular files and reports unavailable sources without echoing content', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bus-reply-'));
  dirs.push(dir);
  const requestPath = join(dir, 'request.json'), bodyPath = join(dir, 'body.json');
  writeFileSync(requestPath, JSON.stringify(request));
  writeFileSync(bodyPath, 'null');
  const output: string[] = [];
  const append = vi.fn((_value: unknown) => ({ status: 'posted' as const, id: 'fake-reply', cursor: 1 }));
  const fileArgs = ['--request-file', requestPath, '--body-file', bodyPath, ...args.slice(4)];
  expect(runBusReplyFile(fileArgs, { append, write: line => output.push(line) })).toBe(0);
  expect(append.mock.calls[0][0]).toMatchObject({ body: { replyTo: 'fake-request', payload: null } });
  writeFileSync(bodyPath, 'x'.repeat(MAX_BUS_ENVELOPE_BYTES + 1));
  append.mockClear();
  expect(runBusReplyFile(fileArgs, { append, write: line => output.push(line) })).toBe(2);
  expect(JSON.parse(output[1])).toEqual({ status: 'file-unavailable' });
  expect(append).not.toHaveBeenCalled();
});

it('runs as a CLI and emits JSON errors for invalid arguments', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bus-reply-cli-'));
  dirs.push(dir);
  try {
    execFileSync(process.execPath, [join(process.cwd(), 'node_modules/tsx/dist/cli.mjs'), 'examples/agents/bus-reply-file.ts'], {
      encoding: 'utf8', timeout: 15000, env: { ...process.env, HOME: dir, ASHLR_HOME: join(dir, 'ashlr') },
    });
    throw new Error('expected invalid arguments');
  } catch (error) {
    expect(error).toMatchObject({ status: 2, stdout: '{"status":"invalid-arguments"}\n' });
  }
}, 20000);
