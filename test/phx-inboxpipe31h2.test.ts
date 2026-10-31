import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { createCommsInboxCommand } from '../src/cli/comms-inbox.js';
import { INBOX_MAX_CHARS } from '../src/core/fleet/mason-inbox.js';

const roots: string[] = [];
function setup(stdin: Readable) {
  const root = mkdtempSync(join(tmpdir(), 'inbox-pipe-'));
  roots.push(root);
  const command = createCommsInboxCommand({ runsDir: join(root, 'runs'), stdin });
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const output = () => JSON.parse(String(log.mock.calls.at(-1)?.[0]));
  return { root, command, output };
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it('posts split UTF-8 and reads the normalized multiline message from the shared inbox', async () => {
  const bytes = Buffer.from('  Mason says: café 🌍\r\nPlease continue.  \n');
  const chunks = Array.from(bytes, (_, i) => bytes.subarray(i, i + 1));
  const { command, output } = setup(Readable.from(chunks));
  expect(await command(['post', '--file', '-', '--json'])).toBe(0);
  expect(output()).toEqual({ ok: true, ack: { channel: 'cli', status: 'accepted', dedupeKey: expect.stringMatching(/^[a-f0-9]{64}$/) } });
  expect(await command(['read'])).toBe(0);
  expect(output()).toMatchObject({ sourceState: 'healthy', entries: [{ source: 'cli', text: 'Mason says: café 🌍\nPlease continue.' }] });
});

it.each([
  ['empty input', ' \n', 'empty'],
  ['too many characters', 'x'.repeat(INBOX_MAX_CHARS + 1), 'too-long'],
  ['secret-shaped input', 'password=plainly-fake-example', 'secret-shaped'],
  ['too many bytes', '界'.repeat(INBOX_MAX_CHARS + 1), 'stdin-unavailable'],
])('rejects %s without appending', async (_name, body, reason) => {
  const { command, output } = setup(Readable.from([Buffer.from(body)]));
  expect(await command(['post', '--file', '-'])).toBe(1);
  expect(output()).toEqual({ ok: false, reason });
  expect(await command(['read'])).toBe(0);
  expect(output()).toEqual({ sourceState: 'missing', entries: [] });
});

it('accepts the exact UTF-8 byte limit', async () => {
  const body = '界'.repeat(INBOX_MAX_CHARS);
  const { command, output } = setup(Readable.from([Buffer.from(body)]));
  expect(await command(['post', '--file', '-'])).toBe(0);
  expect(await command(['read'])).toBe(0);
  expect(output().entries[0].text).toBe(body);
});

it('rejects a stream error without exposing it or appending partial input', async () => {
  const stdin = Readable.from((async function* () {
    yield Buffer.from('partial input');
    throw new Error('private stream detail');
  })());
  const { command, output } = setup(stdin);
  expect(await command(['post', '--file', '-'])).toBe(1);
  expect(output()).toEqual({ ok: false, reason: 'stdin-unavailable' });
  expect(await command(['read'])).toBe(0);
  expect(output()).toEqual({ sourceState: 'missing', entries: [] });
});

it('retains file handling and validates arguments before consuming stdin', async () => {
  const stdin = Readable.from(['stdin message']);
  const { root, command, output } = setup(stdin);
  expect(await command(['post', '--file', '-', '--sender', 'fake'])).toBe(2);
  expect(output()).toEqual({ status: 'invalid' });
  const path = join(root, 'message.txt');
  writeFileSync(path, 'file message', { mode: 0o600 });
  expect(await command(['post', '--file', path])).toBe(0);
  expect(await command(['post', '--file', '-'])).toBe(0);
  expect(await command(['read'])).toBe(0);
  expect(output().entries.map((entry: { text: string }) => entry.text)).toEqual(['stdin message', 'file message']);
});
