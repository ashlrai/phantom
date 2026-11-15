import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cmdFleetSelfTick } from '../src/cli/fleet-self-tick.js';
import { cmdFleetCosWork } from '../src/cli/fleet-cos-work.js';
import { queueCosEnvelope } from '../src/core/cos/intake.js';
import { QueueStore } from '../src/core/queue/store.js';
import { SELF_TICK_STEP_ORDER, type SelfTickSteps } from '../src/core/fleet/self-tick.js';
import { readSelfTickLast } from '../src/core/fleet/self-tick-last.js';
import type { SpawnedPlannerProcess, SpawnLike } from '../src/core/fleet/planner-run.js';

let runsDir: string;
let id: string;
const candidates = [{ provider: 'fake', argv: ['fake-cli'] }];
const now = () => Date.parse('2026-11-04T12:00:00Z');
beforeEach(async () => {
  runsDir = await mkdtemp(join(tmpdir(), 'self-tick-cos-'));
  id = await queueCosEnvelope({ channel: 'cli', verifiedSenderId: 'fake-local',
    body: 'Prepare a fake brief', receivedAt: new Date(now()).toISOString(), dedupeKey: 'b'.repeat(64) }, runsDir);
});
afterEach(async () => { await rm(runsDir, { recursive: true, force: true }); });
const status = async () => (await new QueueStore(join(runsDir, 'queue')).read()).jobs.find(job => job.id === id)?.status;
function runner(code = 0) {
  return vi.fn<SpawnLike>(() => {
    const events = new EventEmitter();
    const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
    const child = Object.assign(events, { stdin, stdout, stderr, kill: () => true });
    stdin.on('finish', () => {
      stdout.end('A plainly fake drafted answer.');
      setImmediate(() => events.emit('close', code, null));
    });
    return child as unknown as SpawnedPlannerProcess;
  });
}
async function tick(apply: boolean, spawn = runner(), slate = candidates, override: Partial<SelfTickSteps> = {}) {
  await writeFile(join(runsDir, 'queue', 'planner-candidates.json'), JSON.stringify({ v: 1, candidates: slate }));
  const steps: Partial<SelfTickSteps> = Object.fromEntries(SELF_TICK_STEP_ORDER.slice(0, -1)
    .map(name => [name, async () => ({ exitCode: 0, output: '{}' })]));
  const output: string[] = [];
  const code = await cmdFleetSelfTick(['--json', '--runs-dir', runsDir, ...(apply ? ['--apply'] : [])], {
    now, home: runsDir, spawn, steps: { ...steps, ...override }, output: text => output.push(text),
  });
  const report = JSON.parse(output[0]!);
  return { code, report, step: report.steps.at(-1) };
}
it('ends the order with landed-sweep then cos-work', () => {
  expect(SELF_TICK_STEP_ORDER.slice(-2)).toEqual(['landed-sweep', 'cos-work']);
});
it('dry run counts pending jobs without claiming or spawning', async () => {
  const spawn = runner();
  const result = await tick(false, spawn);
  expect(result.code).toBe(0);
  expect(result.step).toMatchObject({ state: 'ok', report: { v: 1, mode: 'dry-run', pending: 1, next: id } });
  expect(await status()).toBe('READY');
  expect(spawn).not.toHaveBeenCalled();
});
it('applied tick drafts one answer and finishes the job', async () => {
  const spawn = runner();
  const result = await tick(true, spawn);
  expect(result.code).toBe(0);
  expect(result.step).toMatchObject({ state: 'ok', report: { outcome: 'drafted', id } });
  expect(await status()).toBe('DONE');
  expect(JSON.parse(await readFile(join(runsDir, 'cos', `${id}.json`), 'utf8')).text).toBe('A plainly fake drafted answer.');
  expect(spawn).toHaveBeenCalledTimes(1);
});
it('treats a pre-claim block as ok and keeps READY', async () => {
  const spawn = runner();
  const result = await tick(true, spawn, []);
  expect(result.step).toMatchObject({ state: 'ok', exitCode: 0, report: { outcome: 'blocked' } });
  expect(result.code).toBe(0);
  expect(await status()).toBe('READY');
  expect(spawn).not.toHaveBeenCalled();
});
it('keeps a post-claim block failed', async () => {
  const result = await tick(true, runner(1));
  expect(result.code).toBe(1);
  expect(result.step).toMatchObject({ state: 'failed', report: { outcome: 'blocked' } });
  expect(await status()).toBe('BLOCKED');
});
it('records a throwing cos step and completes the run', async () => {
  const result = await tick(true, runner(), candidates, { 'cos-work': async () => { throw new Error('fake failure'); } });
  expect(result.code).toBe(1);
  expect(result.report.state).toBe('ran');
  expect(result.step).toMatchObject({ state: 'failed', exitCode: 1 });
  expect(readSelfTickLast(runsDir, now())).toMatchObject({ state: 'ok', failedSteps: ['cos-work'] });
});
it('reads an old six-step record', async () => {
  await writeFile(join(runsDir, 'queue', 'self-tick-last.json'), JSON.stringify({
    v: 1, at: new Date(now()).toISOString(), mode: 'apply', state: 'ran',
    steps: SELF_TICK_STEP_ORDER.slice(0, 6).map(step => ({ step, state: 'ok', exitCode: 0, report: {} })),
  }));
  expect(readSelfTickLast(runsDir, now())).toMatchObject({ state: 'ok', failedSteps: [] });
});
it('keeps bare cos-work read-only and rejects relative roots', async () => {
  const spawn = runner(), output = vi.fn(), error = vi.fn();
  expect(await cmdFleetCosWork(['--runs-dir', runsDir, '--json'], { spawn, output })).toBe(0);
  expect(JSON.parse(output.mock.calls[0]![0])).toMatchObject({ mode: 'dry-run', pending: 1 });
  expect(await cmdFleetCosWork(['--runs-dir', 'relative'], { error })).toBe(2);
  expect(spawn).not.toHaveBeenCalled();
  expect(await status()).toBe('READY');
});
