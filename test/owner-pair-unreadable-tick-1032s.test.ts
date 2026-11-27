import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { pairTick, startOwnerPair, type PairBridge } from '../src/core/comms/owner-pair.js';

it('reports unreadable Messages and resumes waiting without sending again', async () => {
  const configDir = mkdtempSync(join(tmpdir(), 'pair-unreadable-'));
  try {
    const sent: string[] = [];
    let readable = false;
    const bridge: PairBridge = {
      async ownHandles() { return ['synthetic-a', 'synthetic-b']; },
      async baseline() { return 42; },
      async send(handle) { sent.push(handle); return true; },
      async replies() { return readable ? [] : null; },
    };
    const deps = { configDir, bridge, now: () => 1_800_000_000_000 };
    expect((await startOwnerPair(deps)).status).toBe('pending');
    const stateFile = join(configDir, 'comms', 'owner-pair.json');
    const before = readFileSync(stateFile, 'utf8');
    expect(JSON.parse(before)).toEqual({
      pending: { handles: ['synthetic-a', 'synthetic-b'], startedAt: deps.now(), expiresAt: deps.now() + 86_400_000, afterRowId: 42 },
      lastStartAt: deps.now(), autoOff: false,
    });
    expect(await pairTick(deps)).toEqual({ action: 'waiting', detail: 'Messages replies are unreadable; YES cannot currently be checked' });
    expect(readFileSync(stateFile, 'utf8')).toBe(before);
    expect(sent).toEqual(['synthetic-a', 'synthetic-b']);
    readable = true;
    expect(await pairTick(deps)).toEqual({ action: 'waiting', detail: 'sent to 2 handles, waiting for YES' });
    expect(readFileSync(stateFile, 'utf8')).toBe(before);
    expect(sent).toEqual(['synthetic-a', 'synthetic-b']);
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
});
