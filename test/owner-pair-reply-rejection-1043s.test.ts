import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { loadOwnerThreadSettings } from '../src/core/comms/owner-channel.js';
import { checkOwnerPair, pairTick, startOwnerPair, type PairBridge } from '../src/core/comms/owner-pair.js';

it('preserves the invitation when reply reads reject and binds a subsequent YES', async () => {
  const configDir = mkdtempSync(join(tmpdir(), 'pair-rejection-'));
  try {
    const network = join(configDir, 'agent-network.toml');
    const comms = join(configDir, 'comms.toml');
    writeFileSync(network, '[mason]\nidentities = []\n[team]\nidentities = []\n');
    writeFileSync(comms, 'confirmedByMason = true\n');
    const sent: string[] = [];
    let readable = false;
    const bridge: PairBridge = {
      async ownHandles() { return ['fake-owner']; },
      async baseline() { return 42; },
      async send(handle) { sent.push(handle); return true; },
      async replies() {
        if (!readable) throw new Error('fake read failure');
        return [{ rowid: 43, text: 'YES', handle: 'fake-owner' }];
      },
    };
    const deps = { configDir, bridge, now: () => 1_800_000_000_000 };
    expect((await startOwnerPair(deps)).status).toBe('pending');
    const files = [join(configDir, 'comms', 'owner-pair.json'), network, comms];
    const before = files.map(file => readFileSync(file));
    expect(await checkOwnerPair(deps)).toEqual({ status: 'unreadable' });
    expect(files.map(file => readFileSync(file))).toEqual(before);
    expect(await pairTick(deps)).toEqual({ action: 'waiting', detail: 'Messages replies are unreadable; YES cannot currently be checked' });
    expect(files.map(file => readFileSync(file))).toEqual(before);
    expect(sent).toEqual(['fake-owner']);
    readable = true;
    expect(await checkOwnerPair(deps)).toEqual({ status: 'bound', confirmed: true });
    expect(loadOwnerThreadSettings(configDir).owners.imessage).toBe('fake-owner');
    expect(sent).toEqual(['fake-owner']);
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
});
