import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetAppsRecoveryResume } from '../src/cli/fleet-apps-recovery-resume.js';
import { cmdFleetAppsRecoveryBatch } from '../src/cli/fleet-apps-recovery-batch.js';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';

const A = '12345678-1234-4123-8123-123456789abc';
const B = '22345678-1234-4123-8123-123456789abc';
const dirs: string[] = [];
const dir = () => { const d = mkdtempSync(join(tmpdir(), 'resume-')); dirs.push(d); return d; };
const flags = ['--max-age-ms', '1000', '--duration-ms', '10'];
afterEach(() => { vi.restoreAllMocks(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function append(root: string, body: unknown) {
  expect(appendBusInbox({ id: 'fake-event', from: 'apps-watch', to: 'leaders', priority: 'P2', ttl: 86400000, body }, { root }).status).toBe('posted');
}
const observation = { kind: 'apps-watch.observation.v1', invocationId: A, cycle: 1, healthy: true, recoveries: 0, consecutiveFailures: 0, totalFailedCycles: 0, observedState: [{ app: 'Phantom', observedRunning: true }] };

it('creates a private request then resumes against retained evidence and rechecks freshness', async () => {
  const root = dir(), request = join(root, 'request.json'), lines: string[] = [];
  append(root, observation);
  let wall = Date.now(), t = 0;
  const waiter: typeof cmdFleetAppsRecoveryBatch = args => cmdFleetAppsRecoveryBatch(args, { wallNow: () => wall, now: () => t, sleep: async ms => { t += ms; }, emit: line => lines.push(line) });
  const first = ['--request', request, '--root', root, '--invocation', A.toUpperCase(), ...flags];
  expect(await cmdFleetAppsRecoveryResume(first, { waiter })).toBe(0);
  const saved = readFileSync(request, 'utf8');
  expect(JSON.parse(saved)).toEqual({ version: 1, invocationIds: [A], root });
  expect(statSync(request).mode & 0o777).toBe(0o600);
  wall += 2000; t = 0;
  expect(await cmdFleetAppsRecoveryResume(['--request', request, ...flags], { waiter })).toBe(1);
  expect(JSON.parse(lines.at(-1)!).verdicts[0].verdict).toBe('stale');
  expect(readFileSync(request, 'utf8')).toBe(saved);
  expect((await FLEET_SUBCOMMAND_LOADERS['apps-recovery-resume']!()).cmdFleetAppsRecoveryResume).toBe(cmdFleetAppsRecoveryResume);
});

it('passes terminal, wait-all, stream and stop/cancellation to the real waiter', async () => {
  const root = dir(), request = join(root, 'request'), lines: string[] = [];
  append(root, { kind: 'apps-watch.summary.v1', invocationId: A, apps: ['Phantom'], outcome: 'failed', cycles: 1, recoveries: 0, consecutiveFailures: 1, totalFailedCycles: 1, lastObservedState: null, lastDiagnostics: null });
  let t = 0;
  const controller = new AbortController();
  const waiter: typeof cmdFleetAppsRecoveryBatch = args => cmdFleetAppsRecoveryBatch(args, { now: () => t, sleep: async ms => { t += ms; }, signal: controller.signal, emit: line => lines.push(line) });
  const base = ['--request', request, ...flags, '--stream'];
  expect(await cmdFleetAppsRecoveryResume([...base, '--root', root, '--invocation', A, '--invocation', B], { waiter })).toBe(1);
  expect(JSON.parse(lines.at(-1)!).outcome).toBe('terminal');
  expect(JSON.parse(lines[0]!).type).toBe('progress');
  t = 0; lines.length = 0;
  expect(await cmdFleetAppsRecoveryResume([...base, '--wait-all'], { waiter })).toBe(1);
  expect(JSON.parse(lines.at(-1)!)).toMatchObject({ type: 'summary', outcome: 'timeout', waitAll: true });
  const stop = join(root, 'stop'); writeFileSync(stop, ''); t = 0;
  expect(await cmdFleetAppsRecoveryResume([...base, '--stop-file', stop], { waiter })).toBe(1);
  expect(JSON.parse(lines.at(-1)!).outcome).toBe('stopped');
  controller.abort(); t = 0;
  expect(await cmdFleetAppsRecoveryResume(base, { waiter })).toBe(1);
  expect(JSON.parse(lines.at(-1)!).outcome).toBe('cancelled');
});

it('rejects invalid arguments, conflicting roots and existing files without calling the waiter', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const root = dir(), request = join(root, 'request'), waiter = vi.fn(async () => 0);
  for (const extra of [['--invocation', 'bad'], ['--invocation', A, '--invocation', A.toUpperCase()], ['--invocation', A, '--interval-ms', '1'], ['--invocation', A, '--unknown']]) {
    expect(await cmdFleetAppsRecoveryResume(['--request', request, ...flags, ...extra], { waiter })).not.toBe(0);
    expect(() => statSync(request)).toThrow();
  }
  writeFileSync(request, 'malformed');
  expect(await cmdFleetAppsRecoveryResume(['--request', request, '--invocation', A, ...flags], { waiter })).toBe(1);
  expect(readFileSync(request, 'utf8')).toBe('malformed');
  writeFileSync(request, JSON.stringify({ version: 1, invocationIds: [A], root }));
  expect(await cmdFleetAppsRecoveryResume(['--request', request, '--root', join(root, 'other'), ...flags], { waiter })).not.toBe(0);
  expect(waiter).not.toHaveBeenCalled();
});

it('rejects oversized, malformed, extra-field, noncanonical and duplicate requests', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const root = dir(), request = join(root, 'request'), waiter = vi.fn(async () => 0);
  for (const value of ['x'.repeat(16385), '{', JSON.stringify({ version: 2, invocationIds: [A], root }), JSON.stringify({ version: 1, invocationIds: [A], root, healthy: true }), JSON.stringify({ version: 1, invocationIds: [A, A.toUpperCase()], root }), JSON.stringify({ version: 1, invocationIds: [], root }), JSON.stringify({ version: 1, invocationIds: [A], root: 'relative' })]) {
    writeFileSync(request, value);
    expect(await cmdFleetAppsRecoveryResume(['--request', request, ...flags], { waiter })).toBe(1);
  }
  expect(waiter).not.toHaveBeenCalled();
});
