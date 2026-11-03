import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetAppsRecoveryBatch } from '../src/cli/fleet-apps-recovery-batch.js';
import { appendBusInbox, listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';

const A = '12345678-1234-4123-8123-123456789abc';
const B = '22345678-1234-4123-8123-123456789abc';
const roots: string[] = [];
const root = () => { const r = mkdtempSync(join(tmpdir(), 'batch-bus-')); roots.push(r); return r; };
const args = (r: string, extra: string[] = []) => ['--root', r, '--invocation', A, '--max-age-ms', '10000', '--duration-ms', '3000', '--interval-ms', '1000', ...extra];
const messages = (r: string) => {
  const page = listBusInboxAfter(0, 100, { root: r });
  expect(page.status).toBe('ok');
  return page.status === 'ok' ? page.messages.map(m => m.envelope) : [];
};
function fixture(r: string) {
  expect(appendBusInbox({ id: 'fake-observation', from: 'apps-watch', to: 'leaders', priority: 'P2', ttl: 86400000,
    body: { kind: 'apps-watch.observation.v1', invocationId: A, cycle: 1, healthy: true, recoveries: 0,
      consecutiveFailures: 0, totalFailedCycles: 0, observedState: [{ app: 'Phantom', observedRunning: true }] } }, { root: r }).status).toBe('posted');
}
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); vi.restoreAllMocks(); });

it('publishes actual retained healthy evidence and a final summary in the selected inbox', async () => {
  const r = root(), other = root(); fixture(r);
  const lines: string[] = [];
  expect(await cmdFleetAppsRecoveryBatch(args(r, ['--bus']), { emit: s => lines.push(s) })).toBe(0);
  const rows = messages(r).slice(1);
  expect(rows).toHaveLength(2);
  expect(rows.map(e => (e.body as any).kind)).toEqual(['apps-recovery-batch.progress.v1', 'apps-recovery-batch.summary.v1']);
  expect(rows[0]).toMatchObject({ from: 'apps-recovery-batch', to: 'leaders', body: { invocationIds: [A], evidence: 'retained', liveProbe: false, verdicts: [{ verdict: 'healthy', latestCursor: 1 }] } });
  expect((rows[0]!.body as any).batchRunId).toBe((rows[1]!.body as any).batchRunId);
  expect(JSON.parse(lines[0]!)).toMatchObject({ outcome: 'healthy', bus: { published: 2, failed: 0 } });
  expect(messages(other)).toHaveLength(0);
  expect(JSON.stringify(rows)).not.toContain('Phantom');
});

it('coalesces unchanged states and publishes cursor changes without stream', async () => {
  const r = root(); fixture(r); let t = 0, reads = 0;
  const { readAppsRecoveryInvocations } = await import('../src/core/fleet/apps-recovery-invocations.js');
  const projection = readAppsRecoveryInvocations(r);
  const lines: string[] = [];
  const code = await cmdFleetAppsRecoveryBatch(args(r, ['--bus', '--invocation', B]), {
    now: () => t, wallNow: () => Date.now(), sleep: async ms => { t += ms; }, emit: s => lines.push(s),
    reader: () => { reads++; return { ...projection, invocations: projection.invocations.map(v => ({ ...v, latestCursor: reads >= 3 ? 2 : 1 })) }; },
  });
  expect(code).toBe(1); expect(lines).toHaveLength(1);
  const rows = messages(r).slice(1);
  expect(rows).toHaveLength(3);
  expect(rows.map(e => (e.body as any).kind)).toEqual(['apps-recovery-batch.progress.v1', 'apps-recovery-batch.progress.v1', 'apps-recovery-batch.summary.v1']);
  expect((rows[2]!.body as any).outcome).toBe('timeout');
});

it('sends a cancellation summary, and performs no default or invalid writes', async () => {
  const r = root(), controller = new AbortController(); controller.abort();
  expect(await cmdFleetAppsRecoveryBatch(args(r, ['--bus']), { signal: controller.signal, emit: () => {} })).toBe(1);
  expect(messages(r).map(e => (e.body as any).outcome)).toEqual(['cancelled']);
  const empty = root(); fixture(empty);
  expect(await cmdFleetAppsRecoveryBatch(args(empty), { emit: () => {} })).toBe(0);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(await cmdFleetAppsRecoveryBatch(args(empty, ['--bus', '--bus']), { emit: () => {} })).toBe(2);
  expect(messages(empty)).toHaveLength(1);
});

it('counts publication failures without changing the healthy exit status', async () => {
  const r = root(); fixture(r); let output = '';
  const code = await cmdFleetAppsRecoveryBatch(args(r, ['--bus']), {
    appendBus: () => { throw new Error('sensitive text'); }, emit: s => { output = s; },
  });
  expect(code).toBe(0);
  expect(JSON.parse(output)).toMatchObject({ outcome: 'healthy', bus: { published: 0, failed: 2 } });
  expect(output).not.toContain('sensitive');
  expect(messages(r)).toHaveLength(1);
});
