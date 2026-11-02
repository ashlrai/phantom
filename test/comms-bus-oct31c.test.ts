import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
vi.mock('../src/core/config.js', () => ({ loadConfig: vi.fn(() => { throw Error('must not load'); }) }));
vi.mock('../src/core/comms/dispatch.js', () => ({ runCommsCycle: vi.fn(() => { throw Error('must not deliver'); }) }));
import { loadConfig } from '../src/core/config.js';
import { runCommsCycle } from '../src/core/comms/dispatch.js';
import * as telegram from '../src/core/integrations/telegram.js';
import { cmdComms } from '../src/cli/comms.js';
import { cmdCommsBus } from '../src/cli/comms-bus.js';
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
it('round trips JSON with no body in post result and no store creation on empty read', async () => {
  const root = mkdtempSync(join(tmpdir(), 'comms-bus-')); roots.push(root);
  const options = { root, now: () => 100 }, log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdCommsBus(['read'], options)).toBe(0);
  expect(existsSync(join(root, 'bus-inbox'))).toBe(false);
  const file = join(root, 'fake.json');
  writeFileSync(file, JSON.stringify({ id: 'fake', from: 'a', to: 'b', priority: 'P1', ttl: 100, body: 'fake untrusted body' }), { mode: 0o600 });
  expect(await cmdCommsBus(['post', '--file', file], options)).toBe(0);
  expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toEqual({ status: 'posted', id: 'fake', cursor: 1 });
  expect(await cmdCommsBus(['read', '--limit', '1'], options)).toBe(0);
  expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({ nextCursor: 1, messages: [{ envelope: { body: 'fake untrusted body' } }] });
}, 60_000);
it('delegates help and invalid flags without config or delivery', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const send = vi.spyOn(telegram, 'sendTelegramMessage');
  const poll = vi.spyOn(telegram, 'pollTelegramUpdates');
  expect(await cmdComms(['bus', '--help'])).toBe(0);
  for (const args of [['post', '--file', 'fake', '--oops'], ['read', '--limit', '0'], ['read', '--after', '1e3'], ['read', 'extra'], ['read', '--limit', '1', '--limit', '2']]) {
    expect(await cmdComms(['bus', ...args])).toBe(2);
  }
  expect(loadConfig).not.toHaveBeenCalled(); expect(runCommsCycle).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled(); expect(poll).not.toHaveBeenCalled();
}, 60_000);
