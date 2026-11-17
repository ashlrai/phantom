import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { cmdFleetPeerLedger } from '../src/cli/fleet-peer-ledger.js';
import { useAccountHomeForTest, useProcessHomeForTest } from '../src/core/real-home.js';

it('reads fresh private ledger evidence through the production CLI across failures and repair', async () => {
  const home = mkdtempSync(join(tmpdir(), 'peer-reconnect-'));
  const previousHome = process.env.HOME;
  const file = join(home, '.ashlr', 'fleet', 'agentnet', 'coordination.json');
  let stdout = '', stderr = '';
  try {
    process.env.HOME = home;
    useProcessHomeForTest();
    vi.spyOn(process.stdout, 'write').mockImplementation((s: string | Uint8Array) => { stdout += String(s); return true; });
    vi.spyOn(process.stderr, 'write').mockImplementation((s: string | Uint8Array) => { stderr += String(s); return true; });
    const run = async (json = true) => {
      stdout = ''; stderr = '';
      const code = await cmdFleetPeerLedger(json ? ['--json'] : []);
      expect(stderr).toBe('');
      return { code, text: stdout, report: json ? JSON.parse(stdout) : undefined };
    };
    expect(await run()).toMatchObject({ code: 0, report: { status: 'empty', liveRows: 0, pairs: [] } });
    mkdirSync(join(home, '.ashlr', 'fleet', 'agentnet'), { recursive: true, mode: 0o700 });
    const row = (target: string) => ({ id: 'peer-123e4567-e89b-12d3-a456-426614174000', fromAgent: 'agent0', target,
      origin: 'peer-123e4567-e89b-12d3-a456-426614174000', digest: 'a'.repeat(64), hopCount: 1,
      threadId: 'fixture-private-thread', at: Date.now() - 1000 });
    writeFileSync(file, JSON.stringify([row('agent1')]), { mode: 0o600 });
    expect(await run()).toMatchObject({ code: 0, report: { status: 'ok', liveRows: 1,
      pairs: [{ fromAgent: 'agent0', target: 'agent1', inWindow: 1, remaining: 5 }] } });
    writeFileSync(file, 'fixture-private-malformed');
    const malformed = await run();
    expect(malformed).toMatchObject({ code: 1, report: { status: 'unavailable' } });
    expect(malformed.text).not.toContain('fixture-private');
    const human = await run(false);
    expect(human.code).toBe(1);
    expect(human.text).toContain('peer ledger: unavailable');
    expect(human.text).not.toContain('fixture-private');
    writeFileSync(file, JSON.stringify([row('agent2')]));
    chmodSync(file, 0o644);
    const insecure = await run();
    expect(insecure).toMatchObject({ code: 1, report: { status: 'unavailable' } });
    expect(insecure.text).not.toContain('fixture-private');
    chmodSync(file, 0o600);
    const recovered = await run();
    expect(recovered).toMatchObject({ code: 0, report: { status: 'ok', liveRows: 1,
      pairs: [{ fromAgent: 'agent0', target: 'agent2', inWindow: 1, remaining: 5 }] } });
    expect(recovered.text).not.toContain('agent1');
    expect(recovered.text).not.toContain('fixture-private');
  } finally {
    vi.restoreAllMocks();
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    useAccountHomeForTest();
    rmSync(home, { recursive: true, force: true });
  }
});
