import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { cmdFleetOwnerLive } from '../src/cli/fleet-owner-live.js';
import { emptyOwnerSettings } from '../src/core/comms/owner-channel.js';
import type { PairBridge } from '../src/core/comms/owner-pair.js';
import type { OwnerThreadOptions } from '../src/core/comms/owner-thread.js';

const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });

function fixture(reject = false) {
  const dir = mkdtempSync(join(tmpdir(), 'owner-live-pair-'));
  roots.push(dir);
  let calls = 0;
  const bridge: PairBridge = {
    async ownHandles() { calls++; if (reject) throw new Error('private failure'); return ['fake@example.com']; },
    async baseline() { return 0; },
    async send() { return true; },
    async replies() { return []; },
  };
  const options: OwnerThreadOptions = {
    runsDir: dir, settings: { ...emptyOwnerSettings(), imessageBridge: 'loopback' },
    now: () => 1_700_000_000_000,
    transports: { imessage: { async pull() { return []; }, async deliver() { throw new Error('unexpected delivery'); } } },
  };
  const out: string[] = [];
  const run = (args: string[]) => cmdFleetOwnerLive(args, { options, pair: { configDir: dir, bridge, now: options.now }, output: text => out.push(text) });
  return { options, out, run, calls: () => calls };
}

it('reports a rejected tick in JSON and human output without exposing the exception', async () => {
  const f = fixture(true);
  expect(await f.run(['--apply', '--json'])).toBe(1);
  const report = JSON.parse(f.out.pop()!);
  expect(report).toMatchObject({ pair: { action: 'none', detail: 'pairing check failed' }, pairingFailed: true, ownerReply: expect.any(Object), failed: expect.any(Array) });
  expect(report).toHaveProperty('planned');
  expect(await f.run(['--apply'])).toBe(1);
  expect(f.out.join('\n')).toContain('imessage pairing: pairing check failed');
  expect(f.out.join('\n')).not.toContain('private failure');
});

it('keeps normal pairing and waiting successful', async () => {
  const f = fixture();
  expect(await f.run(['--apply', '--json'])).toBe(0);
  expect(JSON.parse(f.out.pop()!).pair.action).toBe('started');
  expect(await f.run(['--apply', '--json'])).toBe(0);
  expect(JSON.parse(f.out.pop()!).pair.action).toBe('waiting');
});

it('does not invoke pairing on dry-run, held, or disabled passes', async () => {
  const f = fixture(true);
  expect(await f.run(['--json'])).toBe(0);
  f.options.halted = true;
  expect(await f.run(['--apply', '--json'])).toBe(0);
  f.options.halted = false;
  f.options.settings.imessageBridge = 'off';
  expect(await f.run(['--apply', '--json'])).toBe(0);
  expect(f.calls()).toBe(0);
});
