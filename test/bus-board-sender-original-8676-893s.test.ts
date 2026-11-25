import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { cmdFleetBus } from '../src/cli/fleet-bus.js';
import type { AshlrConfig } from '../src/core/types.js';

it('filters real thread delivery reads by sender without changing receipts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'board-sender-'));
  try {
    async function call(args: string[], peer = 'alice') {
      const output: string[] = [];
      const code = await cmdFleetBus([...args, '--peer', peer, '--root', join(dir, 'board'),
        '--queue-root', join(dir, 'queue')], { loadConfig: () => ({}) as AshlrConfig, out: (line) => output.push(line) });
      return { code, value: JSON.parse(output[0]!) };
    }
    const thread = (await call(['thread', 'create', 'Fake thread'])).value.result.id as string;
    for (const peer of ['bob', 'carol']) expect((await call(['thread', 'join', thread], peer)).code).toBe(0);
    for (const [peer, body] of [['alice', 'first needle'], ['bob', 'second needle'], ['carol', 'third other']]) {
      expect((await call(['thread', 'post', thread, body!], peer)).code).toBe(0);
    }
    const all = (await call(['thread', 'read', thread], 'bob')).value.result;
    expect(all).toHaveLength(3);
    expect((await call(['thread', 'ack', thread, all[0].id], 'bob')).code).toBe(0);
    const receipts = (await call(['thread', 'receipts', thread], 'bob')).value.result;
    for (const verb of ['read', 'pending', 'hops']) {
      const get = async (...flags: string[]) => (await call(['thread', verb, thread, ...flags], 'bob')).value.result;
      expect((await get('--from', 'bob')).map((row: { sender: string }) => row.sender)).toEqual(['bob']);
      expect((await get('--exclude-from', 'bob')).map((row: { sender: string }) => row.sender))
        .toEqual(verb === 'pending' ? ['carol'] : ['alice', 'carol']);
      expect(await get('--from', 'bob', '--exclude-from', 'bob')).toEqual([]);
      expect(await get('--from', 'nobody')).toEqual([]);
      expect(await get('--exclude-from', 'nobody')).toHaveLength(verb === 'pending' ? 2 : 3);
      expect(await get('--from', 'bob', '--contains', 'needle', '--since', '0', '--before', '9999999999999')).toHaveLength(1);
      expect(await get('--from', 'bob', '--before', '0')).toEqual([]);
    }
    expect((await call(['thread', 'receipts', thread], 'bob')).value.result).toEqual(receipts);
    for (const args of [
      ['thread', 'read', thread, '--from'], ['thread', 'read', thread, '--from', 'bad peer'],
      ['thread', 'read', thread, '--from', 'bob', '--from', 'alice'],
      ['thread', 'read', thread, '--exclude-from', '--json'],
      ['thread', 'list', '--from', 'bob'], ['thread', 'receipts', thread, '--exclude-from', 'bob'],
      ['thread', 'post', thread, 'x', '--from', 'bob'],
    ]) expect((await call(args)).code).toBe(2);
    expect((await call(['thread', 'read', thread, '--from', 'bob'], 'outsider')).code).toBe(1);

    // board pending takes the same two flags as agent refs resolved through
    // the identity registry — absent here, so exact-label matching applies.
    // Bob's pending deliveries are his own post and carol's (alice's was
    // acked above), so --from carol keeps one, --from bob keeps the other,
    // and the excluded sender's posts drop.
    const pending = async (...flags: string[]) => (await call(['board', 'pending', ...flags], 'bob')).value.result;
    expect((await pending('--from', 'carol')).deliveries.items.map((row: { sender: string }) => row.sender)).toEqual(['carol']);
    expect((await pending('--from', 'bob')).deliveries.items.map((row: { sender: string }) => row.sender)).toEqual(['bob']);
    expect((await pending('--exclude-from', 'carol')).deliveries.items.map((row: { sender: string }) => row.sender)).toEqual(['bob']);
    expect((await pending('--exclude-from', 'alice')).deliveries.matched).toBe(2);
    expect((await pending('--from', 'carol', '--exclude-from', 'carol')).deliveries.matched).toBe(0);
    expect((await pending('--from', 'nobody')).deliveries.matched).toBe(0);
    // --all takes the same sender slice on the fleet-wide digest: carol's
    // one post reached all three members, and none of its deliveries was
    // acknowledged. --all cannot pair with --peer, so it goes through argv
    // directly.
    const fleetOutput: string[] = [];
    const fleetCode = await cmdFleetBus(['board', 'pending', '--all', '--from', 'carol',
      '--root', join(dir, 'board'), '--queue-root', join(dir, 'queue')],
      { loadConfig: () => ({}) as AshlrConfig, out: (line) => fleetOutput.push(line) });
    expect(fleetCode).toBe(0);
    const fleet = JSON.parse(fleetOutput[0]!).result;
    expect(fleet.deliveries.matched).toBe(3);
    expect(fleet.deliveries.items.every((row: { sender: string }) => row.sender === 'carol')).toBe(true);
    // Sender flags stay refused on the commands that cannot honor them.
    expect((await call(['board', 'pending', '--from'])).code).toBe(2);
    expect((await call(['board', 'pending', '--from', 'bad peer'])).code).toBe(2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
