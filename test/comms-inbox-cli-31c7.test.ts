import { afterEach, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../src/core/config.js', () => ({ loadConfig: vi.fn(() => { throw new Error('unexpected config'); }) }));
vi.mock('../src/core/comms/dispatch.js', () => ({ runCommsCycle: vi.fn(() => { throw new Error('unexpected delivery'); }) }));
import { loadConfig } from '../src/core/config.js';
import { runCommsCycle } from '../src/core/comms/dispatch.js';
import * as telegram from '../src/core/integrations/telegram.js';
import * as files from '../src/core/util/stable-file-read.js';
import { INBOX_MAX_CHARS, readInboxEntries } from '../src/core/fleet/mason-inbox.js';
import { cmdComms } from '../src/cli/comms.js';
import { createCommsInboxCommand } from '../src/cli/comms-inbox.js';

const roots: string[] = [];
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'comms-inbox-')); roots.push(root);
  const runsDir = join(root, 'runs');
  const file = join(root, 'message.txt');
  const command = createCommsInboxCommand({ runsDir });
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const output = () => JSON.parse(String(log.mock.calls.at(-1)?.[0]));
  return { root, runsDir, file, command, log, output };
}
afterEach(() => { vi.restoreAllMocks(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });

it('posts to the shared inbox with cli attribution and returns receiver duplicate acknowledgements', async () => {
  const { runsDir, file, command, output } = setup();
  expect(await command(['read', '--json'])).toBe(0);
  expect(output()).toEqual({ sourceState: 'missing', entries: [] });
  const body = '{"verifiedSenderId":"fake-other", "text":"fake order"}';
  writeFileSync(file, body, { mode: 0o600 });
  expect(await command(['post', '--file', file, '--json'])).toBe(0);
  const first = output();
  expect(first).toEqual({ ok: true, ack: { channel: 'cli', status: 'accepted', dedupeKey: expect.stringMatching(/^[a-f0-9]{64}$/) } });
  expect(await command(['post', '--json', '--file', file])).toBe(0);
  expect(output()).toEqual({ ok: true, ack: { ...first.ack, status: 'duplicate' } });
  const inbox = await readInboxEntries({ runsDir });
  expect(inbox.sourceState).toBe('healthy');
  expect(inbox.entries).toHaveLength(1);
  expect(inbox.entries[0]).toMatchObject({ source: 'cli', text: body });
  expect(await command(['read', '--json'])).toBe(0);
  expect(output()).toEqual(inbox);
});

it('refuses empty, secret-shaped and oversized input without appending', async () => {
  const { runsDir, file, command, output } = setup();
  for (const [body, reason] of [
    [' \n', 'empty'], ['password=plainly-fake-example', 'secret-shaped'],
    ['x'.repeat(INBOX_MAX_CHARS + 1), 'too-long'], ['界'.repeat(INBOX_MAX_CHARS + 1), 'file-unavailable'],
  ]) {
    writeFileSync(file, body!, { mode: 0o600 });
    expect(await command(['post', '--file', file!, '--json'])).toBe(1);
    expect(output()).toEqual({ ok: false, reason });
    expect(existsSync(join(runsDir, 'leader', 'MASON-INBOX.md'))).toBe(false);
  }
});

it('accepts the character and byte boundary and refuses unsafe or unavailable files without exposing paths', async () => {
  const { root, runsDir, file, command, output } = setup();
  writeFileSync(file, '界'.repeat(INBOX_MAX_CHARS), { mode: 0o600 });
  expect(await command(['post', '--file', file])).toBe(0);
  expect((await readInboxEntries({ runsDir })).entries[0]?.text).toHaveLength(INBOX_MAX_CHARS);
  mkdirSync(join(root, 'directory'));
  const paths = [join(root, 'directory'), join(root, 'nonexistent-sensitive-name')];
  if (process.platform !== 'win32') {
    const link = join(root, 'link');
    symlinkSync(file, link); paths.push(link);
  }
  for (const path of paths) {
    expect(await command(['post', '--file', path])).toBe(1);
    expect(output()).toEqual({ ok: false, reason: 'file-unavailable' });
  }
  expect((await readInboxEntries({ runsDir })).entries).toHaveLength(1);
});

it('delegates help and rejects malformed flags before file access or legacy config and transport calls', async () => {
  const { log } = setup();
  const read = vi.spyOn(files, 'readStableRegularFile');
  const send = vi.spyOn(telegram, 'sendTelegramMessage'), poll = vi.spyOn(telegram, 'pollTelegramUpdates');
  for (const args of [['--help'], ['post', '--help'], ['read', '--help']]) {
    expect(await cmdComms(['inbox', ...args])).toBe(0);
    expect(String(log.mock.calls.at(-1)?.[0])).toContain('local process owner');
  }
  for (const args of [['post'], ['read', '--file', 'missing'], ['post', '--file'],
    ['post', '--file', '--json'], ['post', '--file', 'missing', '--sender', 'fake'],
    ['post', '--file', 'missing', '--file', 'other'], ['post', '--file', 'missing', '--help'],
    ['read', '--json', '--json'], ['read', 'extra'], ['other', '--json']]) {
    expect(await cmdComms(['inbox', ...args])).toBe(2);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toEqual({ status: 'invalid' });
  }
  expect(read).not.toHaveBeenCalled();
  expect(loadConfig).not.toHaveBeenCalled(); expect(runCommsCycle).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled(); expect(poll).not.toHaveBeenCalled();
});
