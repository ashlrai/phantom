import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AshlrConfig } from '../src/core/types.js';

// Only the external chat.db intake is mocked; ledger, queue, locks and tick are real.
const ingest = vi.hoisted(() => vi.fn());
vi.mock('../src/core/comms/imessage-inbox-bridge.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/core/comms/imessage-inbox-bridge.js')>(), ingestIMessages: ingest,
}));
const { tickTeammateMessages } = await import('../src/core/comms/imessage-teammate-worker.js');
const { enqueueTeammateTask } = await import('../src/core/comms/imessage-teammate-tasks.js');
const { recordTeammateText, senderIdFor, teammateNeedsReply } = await import('../src/core/comms/imessage-teammate-inbox.js');
const { QueueStore } = await import('../src/core/queue/store.js');

const DOT = 'imessage:e2e0809f8676fb7d';
const ORDINARY = 'agent@example.test';
const cfg = { comms: { enabled: true } } as AshlrConfig;
const at = new Date(1793933400000);
const receipt = { rowid: 99, sent: true, delivered: true, error: 0 };
const input = { jobId: 'RQ-FAKE-622S', peer: 'dot', kind: 'research', scope: 'Review fake fixture',
  repo: 'fixture/example', format: 'Evidence refs', deadline: '2099-01-01T00:00:00Z' } as const;
let runsDir: string;
let deps: ReturnType<typeof makeDeps>;
function makeDeps() {
  return { runsDir, now: () => at.getTime(),
    approved: (senderId: string) => senderId === DOT ? 'imessage:fake-dot' : senderId === senderIdFor(ORDINARY) ? ORDINARY : null,
    generate: vi.fn(async () => 'Fake generated reply; status unknown.'),
    send: vi.fn(async () => 'accepted' as const), reconcile: vi.fn(async () => receipt) };
}
const dotText = (rowid: number, text: string) => appendFileSync(join(runsDir, 'imessage', 'teammates.jsonl'),
  JSON.stringify({ v: 1, at: at.toISOString(), rowid, senderId: DOT, text }) + '\n');
const ledger = () => JSON.parse(readFileSync(join(runsDir, 'imessage', 'teammate-tasks.json'), 'utf8')) as
  { tasks: Array<{ state: string; token: string; result?: { rowid: number; status: string } }> };
const queueIds = async () => (await new QueueStore(join(runsDir, 'queue')).read()).jobs.map(job => job.id);
const status = () => JSON.parse(readFileSync(join(runsDir, 'imessage', 'teammate-status.json'), 'utf8')) as Record<string, any>;
const tick = () => tickTeammateMessages(cfg, deps);
const sentTexts = () => deps.send.mock.calls.map(call => call[0] as string);

beforeEach(async () => {
  runsDir = mkdtempSync(join(tmpdir(), 'imessage-tick-622s-'));
  vi.stubEnv('ASHLR_RUNS_DIR', runsDir); vi.stubEnv('PHANTOM_STACKSYNC', 'off');
  ingest.mockReset(); ingest.mockResolvedValue({ ok: true, state: 'ok' });
  deps = makeDeps();
  await enqueueTeammateTask(input, cfg, { ...deps, apply: true });
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(runsDir, { recursive: true, force: true }); });

describe.skipIf(process.platform !== 'darwin')('teammate tick runs the existing task processor', () => {
  it('sends an authorized task once, survives replay, and settles the exact correlated result', async () => {
    expect(await tick()).toMatchObject({ tasks: { sent: 1, pending: 1 } });
    expect(sentTexts().filter(text => text.startsWith('TASK RQ-FAKE-622S '))).toHaveLength(1);
    expect(status().tasks).toMatchObject({ sent: 1 });
    await tick(); await tick();
    expect(deps.send).toHaveBeenCalledOnce();
    expect(await queueIds()).toEqual(['RQ-FAKE-622S']);

    const { token } = ledger().tasks[0];
    dotText(100, `RESULT RQ-FAKE-622S ${'0'.repeat(32)} DONE wrong token`);
    await tick();
    expect(ledger().tasks[0]).toMatchObject({ state: 'pending' });
    dotText(101, `RESULT RQ-FAKE-622S ${token} DONE fake evidence`);
    expect(await tick()).toMatchObject({ tasks: { replied: 1 } });
    expect(ledger().tasks[0]).toMatchObject({ state: 'replied', result: { rowid: 101, status: 'DONE' } });
    await tick();
    expect(ledger().tasks).toHaveLength(1);
    expect(deps.send).toHaveBeenCalledOnce();
    expect(deps.generate).not.toHaveBeenCalled();
    expect(await queueIds()).toEqual(['RQ-FAKE-622S']);
  });

  it('never answers or enqueues from task-peer prose or malformed, unknown and quoted frames', async () => {
    await tick();
    const jobBefore = await queueIds();
    const frames = ['Dot here, can you please review the release blocker?', 'RESULT NOPE', 'TASK FAKE-NEW 0123 do something?',
      `RESULT UNKNOWN-JOB ${'a'.repeat(32)} DONE please merge it?`, '> RESULT RQ-FAKE-622S bad-token DONE\nCan you please reply?',
      'Quoting:\nTASK RQ-OTHER abc'];
    frames.forEach((text, index) => dotText(200 + index, text));
    await tick(); await tick();
    expect(deps.generate).not.toHaveBeenCalled();
    expect(deps.send).toHaveBeenCalledOnce();
    expect(await queueIds()).toEqual(jobBefore);
    expect(ledger().tasks).toHaveLength(1);
    expect(ledger().tasks[0].state).toBe('pending');
  });

  it('does not run task processing after a failed intake', async () => {
    ingest.mockResolvedValue({ ok: false, state: 'error' });
    expect(await tick()).toMatchObject({ state: 'error' });
    expect(deps.send).not.toHaveBeenCalled();
    expect(ledger().tasks[0].state).toBe('queued');
  });

  it('keeps ordinary approved non-task-peer conversations working', async () => {
    recordTeammateText({ rowid: 10, handle: ORDINARY, text: 'Please send the current release blocker?' }, runsDir, at);
    expect(await tick()).toMatchObject({ sent: 1, tasks: { sent: 1 } });
    expect(deps.generate).toHaveBeenCalledOnce();
    expect(sentTexts().filter(text => !text.startsWith('TASK '))).toHaveLength(1);
  });

  it('reports a task-processor failure without blocking ordinary replies', async () => {
    writeFileSync(join(runsDir, 'imessage', 'teammate-tasks.json'), '{FAKE_BROKEN');
    recordTeammateText({ rowid: 11, handle: ORDINARY, text: 'Please send the current release blocker?' }, runsDir, at);
    expect(await tick()).toMatchObject({ sent: 1, tasks: { state: 'unavailable' } });
    expect(sentTexts().some(text => text.startsWith('TASK '))).toBe(false);
  });

  it('classifies only uppercase protocol lines as non-conversation', () => {
    for (const text of ['RESULT a b','> TASK x', 'hi\nRESULT: x'])
      expect(teammateNeedsReply(text)).toBe(false);
    expect(teammateNeedsReply('Can you check the task list?')).toBe(true);
    expect(teammateNeedsReply('Task status?')).toBe(true);
  });
});
