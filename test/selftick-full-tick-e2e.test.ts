import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetSelfTick } from '../src/cli/fleet-self-tick.js';
import type { InboxAck } from '../src/core/fleet/inbox-ack.js';
import { defaultLaneTruthReaders } from '../src/core/fleet/lane-truth.js';
import { readStraySlots, type StrayJob, type StrayProcess } from '../src/core/fleet/stray-slots.js';
import { SELF_TICK_STEP_ORDER, type SelfTickReport } from '../src/core/fleet/self-tick.js';

const NOW = Date.parse('2026-11-03T12:10:00Z');
const home = mkdtempSync(join(tmpdir(), 'full-selftick-'));
const root = join(home, '.ashlr-runs');
const put = (path: string, data: string) => writeFileSync(join(root, path), data, { mode: 0o600 });
const json = (path: string) => JSON.parse(readFileSync(join(root, path), 'utf8'));
const lines = (path: string) => readFileSync(join(root, path), 'utf8').trim().split('\n').filter(Boolean);
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); rmSync(home, { recursive: true, force: true }); });

it('runs the composed tick twice, preserves recovery evidence, and continues after a thrown step', async () => {
  for (const dir of ['queue', 'leader', 'metrics']) mkdirSync(join(root, dir), { recursive: true, mode: 0o700 });
  const sessions = join(home, '.codex-2/sessions');
  mkdirSync(sessions, { recursive: true });
  writeFileSync(join(sessions, 'rollout-fixture.jsonl'), [NOW - 7_200_000, NOW].map(at => JSON.stringify({
    type: 'event_msg', timestamp: new Date(at).toISOString(), payload: { type: 'token_count', rate_limits: {
      limit_id: 'codex', secondary: { used_percent: 20, window_minutes: 10080, resets_at: (NOW + 86400000) / 1000 },
    } },
  })).join('\n'));
  put('queue/ready.tsv', 'RQ-PHX-FAKE01\tphantom\tcodex-personal\twork\t/fake/one.md\nRQ-PHX-FAKE02\tphantom\tcodex-personal\twork\t/fake/two.md\n');
  put('queue/slots.json', JSON.stringify({ 'codex-personal': { target: 2, floor: 0, ceiling: 4, running: 1, queued: 2, held: false } }));
  put('queue/status.json', JSON.stringify({ last_tick: new Date(NOW).toISOString(), paused: false,
    lanes: { 'codex-personal': { running: 1, target: 2, queued: 2, held: false } } }));
  put('dispatch-events.log', '2026-11-03 06:00:00 LAUNCH RQ-PHX-STALE phantom codex-personal work\n2026-11-03 06:01:00 FINISH RQ-PHX-STALE\n');
  put('leader/MASON-INBOX.md', '2026-11-03T12:00:00Z [src:page id:fake-full-tick] Fake recovery request\n');
  put('leader/NEEDS-MASON.md', '');
  const job: StrayJob = { id: 'RQ-PHX-STALE', lane: 'codex-personal', finished: true, worktree: join(root, 'fake-worktree') };
  const processRow: StrayProcess = { pid: 2147483646, elapsed: '02:00:00', command: 'fake-worker', cwd: job.worktree };
  put('metrics/jobs.jsonl', JSON.stringify({ ...job, event: 'finish', empty: false, exit_code: 0, job: job.id, ts: new Date(NOW - 7_200_000).toISOString() }) + '\n');
  put('queue/running-job.json', JSON.stringify(processRow));
  // A stale process observation races with exit: ESRCH is injected, never sent.
  let gone = false;
  const kill = vi.fn(() => { gone = true; throw Object.assign(new Error('fake vanished pid'), { code: 'ESRCH' }); });
  const send = vi.fn(async (ack: InboxAck) => {
    appendFileSync(join(root, 'queue/fake-ack-outbox.jsonl'), JSON.stringify(ack) + '\n');
  });
  const noticeSend = vi.fn(async () => { throw new Error('unexpected notice'); });
  const spawn = vi.fn(() => { throw new Error('unexpected planner spawn'); });
  const network = vi.fn(() => { throw new Error('unexpected network'); });
  vi.stubGlobal('fetch', network);
  const realSignal = vi.spyOn(process, 'kill').mockImplementation(() => { throw new Error('real signal forbidden'); });
  // The network-facing final step uses its existing step seam. The early
  // failure below must still reach this final stage and persist its outcome.
  const sweep = vi.fn(async () => ({ exitCode: 0, output: JSON.stringify({ reason: 'fake-gh-no-open-prs' }) }));
  const run = async (failEarly = false) => {
    let output = '';
    const code = await cmdFleetSelfTick(['--json', '--apply', '--runs-dir', root], {
      home, now: () => NOW, output: text => { output = text; }, error: () => {}, spawn,
      senders: { page: send }, noticeSenders: { page: noticeSend },
      meterReaders: defaultLaneTruthReaders(home, NOW),
      stray: { kill, readStraySlots: () => readStraySlots({
        readJobs: async () => lines('metrics/jobs.jsonl').map(line => JSON.parse(line) as StrayJob),
        readProcesses: async () => gone ? [] : [json('queue/running-job.json') as StrayProcess],
      }) },
      steps: { 'landed-sweep': sweep, ...(failEarly ? { 'reset-release': async () => { throw new Error('fake read failure'); } } : {}) },
    });
    return { code, report: JSON.parse(output) as SelfTickReport };
  };
  const first = await run();
  expect(first.code, JSON.stringify(first.report)).toBe(0);
  expect(first.report.steps.map(step => step.step)).toEqual(SELF_TICK_STEP_ORDER);
  for (const step of first.report.steps) {
    expect(step.state, step.step).toBe('ok');
    expect(step.report, step.step).not.toBeNull();
  }
  expect(first.report.steps.find(step => step.step === 'stray-stop')?.report).toMatchObject({
    planned: [{ job: job.id, pid: processRow.pid }], results: [{ result: 'already-gone' }],
  });
  expect(first.report.steps.find(step => step.step === 'meter-incident')?.report).toMatchObject({
    posted: [{ provider: 'codex-personal', status: 'posted' }],
  });
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0]).toMatchObject([{ entryId: 'fake-full-tick', channel: 'page' }]);
  expect(lines('queue/inbox-acks.jsonl')).toHaveLength(1);
  expect(lines('queue/fake-ack-outbox.jsonl')).toHaveLength(1);
  expect(json('bus-inbox/messages.json').rows).toHaveLength(1);
  expect(json('queue/self-tick-last.json').steps).toEqual(first.report.steps);
  const second = await run();
  expect(second.code).toBe(0);
  expect(second.report.steps.find(step => step.step === 'meter-incident')?.report).toMatchObject({
    posted: [{ status: 'duplicate' }],
  });
  expect(json('bus-inbox/messages.json').rows).toHaveLength(1);
  expect(lines('queue/inbox-acks.jsonl')).toHaveLength(1);
  expect(lines('queue/fake-ack-outbox.jsonl')).toHaveLength(1);
  expect(lines('leader/NEEDS-MASON.md')).toHaveLength(0);
  expect(send).toHaveBeenCalledTimes(1);
  expect(kill).toHaveBeenCalledTimes(1);
  expect(lines('stray-stops.jsonl')).toHaveLength(1);
  expect(json('queue/self-tick-last.json').steps).toEqual(second.report.steps);
  const failure = await run(true);
  expect(failure.code).toBe(1);
  expect(failure.report.steps[0]).toMatchObject({ step: 'reset-release', state: 'failed' });
  expect(failure.report.steps.slice(1).every(step => step.state === 'ok')).toBe(true);
  expect(sweep).toHaveBeenCalledTimes(3);
  expect(json('queue/self-tick-last.json').steps).toEqual(failure.report.steps);
  expect(realSignal).not.toHaveBeenCalled();
  expect(network).not.toHaveBeenCalled();
  expect(spawn).not.toHaveBeenCalled();
  expect(noticeSend).not.toHaveBeenCalled();
});
