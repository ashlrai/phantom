import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import type { GuardianVerifyExclusiveResult } from '../src/core/fleet/guardian-verify-exclusive.js';
import { cmdFleetGuardianBus } from '../src/cli/fleet-guardian-bus.js';
import { listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';

describe('guardian bus', () => {
  it('publishes ordered validated observations without private fields and preserves exit', async () => {
    const root = mkdtempSync(join(tmpdir(), 'guardian-bus-'));
    try {
      const lines: string[] = [];
      const args = ['--bus-from', 'guardian', '--bus-to', 'agents', '--bus-run-id', 'run-1', '--bus-runs-dir', root, '--apply'];
      const drain = async (_args: string[], deps: { writeLine?: (line: string) => void | Promise<void> }): Promise<number> => {
        for (const record of [
          { record: 'attempt', outcome: 'verified', repo: '/private/repo', refusal: 'secret error' },
          { record: 'attempt', outcome: 'refused', latestOutput: '/private/output' },
          { record: 'summary', termination: 'refused', attempts: 2, verified: 1, refused: 1, attempted: ['private'] },
        ]) await deps.writeLine!(JSON.stringify(record) + '\n');
        return 5;
      };
      expect(await cmdFleetGuardianBus(args, { drain, writeLine: line => { lines.push(line); } })).toBe(5);
      const page = listBusInboxAfter(0, 50, { root });
      expect(page.status).toBe('ok');
      if (page.status !== 'ok') throw new Error('inbox unavailable');
      expect(page.messages.map(m => (m.envelope.body as { record: string }).record)).toEqual(['attempt', 'attempt', 'summary']);
      expect(new Set(page.messages.map(m => m.envelope.id)).size).toBe(3);
      expect(JSON.stringify(page.messages)).not.toMatch(/private|secret/);
      expect(lines).toHaveLength(3);
      expect(await cmdFleetGuardianBus(args, { drain, writeLine: () => {} })).toBe(5);
      const again = listBusInboxAfter(0, 50, { root });
      expect(again.status === 'ok' && again.messages).toHaveLength(3);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('does not publish previews or start on invalid wrapper options', async () => {
    let calls = 0, appends = 0;
    const drain = async (_args: string[], deps: { writeLine?: (line: string) => void | Promise<void> }): Promise<number> => {
      calls++; await deps.writeLine!('{"record":"summary"}\n'); return 0;
    };
    const append = () => { appends++; return { status: 'full' as const }; };
    expect(await cmdFleetGuardianBus(['--bus-from', 'a', '--bus-to', 'b', '--bus-run-id', 'r'], { drain, append, writeLine: () => {} })).toBe(0);
    expect(appends).toBe(0);
    expect(await cmdFleetGuardianBus(['--bus-from', 'a', '--bus-from', 'b', '--bus-to', 'b', '--bus-run-id', 'r'], { drain })).toBe(2);
    expect(calls).toBe(1);
  });
  it('stops the real drain after a refused append', async () => {
    const root = mkdtempSync(join(tmpdir(), 'guardian-stop-'));
    try {
      const args = ['--bus-from', 'a', '--bus-to', 'b', '--bus-run-id', 'r', '--bus-runs-dir', root,
        '--manifest', join(root, 'manifest'), '--source-state', join(root, 'source'), '--output-dir', root,
        '--max-retries', '2', '--timeout-ms', '60000', '--apply'];
      const select = vi.fn(async () => ({ repo: join(root, 'fake'), sha: 'a'.repeat(40) }));
      const prepare = vi.fn(async () => undefined);
      const verify = vi.fn(async () => ({ state: 'ran', summary: { deadlineExceeded: false, cancelled: false } }) as GuardianVerifyExclusiveResult);
      const append = vi.fn(() => ({ status: 'full' as const }));
      const lines: string[] = [];
      expect(await cmdFleetGuardianBus(args, { select, prepare, verify, append, writeLine: line => { lines.push(line); } })).toBe(3);
      expect(verify).toHaveBeenCalledTimes(1);
      expect(append).toHaveBeenCalledTimes(1);
      expect(JSON.parse(lines[1]!).termination).toBe('observer-error');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

});
