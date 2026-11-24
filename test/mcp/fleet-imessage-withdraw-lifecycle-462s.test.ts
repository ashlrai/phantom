/**
 * RQ-PHX-IMSGWITHDRAWMCP462S: the receipt-backed withdrawal contract through the
 * real fleet_imessage_tasks read path. One unsent teammate task in one temporary
 * runs root; real enqueueTeammateTask, cancelTeammateTask and QueueStore settle
 * it, and every freshly constructed readFleetImessageTasks report presents the
 * claim as historical, never an active assignment. No transport calls, no stubbed
 * collector, queue reader or projection; settlement is observed, not invented.
 * Neighbors 452s/453s/454s keep their scopes: this is the missing MCP-read link.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AshlrConfig } from '../../src/core/types.js';
import {
  cancelTeammateTask, enqueueTeammateTask, type TeammateTaskInput, type TeammateTaskOptions,
} from '../../src/core/comms/imessage-teammate-tasks.js';
import { QueueStore } from '../../src/core/queue/store.js';
import { readFleetImessageTasks, type FleetImessageTasksReport } from '../../src/mcp/fleet-imessage-tasks.js';

const cfg = { comms: { enabled: true } } as AshlrConfig;
/** Explicitly approved fake peer: only the production dot senderId, a throwaway handle. */
const approved = (senderId: string): string | null =>
  senderId === 'imessage:e2e0809f8676fb7d' ? 'imessage:fake-dot-handle' : null;
const send = vi.fn(async (): Promise<'accepted' | 'uncertain' | 'refused'> => 'accepted');
const reconcile = vi.fn(async (): Promise<{ rowid: number; sent: boolean; delivered: boolean; error: number } | null> =>
  { throw new Error('No transport call allowed'); });
const input: TeammateTaskInput = { jobId: 'RQ-FAKE-WITHDRAW-462S', peer: 'dot', kind: 'research',
  scope: 'PRIVATE-FAKE-SCOPE-462S', repo: 'fixture/example', prRefs: [7],
  format: 'PRIVATE-FAKE-FORMAT-462S', deadline: '2099-01-01T00:00:00Z' };

let runsDir: string;
let queue: QueueStore;
const opts = (): TeammateTaskOptions => ({ runsDir, apply: true, approved, send, reconcile });
const mcp = () => readFleetImessageTasks({ jobId: input.jobId, limit: 20 }, { runsDir });
const job = async () => (await queue.read()).jobs.find(entry => entry.id === input.jobId)!;
const ledgerBytes = () => readFileSync(join(runsDir, 'imessage', 'teammate-tasks.json'), 'utf8');
const bothBytes = (): [string, string] => [ledgerBytes(), readFileSync(queue.path, 'utf8')];
/** The envelope token, private scope and format never cross the projection. */
function noLeak(report: FleetImessageTasksReport): void {
  const token = (JSON.parse(ledgerBytes()) as { tasks: Array<{ token: string }> }).tasks[0].token;
  for (const marker of [token, input.scope, input.format, '"token"', '"scope"', '"format"',
    '"kind"', '"repo"', '"prRefs"', '"metrics"', '"settled"', '"summary"'])
    expect(JSON.stringify(report), marker).not.toContain(marker);
}
beforeEach(() => {
  runsDir = mkdtempSync(join(tmpdir(), 'imsg-withdraw-462s-'));
  vi.stubEnv('HOME', runsDir); vi.stubEnv('ASHLR_RUNS_DIR', runsDir); vi.stubEnv('PHANTOM_STACKSYNC', 'off');
  queue = new QueueStore(join(runsDir, 'queue'));
});
afterEach(() => {
  expect(send).not.toHaveBeenCalled();
  expect(reconcile).not.toHaveBeenCalled();
  send.mockReset(); reconcile.mockReset();
  vi.unstubAllEnvs();
  rmSync(runsDir, { recursive: true, force: true });
});
it('an unsent withdrawal always settles to a finished historical claim the MCP reader reports, never an active assignment', async () => {
  await enqueueTeammateTask(input, cfg, opts());
  expect((await job()).claims).toHaveLength(1); // apply reserved exactly one real claim
  expect((await job()).claims[0]).toMatchObject({ owner: 'imsg:dot', claimedAt: expect.any(String) });
  expect((await job()).claims[0].finishedAt).toBeUndefined();
  const active = await mcp();
  expect(active).toMatchObject({ sourceState: 'ok', ledgerState: 'present', queueState: 'ok', matched: true });
  expect(active.tasks?.[0]).toMatchObject({ state: 'queued', queueBinding: 'bound', queueClaim: 'active',
    claimKey: `queue:imsg.dot.${input.jobId}`, resource: 'imsg:dot', transportReceipt: null, result: null });
  expect(Object.keys(active.tasks![0]).sort()).toEqual(
    ['claimKey', 'createdAt', 'deadline', 'jobId', 'peer', 'queueBinding', 'queueClaim', 'resource', 'result', 'state', 'transportReceipt']);
  noLeak(active);
  const before = bothBytes();
  expect(await cancelTeammateTask(input.jobId, { runsDir, approved })).toMatchObject({ state: 'planned', dryRun: true });
  expect(bothBytes()).toEqual(before); // preview writes neither file
  expect((await mcp()).tasks?.[0]).toMatchObject({ state: 'queued', queueBinding: 'bound', queueClaim: 'active' }); // still active
  expect(await cancelTeammateTask(input.jobId, opts())).toMatchObject({ state: 'cancelled', dryRun: false });
  const withdrawn = await mcp(); // newly constructed read of the settlement
  expect(withdrawn.matched).toBe(true);
  expect(withdrawn.tasks?.[0]).toMatchObject({ state: 'cancelled', queueBinding: 'bound', queueClaim: 'finished' });
  noLeak(withdrawn);
  expect(await job()).toMatchObject({ status: 'BLOCKED', blockedReason: 'Operator withdrew unsent teammate task' });
  const finishedAt = (await job()).claims[0].finishedAt!;
  const settled = bothBytes();
  expect(await cancelTeammateTask(input.jobId, opts())).toMatchObject({ state: 'cancelled', dryRun: false });
  expect(bothBytes()).toEqual(settled); // repeat apply: no second claim, no reactivation
  expect((await job()).claims).toHaveLength(1);
  expect((await job()).claims[0].finishedAt).toBe(finishedAt);
  const doc = await queue.read();
  const replaced = doc.jobs.find(entry => entry.id === input.jobId)!;
  replaced.status = 'CLAIMED'; // the queue owner is replaced by another executor
  replaced.claims.push({ owner: 'fake-replacement-worker', claimedAt: new Date().toISOString() });
  writeFileSync(queue.path, JSON.stringify(doc));
  expect((await cancelTeammateTask(input.jobId, opts())).state).toBe('refused');
  const conflicted = await mcp();
  expect(conflicted.tasks?.[0]).toMatchObject({ state: 'cancelled', queueBinding: 'conflicting', queueClaim: null });
  noLeak(conflicted);
  expect((await job()).claims[1]).toMatchObject({ owner: 'fake-replacement-worker' });
  expect((await job()).claims[1].finishedAt).toBeUndefined(); // refusal never finishes the replacement claim
});
