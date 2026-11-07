import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdCommsBus } from '../src/cli/comms-bus.js';
import { appendBusInbox, listBusInboxAfter, type BusInboxOptions } from '../src/core/fleet/bus-inbox.js';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'bus-compose-')); roots.push(root);
  const options: BusInboxOptions = { root, now: () => 1000 };
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const run = async (args: string[], override: BusInboxOptions = options) => {
    let output = '';
    const code = await cmdCommsBus(args, override, { emit: json => { output = json; } });
    return { code, result: JSON.parse(output || String(log.mock.calls.at(-1)?.[0])) };
  };
  const parent = { id: 'request', from: 'origin', to: 'worker', priority: 'P1', ttl: 10000, body: { private: 'parent-body-sentinel' } };
  const file = join(root, 'parent.json');
  writeFileSync(file, JSON.stringify(parent));
  const postParent = () => run(['post', '--file', file]);
  const compose = ['post', '--reply-to', 'request', '--id', 'reply', '--from', 'responder', '--text', 'hello'];
  const snapshot = () => readFileSync(join(root, 'bus-inbox', 'messages.json'), 'utf8');
  return { root, options, run, parent, file, postParent, compose, snapshot };
}

it('composes a correlated reply with parent routing and priority, and preserves duplicate and conflict receipts', async () => {
  const { run, postParent, compose, snapshot } = setup();
  expect(await postParent()).toEqual({ code: 0, result: { status: 'posted', id: 'request', cursor: 1 } });
  expect(await run(compose)).toEqual({ code: 0, result: { status: 'posted', id: 'reply', cursor: 2 } });
  const page = await run(['read', '--in-reply-to', 'request']);
  expect(page.code).toBe(0);
  expect(page.result.messages).toEqual([{ cursor: 2, receivedAt: 1000, envelope: {
    id: 'reply', from: 'responder', to: 'origin', priority: 'P1', ttl: 60000, body: { inReplyTo: 'request', text: 'hello' },
  } }]);
  const before = snapshot();
  expect(await run(compose)).toEqual({ code: 0, result: { status: 'duplicate', id: 'reply', cursor: 2 } });
  expect(await run([...compose.slice(0, -1), 'changed'])).toEqual({ code: 1, result: { status: 'conflict' } });
  expect(snapshot()).toBe(before);
}, 30000);

it('finds a live parent beyond the first page and accepts an explicit TTL and flag-shaped text', async () => {
  const { root, options, run, postParent, compose } = setup();
  const filler = (i: number) => ({ cursor: i + 1, receivedAt: 1000, envelope: { id: `filler-${i}`, from: 'a', to: 'b', priority: 'P3', ttl: 10000, body: null } });
  expect(appendBusInbox(filler(0).envelope, options).status).toBe('posted');
  writeFileSync(join(root, 'bus-inbox', 'messages.json'), JSON.stringify(Array.from({ length: 100 }, (_, i) => filler(i))));
  expect((await postParent()).code).toBe(0);
  expect((await run([...compose.slice(0, -2), '--text=--hello', '--ttl-ms', '1234'])).result).toEqual({ status: 'posted', id: 'reply', cursor: 102 });
  const page = listBusInboxAfter(101, 1, options);
  expect(page).toMatchObject({ status: 'ok', messages: [{ envelope: { to: 'origin', priority: 'P1', ttl: 1234, body: { inReplyTo: 'request', text: '--hello' } } }] });
}, 30000);

it('does not write for missing, expired or unavailable parents and does not reveal bodies', async () => {
  const { root, options, run, postParent, compose, snapshot } = setup();
  expect((await postParent()).code).toBe(0);
  const before = snapshot();
  for (const [args, opts] of [
    [[...compose.slice(0, 2), 'missing', ...compose.slice(3)], options],
    [compose, { ...options, now: () => 11000 }],
  ] as const) {
    const result = await run([...args], opts);
    expect(result.code).not.toBe(0);
    expect(JSON.stringify(result)).not.toContain('parent-body-sentinel');
    expect(snapshot()).toBe(before);
  }
  const file = join(root, 'bus-inbox', 'messages.json');
  writeFileSync(file, 'unavailable');
  expect(await run(compose)).toEqual({ code: 1, result: { status: 'unavailable' } });
  expect(readFileSync(file, 'utf8')).toBe('unavailable');
});

it('rejects ambiguous, incomplete and invalid inputs before writing', async () => {
  const { run, postParent, compose, file, snapshot } = setup();
  await postParent();
  const before = snapshot();
  for (const args of [
    [...compose, '--file', file], ['post', '--file', file, '--id', 'other'],
    compose.slice(0, -2), [...compose, '--id', 'other'],
    [...compose, '--ttl-ms', '0'], [...compose, '--ttl-ms', '-1'], [...compose, '--ttl-ms', '1e3'],
    [...compose, '--ttl-ms', '1.5'], [...compose, '--ttl-ms', '9007199254740992'],
    [...compose, '--ttl-ms'], [...compose.slice(0, 4), 'invalid id', ...compose.slice(5)],
    [...compose.slice(0, -1), 'x'.repeat(65536)],
  ]) {
    expect(await run(args)).toEqual({ code: 2, result: { status: 'invalid' } });
    expect(snapshot()).toBe(before);
  }
});

it('bounds scans and refuses ambiguous or non-progressing pages without appending', async () => {
  const { options, postParent, compose, snapshot } = setup();
  await postParent();
  const page = listBusInboxAfter(0, 100, options);
  if (page.status !== 'ok') throw new Error('fixture unavailable');
  const before = snapshot();
  for (const [fakePage, status] of [
    [{ ...page, messages: [...page.messages, ...page.messages] }, 'invalid'],
    [{ ...page, messages: Array(100).fill({ ...page.messages[0], envelope: { ...page.messages[0]!.envelope, id: 'other' } }), nextCursor: 0 }, 'unavailable'],
  ] as const) {
    let output = '';
    const code = await cmdCommsBus(compose, options, { list: () => fakePage, emit: json => { output = json; } });
    expect(code).not.toBe(0);
    expect(JSON.parse(output).status).toBe(status);
    expect(snapshot()).toBe(before);
  }
});

it('documents compose mode and its finite default lifetime in local help', async () => {
  setup();
  await cmdCommsBus(['post', '--help']);
  const log = vi.mocked(console.log);
  expect(log.mock.calls.at(-1)?.[0]).toContain('TTL defaults to 60000 ms');
  expect(log.mock.calls.at(-1)?.[0]).toContain('--reply-to <id>');
});
