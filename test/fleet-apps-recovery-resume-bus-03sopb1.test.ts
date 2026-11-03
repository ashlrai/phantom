import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetAppsRecoveryBatch } from '../src/cli/fleet-apps-recovery-batch.js';
import { cmdFleetAppsRecoveryResume } from '../src/cli/fleet-apps-recovery-resume.js';
import { appendBusInbox, listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';

const A = '12345678-1234-4123-8123-123456789abc';
const dirs: string[] = [];
const dir = () => { const d = mkdtempSync(join(tmpdir(), 'resume-bus-')); dirs.push(d); return d; };
const flags = ['--max-age-ms', '10000', '--duration-ms', '3000', '--interval-ms', '1000'];
afterEach(() => { vi.restoreAllMocks(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const messages = (root: string) => {
  const page = listBusInboxAfter(0, 100, { root });
  expect(page.status).toBe('ok');
  return page.status === 'ok' ? page.messages.map(m => m.envelope) : [];
};
function fixture(root: string) {
  expect(appendBusInbox({ id: 'fake-observation', from: 'apps-watch', to: 'leaders', priority: 'P2', ttl: 86400000,
    body: { kind: 'apps-watch.observation.v1', invocationId: A, cycle: 1, healthy: true, recoveries: 0,
      consecutiveFailures: 0, totalFailedCycles: 0, observedState: [{ app: 'Phantom', observedRunning: true }] } }, { root }).status).toBe('posted');
}

it('forwards --bus exactly once in file, create and stdin modes, and omits it by default', async () => {
  const root = dir(), request = join(root, 'request.json'), calls: string[][] = [];
  const waiter: typeof cmdFleetAppsRecoveryBatch = async a => { calls.push(a); return 0; };
  expect(await cmdFleetAppsRecoveryResume(['--request', request, '--root', root, '--invocation', A, ...flags, '--bus'], { waiter })).toBe(0);
  expect(JSON.parse(readFileSync(request, 'utf8'))).toEqual({ version: 1, invocationIds: [A], root });
  expect(await cmdFleetAppsRecoveryResume(['--request', request, '--bus', ...flags], { waiter })).toBe(0);
  const { Readable } = await import('node:stream');
  const stdin = Readable.from([JSON.stringify({ version: 1, invocationIds: [A], root })]);
  expect(await cmdFleetAppsRecoveryResume(['--request', '-', ...flags, '--bus'], { waiter, stdin })).toBe(0);
  expect(await cmdFleetAppsRecoveryResume(['--request', request, ...flags], { waiter })).toBe(0);
  expect(calls.slice(0, 3).map(c => c.filter(x => x === '--bus').length)).toEqual([1, 1, 1]);
  expect(calls[3]).not.toContain('--bus');
});

it('rejects a repeated --bus before calling the waiter', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const waiter = vi.fn(async () => 0);
  expect(await cmdFleetAppsRecoveryResume(['--request', join(dir(), 'r.json'), '--invocation', A, ...flags, '--bus', '--bus'], { waiter })).toBe(2);
  expect(waiter).not.toHaveBeenCalled();
});

it('publishes progress and summary through the real waiter and keeps default resume read-only', async () => {
  const root = dir(), request = join(root, 'request.json'), lines: string[] = [];
  fixture(root);
  const waiter: typeof cmdFleetAppsRecoveryBatch = a => cmdFleetAppsRecoveryBatch(a, { emit: s => lines.push(s) });
  const base = ['--request', request, '--root', root, '--invocation', A, ...flags];
  expect(await cmdFleetAppsRecoveryResume(base, { waiter })).toBe(0);
  expect(messages(root)).toHaveLength(1);
  expect(await cmdFleetAppsRecoveryResume(['--request', request, ...flags, '--bus', '--stream'], { waiter })).toBe(0);
  const rows = messages(root).slice(1);
  expect(rows.map(e => (e.body as any).kind)).toEqual(['apps-recovery-batch.progress.v1', 'apps-recovery-batch.summary.v1']);
  expect(rows[0]!.body).toMatchObject({ invocationIds: [A], evidence: 'retained', liveProbe: false, verdicts: [{ verdict: 'healthy' }] });
  expect(rows[1]!.body).toMatchObject({ invocationIds: [A], outcome: 'healthy' });
  expect(JSON.parse(lines.at(-1)!)).toMatchObject({ type: 'summary', outcome: 'healthy', bus: { published: 2, failed: 0 } });
  expect(JSON.stringify(rows)).not.toContain('Phantom');
});
