import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdOwnerPair } from '../src/cli/owner-pair.js';
import { checkOwnerPair, type PairDeps } from '../src/core/comms/owner-pair.js';

vi.mock('../src/core/comms/owner-pair.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/core/comms/owner-pair.js')>(),
  checkOwnerPair: vi.fn(),
}));

const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); vi.resetAllMocks(); });

it.each([true, false])('reports bound confirmation %s in JSON and human modes with the matching exit code', async confirmed => {
  const dir = mkdtempSync(join(tmpdir(), 'pair-confirm-exit-'));
  roots.push(dir);
  const reason = 'confirmation dependency unavailable';
  vi.mocked(checkOwnerPair).mockResolvedValue(confirmed
    ? { status: 'bound', confirmed: true }
    : { status: 'bound', confirmed: false, reason });
  const pair: PairDeps = { configDir: dir, bridge: {
    ownHandles: async () => [], baseline: async () => 0, send: async () => false, replies: async () => [],
  } };
  for (const json of [true, false]) {
    let output = '';
    const code = await cmdOwnerPair(['pair', 'imessage', ...(json ? ['--json'] : [])],
      { pair, output: text => { output = text; } });
    expect(code).toBe(confirmed ? 0 : 1);
    if (json) expect(JSON.parse(output)).toEqual({ schema: 'owner-pair.v1', status: 'paired', confirmed,
      ...(confirmed ? {} : { reason }) });
    else expect(output).toBe(confirmed ? 'Paired. Fleet updates will come here.' : `Paired. Not confirmed yet: ${reason}`);
  }
});
