import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QueueStore } from '../../src/core/queue/store.js';
import { readFleetImessageTasks, parseFleetImessageTasksArgs } from '../../src/mcp/fleet-imessage-tasks.js';

const root = mkdtempSync(join(tmpdir(), 'binding-'));
afterEach(() => rmSync(root, { recursive: true, force: true }));

it('distinguishes durable claims from orphan, conflict and unknown without writing or leaking', async () => {
  const dir = join(root, 'imessage');
  mkdirSync(dir, { recursive: true });
  const ledger = join(dir, 'teammate-tasks.json');
  const ids = ['bound', 'orphan', 'conflict', 'terminal'];
  const token = (n: number) => String(n).padStart(32, '0');
  // The writer's reserved identity: RESULT <jobId> <token> acceptance plus owner, repo and scope.
  const acceptance = (id: string, n: number) => `RESULT ${id} ${token(n)}; peer report only, independent verification required`;
  const tasks = ids.map((jobId, i) => ({ jobId, peer: 'dot', kind: 'research', repo: 'ashlrai/phantom',
    scope: 'PRIVATE_SCOPE', format: 'PRIVATE_FORMAT', deadline: '2027-06-01T00:00:00.000Z',
    token: token(i + 1), createdAt: i, state: 'queued', metrics: [], settled: false, prRefs: [] }));
  writeFileSync(ledger, JSON.stringify({ v: 1, tasks, attempts: { dot: [], instinct: [] } }));
  const queue = new QueueStore(join(root, 'queue'));
  for (const [id, n] of [['bound', 1], ['conflict', 3], ['terminal', 4]] as const) {
    await queue.add({ id, status: id === 'terminal' ? 'DONE' : 'CLAIMED', priority: 'P2', tier: 'work',
      repo: 'ashlrai/phantom', scope: 'PRIVATE_SCOPE', acceptance: acceptance(id, n), deps: [],
      claims: [{ owner: id === 'conflict' ? 'imsg:instinct' : 'imsg:dot', claimedAt: '2026-01-01T00:00:00.000Z',
        ...(id === 'terminal' ? { finishedAt: '2026-01-02T00:00:00.000Z' } : {}) }] });
  }
  const beforeLedger = readFileSync(ledger, 'utf8');
  const beforeQueue = readFileSync(queue.path, 'utf8');
  const report = await readFleetImessageTasks({ limit: 20 }, { runsDir: root });
  expect(report.queueState).toBe('ok');
  expect(report.tasks?.map(t => [t.queueBinding, t.queueClaim])).toEqual([
    ['bound', 'active'], ['missing', null], ['conflicting', null], ['bound', 'finished'],
  ]);
  expect(JSON.stringify(report)).not.toMatch(/PRIVATE_|0000000000000000000000000000000|teammate-tasks\.json|@/);
  expect(readFileSync(ledger, 'utf8')).toBe(beforeLedger);
  expect(readFileSync(queue.path, 'utf8')).toBe(beforeQueue);
  expect((await readFleetImessageTasks({ jobId: 'bound', limit: 1 }, { runsDir: root })).tasks?.[0]?.jobId).toBe('bound');
  expect((await readFleetImessageTasks({ limit: 1 }, { runsDir: root })).tasks?.[0]?.jobId).toBe('terminal');
  expect(parseFleetImessageTasksArgs({ path: root })).toBeNull();
  writeFileSync(queue.path, '{broken');
  const unavailable = await readFleetImessageTasks({ limit: 20 }, { runsDir: root });
  expect(unavailable.queueState).toBe('unavailable');
  expect(unavailable.tasks?.every(t => t.queueBinding === 'unavailable' && t.queueClaim === null)).toBe(true);
  expect(readFileSync(queue.path, 'utf8')).toBe('{broken');
  expect(readFileSync(ledger, 'utf8')).toBe(beforeLedger);
});
