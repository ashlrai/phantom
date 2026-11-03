import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as batch from '../src/cli/fleet-apps-recovery-batch.js';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import { callNativeTool, listNativeTools, nativeToolSafety } from '../src/core/mcp-native.js';

const name = 'phantom_fleet_apps_recovery_batch';
const a = 'abcdef12-1234-4123-8123-123456789abc';
const b = '22345678-1234-4123-8123-123456789abc';
const args = { invocationIds: [a, b], maxAgeMs: 1000, durationMs: 500, intervalMs: 100 };
const parse = (result: Awaited<ReturnType<typeof callNativeTool>>) => JSON.parse(result.content[0]!.text);
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('native recovery batch', () => {
  it('advertises a closed read schema', () => {
    expect(nativeToolSafety(name)).toBe('read');
    const schema = listNativeTools().find(tool => tool.name === name)!.inputSchema as Record<string, unknown>;
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(['invocationIds', 'maxAgeMs', 'durationMs']);
    expect(schema.properties).toMatchObject({ invocationIds: { minItems: 1, maxItems: 20, uniqueItems: true }, maxAgeMs: { maximum: Number.MAX_SAFE_INTEGER }, durationMs: { maximum: 300000 }, intervalMs: { minimum: 100, maximum: 60000 } });
  });
  it('rejects invalid input before calling the waiter', async () => {
    const waiter = vi.spyOn(batch, 'cmdFleetAppsRecoveryBatch');
    for (const invalid of [null, {}, { ...args, invocationIds: [a, a.toUpperCase()] }, { ...args, invocationIds: ['bad'] },
      { ...args, invocationIds: [] }, { ...args, invocationIds: Array(21).fill(a) }, { ...args, root: '/tmp' },
      { ...args, stopFile: '/tmp/x' }, { ...args, maxAgeMs: Number.MAX_SAFE_INTEGER + 1 },
      { ...args, durationMs: 0 }, { ...args, intervalMs: 99 }, { ...args, intervalMs: null }]) {
      expect((await callNativeTool(name, invalid)).isError).toBe(true);
    }
    expect(waiter).not.toHaveBeenCalled();
  });
  it.each(['healthy', 'terminal', 'timeout', 'unavailable'])('returns the %s outcome and retained verdicts', async outcome => {
    vi.stubEnv('ASHLR_RUNS_DIR', '/fake/runs');
    const payload = { v: 1, evidence: 'retained', liveProbe: false, invocationIds: [a, b], outcome, elapsedMs: 1, verdicts: [{ invocationId: a, verdict: 'terminal' }] };
    const waiter = vi.spyOn(batch, 'cmdFleetAppsRecoveryBatch').mockImplementation(async (_args, deps) => {
      deps!.emit!(JSON.stringify(payload)); return outcome === 'healthy' ? 0 : 1;
    });
    const result = await callNativeTool(name, args);
    expect(result.isError ?? false).toBe(outcome !== 'healthy');
    expect(parse(result)).toEqual(payload);
    expect(waiter).toHaveBeenCalledTimes(1);
    expect(waiter.mock.calls[0]![0]).toEqual(['--root', '/fake/runs', '--json', '--max-age-ms', '1000', '--duration-ms', '500', '--interval-ms', '100', '--invocation', a, '--invocation', b]);
  });
  it('does not expose exceptions or command chatter', async () => {
    vi.spyOn(batch, 'cmdFleetAppsRecoveryBatch').mockImplementation(async (_args, deps) => { deps!.emit!('private chatter'); throw new Error('private exception'); });
    const result = await callNativeTool(name, args);
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).not.toMatch(/private/);
  });
  it('reads terminal evidence through the real waiter in an isolated root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'recovery-batch-'));
    vi.stubEnv('ASHLR_RUNS_DIR', root);
    try {
      expect(appendBusInbox({ id: 'fake-1', from: 'apps-watch', to: 'leaders', priority: 'P2', ttl: 86400000,
        body: { kind: 'apps-watch.summary.v1', invocationId: a, apps: ['Phantom'], outcome: 'failed', cycles: 1,
          recoveries: 0, consecutiveFailures: 1, totalFailedCycles: 1, lastObservedState: null, lastDiagnostics: null } }, { root }).status).toBe('posted');
      const result = await callNativeTool(name, args);
      expect(result.isError).toBe(true);
      expect(parse(result)).toMatchObject({ evidence: 'retained', liveProbe: false, outcome: 'terminal', verdicts: [{ invocationId: a, verdict: 'terminal', terminalOutcome: 'failed' }, { invocationId: b, verdict: 'unknown' }] });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
