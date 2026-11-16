import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFleetImessageTasks, type FleetImessageTasksDeps } from '../src/mcp/fleet-imessage-tasks.js';

let runsDir: string;
beforeEach(() => { runsDir = mkdtempSync(join(tmpdir(), 'task-health-')); });
afterEach(() => { rmSync(runsDir, { recursive: true, force: true }); });

const input = { jobId: 'wanted', limit: 1 };
const row = (jobId: string, index: number) => ({ jobId, peer: 'dot', kind: 'research', repo: 'ashlrai/phantom',
  scope: 'private scope', format: 'private format', deadline: '2027-06-01T00:00:00.000Z',
  token: String(index).padStart(32, '0'), createdAt: index, state: 'queued', metrics: [], settled: false, prRefs: [] });
function ledger(tasks: ReturnType<typeof row>[]) {
  const dir = join(runsDir, 'imessage');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'teammate-tasks.json'), JSON.stringify({ v: 1, tasks, attempts: { dot: [], instinct: [] } }));
}

describe('fleet iMessage task collector health', () => {
  it('selects the exact job on a healthy ledger and preserves the private projection', async () => {
    ledger([row('wanted', 1), row('other', 2)]);
    const result = await readFleetImessageTasks(input, { runsDir });
    expect(result).toMatchObject({ sourceState: 'ok', ledgerState: 'present', matched: true });
    expect(result.tasks?.map(task => task.jobId)).toEqual(['wanted']);
    expect(JSON.stringify(result)).not.toMatch(/private scope|private format|00000000000000000000000000000001/);
  });

  it('reports healthy empty and missing ledgers as unmatched', async () => {
    expect(await readFleetImessageTasks(input, { runsDir })).toMatchObject({ sourceState: 'ok', ledgerState: 'missing', matched: false, tasks: [] });
    ledger([]);
    expect(await readFleetImessageTasks(input, { runsDir })).toMatchObject({ sourceState: 'ok', ledgerState: 'present', matched: false, tasks: [] });
  });

  it.each(['unavailable', 'error'])('rejects %s reports even with an empty array', async state => {
    const listTasks = (() => ({ schema: 'imessage.teammate-tasks.v1', state, tasks: [] })) as FleetImessageTasksDeps['listTasks'];
    const result = await readFleetImessageTasks(input, { runsDir, listTasks });
    expect(result).toMatchObject({ sourceState: 'unavailable', ledgerState: 'missing', queueState: 'ok', matched: null, tasks: null });
  });

  it('does not return stale rows from an unhealthy report, independently of queue health', async () => {
    ledger([row('wanted', 1)]);
    const dir = join(runsDir, 'queue');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'queue.v1.json'), '{broken');
    const listTasks = (() => ({ schema: 'imessage.teammate-tasks.v1', state: 'unavailable', tasks: [row('wanted', 1)] })) as unknown as FleetImessageTasksDeps['listTasks'];
    const result = await readFleetImessageTasks(input, { runsDir, listTasks });
    expect(result).toMatchObject({ sourceState: 'unavailable', ledgerState: 'present', queueState: 'unavailable', matched: null, tasks: null });
    expect(JSON.stringify(result)).not.toContain('private scope');
  });

  it('fails closed on a corrupt ledger through the real collector without leaking errors or paths', async () => {
    const dir = join(runsDir, 'imessage');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'teammate-tasks.json'), '{broken');
    const result = await readFleetImessageTasks(input, { runsDir });
    expect(result).toMatchObject({ sourceState: 'unavailable', ledgerState: 'present', matched: null, tasks: null });
    expect(JSON.stringify(result)).not.toContain(runsDir);
    expect(JSON.stringify(result)).not.toContain('invalid');
  });
});
