import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AshlrConfig } from '../src/core/types.js';
import { classifyTeammateIntent, teammateNeedsReply } from '../src/core/comms/imessage-teammate-inbox.js';
import { enqueueTeammateTask, listTeammateTasks, runTeammateTasks, teammateTaskPeers } from '../src/core/comms/imessage-teammate-tasks.js';
import { QueueStore } from '../src/core/queue/store.js';

const cfg = { comms: { enabled: true } } as AshlrConfig;
const dirs: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('original teammate task preservation', () => {
  it('expires a reserved task and rejects a correlated result arriving at its deadline', async () => {
    const runsDir = mkdtempSync(join(tmpdir(), 'imsg-799s-')); dirs.push(runsDir);
    vi.stubEnv('HOME', runsDir); vi.stubEnv('ASHLR_RUNS_DIR', runsDir); vi.stubEnv('PHANTOM_STACKSYNC', 'off');
    let now = Date.parse('2026-11-15T12:00:00Z');
    const send = vi.fn(async () => 'accepted' as const);
    const opts = { runsDir, now: () => now, approved: () => 'fixture-handle', send,
      reconcile: async () => ({ rowid: 100, sent: true, delivered: true, error: 0 }) };
    const input = { jobId: 'FAKE-799', peer: 'dot', kind: 'research', scope: 'Private fixture scope',
      repo: 'example/fixture', format: 'Private fixture format', deadline: new Date(now + 60_000).toISOString() } as const;
    await enqueueTeammateTask(input, cfg, { ...opts, apply: true });
    expect(send).not.toHaveBeenCalled();
    expect((await new QueueStore(join(runsDir, 'queue')).read()).jobs[0]).toMatchObject({ id: input.jobId, status: 'CLAIMED' });
    await runTeammateTasks(cfg, { ...opts, apply: true });
    const task = listTeammateTasks(opts).tasks[0]!;
    const senderId = teammateTaskPeers(opts).peers.find(peer => peer.peer === 'dot')!.senderId;
    now += 60_000;
    mkdirSync(join(runsDir, 'imessage'), { recursive: true, mode: 0o700 });
    appendFileSync(join(runsDir, 'imessage', 'teammates.jsonl'), JSON.stringify({ v: 1, rowid: 101,
      at: new Date(now).toISOString(), senderId, text: `RESULT ${input.jobId} ${task.token} DONE Private late result` }) + '\n', { mode: 0o600 });
    await runTeammateTasks(cfg, { ...opts, apply: true });
    expect(listTeammateTasks(opts).tasks[0]).toMatchObject({ state: 'expired', result: null });
    expect((await new QueueStore(join(runsDir, 'queue')).read()).jobs[0]).toMatchObject({ status: 'BLOCKED' });
    expect(send).toHaveBeenCalledOnce();
    expect(teammateTaskPeers(opts).peers.find(peer => peer.peer === 'dot')!.observed).toEqual([]);
  });

  it.each(['TASK FAKE-799 abc Please act?', 'RESULT FAKE-799 abc DONE Please act?',
    'Forwarded context:\nTASK FAKE-799 abc Please act?'])('suppresses protocol from conversation and dispatch: %s', text => {
    expect(teammateNeedsReply(text)).toBe(false);
    expect(classifyTeammateIntent(text, true)).toBe('ignore');
  });
});
