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
      ['board', 'pending', '--from', 'bob'], ['thread', 'post', thread, 'x', '--from', 'bob'],
    ]) expect((await call(args)).code).toBe(2);
    expect((await call(['thread', 'read', thread, '--from', 'bob'], 'outsider')).code).toBe(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
