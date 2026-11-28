import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdOwnerPair } from '../src/cli/owner-pair.js';
import { ensureOwnerAdaptersFile } from '../src/core/comms/owner-adapters-file.js';
import { loadOwnerThreadSettings } from '../src/core/comms/owner-channel.js';
import { type PairBridge, type PairInbound } from '../src/core/comms/owner-pair.js';

vi.setConfig({ testTimeout: 30_000 });
const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'pair-explicit-'));
  roots.push(dir);
  ensureOwnerAdaptersFile(dir);
  writeFileSync(join(dir, 'comms.toml'), 'confirmedByMason = false\n');
  const sent: string[] = [];
  const inbound: PairInbound[] = [];
  let readable = true;
  const bridge: PairBridge = {
    async ownHandles() { return ['mason@example.test', 'other@example.test']; },
    async baseline() { return 10; },
    async send(handle) { sent.push(handle); return true; },
    async replies(after, handles) {
      return readable ? inbound.filter(m => m.rowid > after && handles.some(h => h.toLowerCase() === m.handle.toLowerCase())) : null;
    },
  };
  const run = async (handle?: string) => {
    let output = '';
    const args = ['pair', 'imessage', ...(handle === undefined ? [] : ['--handle', handle]), '--json'];
    const code = await cmdOwnerPair(args, { pair: { configDir: dir, bridge }, output: text => { output = text; } });
    return { code, result: JSON.parse(output) };
  };
  return { dir, sent, inbound, run, unreadable: () => { readable = false; } };
}

it('confirms the same explicit handle after YES, including case and whitespace differences', async () => {
  const s = setup();
  expect((await s.run('mason@example.test')).result.status).toBe('pending');
  s.inbound.push({ rowid: 11, handle: 'MASON@example.test', text: 'YES' });
  expect(await s.run('  MASON@example.test  ')).toMatchObject({ code: 0, result: { status: 'paired', confirmed: true } });
  expect(loadOwnerThreadSettings(s.dir).owners.imessage).toBe('mason@example.test');
  expect(readFileSync(join(s.dir, 'comms.toml'), 'utf8')).toContain('confirmedByMason = true');
  expect(s.sent).toEqual(['mason@example.test']);
});

it('stays pending without resending when no YES is available', async () => {
  const s = setup();
  await s.run('mason@example.test');
  expect(await s.run('mason@example.test')).toMatchObject({ code: 0, result: { status: 'already-pending' } });
  expect(s.sent).toEqual(['mason@example.test']);
});

it('retargets without consuming a YES for a different pending destination', async () => {
  const s = setup();
  await s.run('mason@example.test');
  s.inbound.push({ rowid: 11, handle: 'mason@example.test', text: 'YES' });
  expect(await s.run('other@example.test')).toMatchObject({ code: 0, result: { status: 'pending' } });
  expect(loadOwnerThreadSettings(s.dir).owners.imessage).toBeUndefined();
  expect(s.sent).toEqual(['mason@example.test', 'other@example.test']);
});

it('reports unreadable replies for a matching retry', async () => {
  const s = setup();
  await s.run('mason@example.test');
  s.unreadable();
  expect(await s.run('mason@example.test')).toMatchObject({ code: 1, result: { status: 'messages-unreadable' } });
  expect(s.sent).toHaveLength(1);
});

it('does not bind a different handle from a multi-destination invitation', async () => {
  const s = setup();
  await s.run();
  s.inbound.push({ rowid: 11, handle: 'other@example.test', text: 'YES' });
  expect(await s.run('mason@example.test')).toMatchObject({ code: 0, result: { status: 'already-pending' } });
  expect(loadOwnerThreadSettings(s.dir).owners.imessage).toBeUndefined();
});
