/**
 * RQ-PHX-MCPCLAIMIDENTITY465S — fleet_imessage_tasks queueBinding must prove
 * the same task identity the queue writer (syncQueue) reserves: the RESULT
 * acceptance token, claim owner, repo and scope — not merely a matching
 * id/owner/repo row. A replaced queue entry with identical id/owner/repo but
 * a different scope or acceptance is conflicting, an exact finished identity
 * stays historical finished, and missing/unreadable stores stay honest.
 *
 * Hermetic: temp runs roots, real enqueueTeammateTask + QueueStore, real
 * listTeammateTasks collector; no transport, daemon or provider calls.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig } from '../../src/core/config.js';
import { cancelTeammateTask, enqueueTeammateTask } from '../../src/core/comms/imessage-teammate-tasks.js';
import { QueueStore } from '../../src/core/queue/store.js';
import type { QueueJob } from '../../src/core/queue/schema.js';
import { readFleetImessageTasks } from '../../src/mcp/fleet-imessage-tasks.js';

let runsDir: string;
const cfg = defaultConfig();
const ledgerPath = () => join(runsDir, 'imessage', 'teammate-tasks.json');
const queue = () => new QueueStore(join(runsDir, 'queue'));
const snapshot = () => [readFileSync(ledgerPath(), 'utf8'), readFileSync(queue().path, 'utf8')];
const enqueue = (jobId: string, scope: string) => enqueueTeammateTask({
  jobId, peer: 'dot', kind: 'research', scope, repo: 'fixture/example',
  format: 'PRIVATE_FORMAT_465', deadline: '2099-01-01T00:00:00Z',
}, cfg, { runsDir, apply: true, approved: () => 'fake-peer-465' });
const read = (jobId?: string) => readFleetImessageTasks({ limit: 20, ...(jobId ? { jobId } : {}) }, { runsDir });
const row = (report: Awaited<ReturnType<typeof read>>, jobId: string) =>
  report.tasks?.find(task => task.jobId === jobId);
/** Public output must never carry scope, token, acceptance, private bodies or paths. */
function expectNoPrivateOutput(report: unknown, privateValues: string[]) {
  const serialized = JSON.stringify(report);
  for (const value of privateValues) expect(serialized).not.toContain(value);
  expect(serialized).not.toMatch(/RESULT [A-Za-z0-9._-]+ [a-f0-9]{32}|"scope"|"token"|"acceptance"|"format"|"summary"/);
  expect(serialized).not.toContain(runsDir);
}

beforeEach(() => {
  runsDir = mkdtempSync(join(tmpdir(), 'imsg-identity-465-'));
  vi.stubEnv('HOME', runsDir); vi.stubEnv('ASHLR_RUNS_DIR', runsDir); vi.stubEnv('PHANTOM_STACKSYNC', 'off');
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(runsDir, { recursive: true, force: true }); });

it('binds a writer-created queued task as active, then conflicting on scope or acceptance drift', async () => {
  const scope = 'PRIVATE_SCOPE_465_ACTIVE';
  await enqueue('FAKE-IDENT-465-A', scope);
  const token = JSON.parse(readFileSync(ledgerPath(), 'utf8')).tasks[0].token as string;
  const before = snapshot();
  const bound = await read('FAKE-IDENT-465-A');
  expect(bound.queueState).toBe('ok');
  expect(row(bound, 'FAKE-IDENT-465-A')).toMatchObject({
    state: 'queued', queueBinding: 'bound', queueClaim: 'active', resource: 'imsg:dot',
  });
  expectNoPrivateOutput(bound, [scope, 'PRIVATE_FORMAT_465', token]);
  expect(snapshot()).toEqual(before);

  // Replace only the queue's identity fields; id/owner/repo/status stay identical.
  for (const tamper of [
    (job: QueueJob) => { job.scope = 'REPLACED_PRIVATE_SCOPE'; },
    (job: QueueJob) => { job.acceptance = 'PRIVATE_ACCEPTANCE'; },
    (job: QueueJob) => { job.acceptance = `RESULT FAKE-IDENT-465-A ${'f'.repeat(32)}; peer report only, independent verification required`; },
  ]) {
    const doc = await queue().read();
    tamper(doc.jobs[0]!);
    writeFileSync(queue().path, JSON.stringify(doc));
    const report = await read('FAKE-IDENT-465-A');
    expect(row(report, 'FAKE-IDENT-465-A')).toMatchObject({ queueBinding: 'conflicting', queueClaim: null });
    expectNoPrivateOutput(report, [scope, token]);
    const restore = await queue().read();
    restore.jobs[0]!.scope = scope;
    restore.jobs[0]!.acceptance = `RESULT FAKE-IDENT-465-A ${token}; peer report only, independent verification required`;
    writeFileSync(queue().path, JSON.stringify(restore));
  }
  expect((await read('FAKE-IDENT-465-A')).tasks?.[0]).toMatchObject({ queueBinding: 'bound', queueClaim: 'active' });
  expect(snapshot()[0]).toBe(before[0]);
});

it('keeps an exact finished identity historical finished, never active, and conflicting after drift', async () => {
  const scope = 'PRIVATE_SCOPE_465_DONE';
  await enqueue('FAKE-IDENT-465-B', scope);
  const cancelled = await cancelTeammateTask('FAKE-IDENT-465-B', { runsDir, apply: true });
  expect(cancelled.state).toBe('cancelled');
  const token = JSON.parse(readFileSync(ledgerPath(), 'utf8')).tasks[0].token as string;
  const before = snapshot();
  const report = await read('FAKE-IDENT-465-B');
  expect(row(report, 'FAKE-IDENT-465-B')).toMatchObject({
    state: 'cancelled', queueBinding: 'bound', queueClaim: 'finished',
  });
  expectNoPrivateOutput(report, [scope, token]);
  expect(snapshot()).toEqual(before);

  const doc = await queue().read();
  doc.jobs[0]!.scope = 'REPLACED_PRIVATE_SCOPE';
  writeFileSync(queue().path, JSON.stringify(doc));
  const drifted = await read('FAKE-IDENT-465-B');
  expect(row(drifted, 'FAKE-IDENT-465-B')).toMatchObject({ queueBinding: 'conflicting', queueClaim: null });
  expectNoPrivateOutput(drifted, [scope, token]);
});

it('reports missing and unreadable queue stores as missing/unavailable without writes', async () => {
  await enqueue('FAKE-IDENT-465-C', 'PRIVATE_SCOPE_465_C');
  const token = JSON.parse(readFileSync(ledgerPath(), 'utf8')).tasks[0].token as string;
  rmSync(queue().path);
  const missing = await read('FAKE-IDENT-465-C');
  expect(missing.queueState).toBe('ok');
  expect(row(missing, 'FAKE-IDENT-465-C')).toMatchObject({ queueBinding: 'missing', queueClaim: null });
  expectNoPrivateOutput(missing, ['PRIVATE_SCOPE_465_C', token]);

  writeFileSync(queue().path, '{broken', { mode: 0o600 });
  const beforeLedger = readFileSync(ledgerPath(), 'utf8');
  const broken = await read('FAKE-IDENT-465-C');
  expect(broken.queueState).toBe('unavailable');
  expect(row(broken, 'FAKE-IDENT-465-C')).toMatchObject({ queueBinding: 'unavailable', queueClaim: null });
  expectNoPrivateOutput(broken, ['PRIVATE_SCOPE_465_C', token]);
  expect(readFileSync(queue().path, 'utf8')).toBe('{broken');
  expect(readFileSync(ledgerPath(), 'utf8')).toBe(beforeLedger);
});
