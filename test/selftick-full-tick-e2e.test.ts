import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetSelfTick } from '../src/cli/fleet-self-tick.js';
import { listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import type { InboxAck } from '../src/core/fleet/inbox-ack.js';
import type { LaneTruthReaders } from '../src/core/fleet/lane-truth.js';
import { readStraySlots, type StrayJob, type StrayProcess } from '../src/core/fleet/stray-slots.js';
import { SELF_TICK_STEP_ORDER, type SelfTickReport } from '../src/core/fleet/self-tick.js';

const NOW = Date.parse('2026-11-03T12:10:00Z');
const home = mkdtempSync(join(tmpdir(), 'full-selftick-'));
const root = join(home, '.ashlr-runs');
const put = (path: string, data: string) => writeFileSync(join(root, path), data, { mode: 0o600 });
const json = (path: string) => JSON.parse(readFileSync(join(root, path), 'utf8'));
const lines = (path: string) => readFileSync(join(root, path), 'utf8').trim().split('\n').filter(Boolean);
// Synthetic ordinary bus: ASHLR_HOME is relocated per test, never an operator root.
const ashlrRoot = join(home, 'ashlr-home');
beforeEach(() => { vi.stubEnv('ASHLR_HOME', ashlrRoot); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });

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
      meterReaders: {
        lanes: async () => [{ lane: 'codex-personal', target: 2, running: 1, queued: 2, held: false }],
        meters: async () => [NOW - 7_200_000, NOW].map(at => ({ provider: 'codex-personal', window: 'secondary:10080', usedPercent: 20, resetAt: new Date(NOW + 86400000).toISOString(), sampledAt: new Date(at).toISOString() })),
      } satisfies LaneTruthReaders,
      stray: { kill, readStraySlots: () => readStraySlots({
        readJobs: async () => lines('metrics/jobs.jsonl').map(line => JSON.parse(line) as StrayJob),
        readProcesses: async () => gone ? [] : [json('queue/running-job.json') as StrayProcess],
      }) },
      steps: { 'landed-sweep': sweep, ...(failEarly ? { 'claude-quota': async () => ({ exitCode: 0, output: '' }), 'reset-release': async () => { throw new Error('fake read failure'); } } : {}) },
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
  // The incident lands in the ordinary default store, not a store invented under the runs dir.
  const received = listBusInboxAfter(0, 50, { now: () => NOW });
  expect(received).toMatchObject({ status: 'ok', messages: [{ cursor: 1, envelope: { from: 'fleet', body: { kind: 'meter-flat', provider: 'codex-personal' } } }] });
  expect(existsSync(join(ashlrRoot, 'fleet/bus-inbox/messages.json'))).toBe(true);
  expect(existsSync(join(root, 'bus-inbox'))).toBe(false);
  expect(json('queue/self-tick-last.json').steps).toEqual(first.report.steps);
  const second = await run();
  expect(second.code).toBe(0);
  expect(second.report.steps.find(step => step.step === 'meter-incident')?.report).toMatchObject({
    posted: [{ status: 'duplicate' }],
  });
  expect(listBusInboxAfter(0, 50, { now: () => NOW })).toEqual(received);
  expect(existsSync(join(root, 'bus-inbox'))).toBe(false);
  expect(lines('queue/inbox-acks.jsonl')).toHaveLength(1);
  expect(lines('queue/fake-ack-outbox.jsonl')).toHaveLength(1);
  expect(lines('leader/NEEDS-MASON.md')).toHaveLength(0);
  expect(send).toHaveBeenCalledTimes(1);
  expect(kill).toHaveBeenCalledTimes(1);
  expect(lines('stray-stops.jsonl')).toHaveLength(1);
  expect(json('queue/self-tick-last.json').steps).toEqual(second.report.steps);
  const failure = await run(true);
  expect(failure.code).toBe(1);
  expect(failure.report.steps[1]).toMatchObject({ step: 'reset-release', state: 'failed' });
  expect(failure.report.steps.slice(2).every(step => step.state === 'ok')).toBe(true);
  expect(sweep).toHaveBeenCalledTimes(3);
  expect(json('queue/self-tick-last.json').steps).toEqual(failure.report.steps);
  expect(realSignal).not.toHaveBeenCalled();
  expect(network).not.toHaveBeenCalled();
  expect(spawn).not.toHaveBeenCalled();
  expect(noticeSend).not.toHaveBeenCalled();
});

it('uses the owning recovery CLI cap and typed refusal in the composed tick', async () => {
  const localHome = mkdtempSync(join(tmpdir(), 'selftick-recovery-cli-'));
  const localRoot = join(localHome, 'runs');
  mkdirSync(join(localRoot, 'queue'), { recursive: true });
  const realSignal = vi.spyOn(process, 'kill').mockImplementation(() => { throw new Error('real signal forbidden'); });
  const kill = vi.fn();
  const strays = Array.from({ length: 21 }, (_, i) => ({ job: `RQ-${i}`, pid: 2000000 + i, ageSeconds: 1 }));
  let reads = 0;
  const readStraySlots = async () => ({ lanes: ++reads === 1 ? [{ lane: 'codex', slotsLost: 21, strays }] : [] });
  const noop = async () => ({ exitCode: 0, output: '{}' });
  let output = '';
  try {
    const code = await cmdFleetSelfTick(['--json', '--apply', '--runs-dir', localRoot], {
      home: localHome, now: () => NOW, output: text => { output = text; }, error: () => {},
      stray: { readStraySlots, kill },
      steps: { 'claude-quota': async () => ({ exitCode: 0, output: '' }), 'reset-release': noop, 'lane-autohold': noop, 'meter-incident': noop, 'planner-tick': noop,
        'inbox-acks': noop, 'order-notices': noop, 'landed-sweep': noop },
    });
    expect(code).toBe(0);
    const report = JSON.parse(output) as SelfTickReport;
    expect(report.steps.find(step => step.step === 'stray-stop')?.report).toMatchObject({
      v: 1, mode: 'apply', summary: { planned: 20, refused: 20, failed: 0, capped: true },
      results: Array.from({ length: 20 }, () => ({ result: 'refused', code: 'not-a-stray' })),
    });
    expect(kill).not.toHaveBeenCalled();
    expect(realSignal).not.toHaveBeenCalled();
    expect(reads).toBe(21);
  } finally {
    rmSync(localHome, { recursive: true, force: true });
  }
});

describe('meter incident bus root', () => {
  const NOON = Date.parse('2026-11-03T12:10:00Z');
  const readers = {
    lanes: async () => [{ lane: 'codex-personal', target: 2, running: 1, queued: 2, held: false }],
    meters: async () => [NOON - 7_200_000, NOON].map(at => ({ provider: 'codex-personal', window: 'secondary:10080', usedPercent: 20, resetAt: new Date(NOON + 86400000).toISOString(), sampledAt: new Date(at).toISOString() })),
  } satisfies LaneTruthReaders;
  const noop = async () => ({ exitCode: 0, output: '{}' });
  const others = { 'claude-quota': async () => ({ exitCode: 0, output: '' }), 'reset-release': noop, 'lane-autohold': noop, 'stray-stop': noop, 'planner-tick': noop,
    'inbox-acks': noop, 'order-notices': noop, 'landed-sweep': noop };
  const tick = async (runs: string, extra: Record<string, unknown>) => {
    let output = '';
    const code = await cmdFleetSelfTick(['--json', '--apply', '--runs-dir', runs], {
      home, now: () => NOON, output: text => { output = text; }, error: () => {}, steps: others, ...extra,
    });
    const report = JSON.parse(output) as SelfTickReport;
    return { code, meter: report.steps.find(step => step.step === 'meter-incident')?.report };
  };

  it('posts to an explicit isolated bus root, independent of the runs dir and the default store', async () => {
    const runs = join(home, 'custom-runs'), bus = join(home, 'isolated-bus');
    mkdirSync(join(runs, 'queue'), { recursive: true, mode: 0o700 });
    const first = await tick(runs, { meterReaders: readers, busRoot: bus });
    expect(first.meter).toMatchObject({ posted: [{ provider: 'codex-personal', status: 'posted' }] });
    const retry = await tick(runs, { meterReaders: readers, busRoot: bus });
    expect(retry.meter).toMatchObject({ posted: [{ status: 'duplicate' }] });
    const rows = listBusInboxAfter(0, 50, { root: bus, now: () => NOON });
    expect(rows).toMatchObject({ status: 'ok', messages: [{ cursor: 1 }] });
    expect(existsSync(join(runs, 'bus-inbox'))).toBe(false);
    expect(existsSync(join(ashlrRoot, 'fleet/bus-inbox'))).toBe(false);
    expect(statSync(join(bus, 'bus-inbox')).mode & 0o777).toBe(0o700);
  });

  it('never posts a custom runs root to the production bus without an explicit bus root', async () => {
    const runs = join(home, 'custom-runs-2');
    mkdirSync(join(runs, 'queue'), { recursive: true, mode: 0o755 });
    const result = await tick(runs, { meterReaders: readers });
    expect(result.code).toBe(0);
    expect(result.meter).toMatchObject({ posted: [], reason: 'custom-runs-dir-no-bus-root' });
    expect(existsSync(join(runs, 'bus-inbox'))).toBe(false);
    expect(existsSync(join(ashlrRoot, 'fleet'))).toBe(false);
    // Without injected readers the custom root never reads the host at all.
    const bare = await tick(runs, {});
    expect(bare.meter).toMatchObject({ reason: 'custom-runs-dir-no-meter-reader' });
    expect(existsSync(join(ashlrRoot, 'fleet'))).toBe(false);
  });
});
