import { mkdtemp, mkdir, readFile, rm, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cmdJob } from '../src/cli/job.js';
import { cmdJobs } from '../src/cli/jobs-empty.js';
import { requestJobControl, type JobControlOptions } from '../src/core/fleet/job-control.js';
import { JOB_CONTROL_FILE, VERSE_FLEET_RUNS_CONTROL_PATH as PATH } from '../src/core/fleet/job-control-types.js';
import { createFleetRunsApi } from '../src/core/verse/fleet-runs-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

// The CLI has no injection seam, so its process-table read is replaced here:
// tests never read the real `ps`. Every other test injects `workers`.
vi.mock('../src/core/fleet/runs-live-workers.js', () => ({
  listLiveWorkers: async () => ({ v: 1, generatedAt: 'unused', sourceState: 'healthy', workers: [], leaders: [], orchestratorAgents: 0 }),
}));

const LIVE = 'RQ-PHX-LIVE01';
const QUEUED = 'RQ-PHX-QUEUED02';
const worker = (job: string, lane: string, pid: number) => ({ pid, job, repo: 'fake-repo', lane, tier: 'mid', ageSeconds: 60 });
// codex-local is full: 1 running of target 1. devin is held. claude has room.
const workers = async () => [worker(LIVE, 'codex-personal', 111), worker('RQ-PHX-OTHER03', 'codex-local', 222)];
const slots = { lanes: {
  'codex-personal': { target: 2, floor: 0, ceiling: 4 },
  'codex-local': { target: 1, floor: 0, ceiling: 2 },
  claude: { target: 2, floor: 0, ceiling: 3 },
  devin: { target: 0, floor: 0, ceiling: 6, held: true, held_reason: 'fake hold' },
} };

let dir: string;
let stopJob: ReturnType<typeof vi.fn>;
let opts: JobControlOptions;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'job-control-'));
  await mkdir(join(dir, 'queue', 'prompts'), { recursive: true });
  await writeFile(join(dir, 'queue', 'slots.json'), JSON.stringify(slots));
  await writeFile(join(dir, 'queue', 'ready.tsv'), `${QUEUED}\tphantom\tcodex-personal\twork\t${dir}/queue/prompts/${QUEUED}.md\n`);
  stopJob = vi.fn(async (id: string) => ({ id, pids: [111], outcome: 'stopped' as const, at: 'unused' }));
  opts = { runsDir: dir, now: () => Date.parse('2026-11-01T00:00:00Z'), by: 'test', workers, stopJob };
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

const ledger = async (): Promise<Array<Record<string, unknown>>> => {
  const text = await readFile(join(dir, JOB_CONTROL_FILE), 'utf8').catch(() => '');
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
};

it('records pause and resume as requests for the dispatcher, in stable JSON', async () => {
  const pause = await requestJobControl({ action: 'pause', job: LIVE }, opts);
  expect(JSON.stringify(pause)).toBe(
    `{"schema":"fleet.job.control.v1","action":"pause","job":"${LIVE}","lane":null,"status":"requested","reason":null,` +
    `"requestId":"${pause.requestId}","at":"2026-11-01T00:00:00.000Z","dryRun":false,"duplicate":false}`);
  expect(pause.requestId).toMatch(/^jc-[0-9a-f]{12}$/);
  const resume = await requestJobControl({ action: 'resume', job: LIVE }, opts);
  expect(resume).toMatchObject({ action: 'resume', status: 'requested', duplicate: false });
  expect(await ledger()).toEqual([
    { schema: 'fleet.job.control.v1', requestId: pause.requestId, at: pause.at, action: 'pause', job: LIVE, lane: null, status: 'requested', by: 'test' },
    { schema: 'fleet.job.control.v1', requestId: resume.requestId, at: resume.at, action: 'resume', job: LIVE, lane: null, status: 'requested', by: 'test' },
  ]);
});

it('refuses a resume of a job that is not paused and a pause of a job that has not started', async () => {
  expect(await requestJobControl({ action: 'resume', job: LIVE }, opts)).toMatchObject({ status: 'refused', reason: 'Job is not paused.', requestId: null });
  expect(await requestJobControl({ action: 'pause', job: QUEUED }, opts)).toMatchObject({ status: 'refused', reason: 'Job has not started yet.' });
  expect(await ledger()).toEqual([]);
});

it('stops a live job through the existing stop, recorded before the signal', async () => {
  stopJob.mockImplementation(async (id: string) => {
    expect(await ledger()).toHaveLength(1);
    return { id, pids: [111], outcome: 'stopped' as const, at: 'unused' };
  });
  const stop = await requestJobControl({ action: 'stop', job: LIVE }, opts);
  expect(stop).toMatchObject({ action: 'stop', status: 'applied', reason: null });
  expect(stopJob).toHaveBeenCalledWith(LIVE, { runsDir: dir, by: 'test' });
  expect(await ledger()).toMatchObject([{ requestId: stop.requestId, action: 'stop', status: 'applied' }]);
  // A queued job has no process to signal: the dispatcher drops it.
  expect(await requestJobControl({ action: 'stop', job: QUEUED }, opts)).toMatchObject({ status: 'requested' });
  expect(stopJob).toHaveBeenCalledTimes(1);
});

it('takes the applied stop back when the signal fails', async () => {
  stopJob.mockRejectedValue(Object.assign(new Error('not permitted'), { code: 'EPERM' }));
  await expect(requestJobControl({ action: 'stop', job: LIVE }, opts)).rejects.toThrow('not permitted');
  expect(await ledger()).toMatchObject([{ action: 'stop', status: 'applied' }, { status: 'refused', reason: 'Phantom could not signal the job.' }]);
});

it('requests a move of a live job and moves a queued job at once', async () => {
  const live = await requestJobControl({ action: 'move', job: LIVE, lane: 'claude' }, opts);
  expect(live).toMatchObject({ action: 'move', lane: 'claude', status: 'requested' });
  const queued = await requestJobControl({ action: 'move', job: QUEUED, lane: 'claude' }, { ...opts, by: undefined });
  expect(queued).toMatchObject({ lane: 'claude', status: 'applied' });
  expect(await readFile(join(dir, 'queue', 'ready.tsv'), 'utf8')).toContain(`${QUEUED}\tphantom\tclaude\twork\t`);
  expect(await ledger()).toMatchObject([{ job: LIVE, lane: 'claude', status: 'requested' }, { job: QUEUED, lane: 'claude', status: 'applied', by: 'phantom' }]);
});

it('refuses a move to a held, full, unknown or current lane and records nothing', async () => {
  const move = (lane: string) => requestJobControl({ action: 'move', job: LIVE, lane }, opts);
  expect(await move('devin')).toMatchObject({ status: 'refused', reason: 'Lane devin is held.', requestId: null });
  expect(await move('codex-local')).toMatchObject({ status: 'refused', reason: 'Lane codex-local is full (1 of 1 running).' });
  expect(await move('no-such-lane')).toMatchObject({ status: 'refused', reason: 'Lane no-such-lane does not exist.' });
  expect(await move('codex-personal')).toMatchObject({ status: 'refused', reason: 'Job is already on lane codex-personal.' });
  expect(await ledger()).toEqual([]);
  await expect(requestJobControl({ action: 'move', job: LIVE }, opts)).rejects.toThrow(TypeError);
  await expect(requestJobControl({ action: 'pause', job: 'bad id' }, opts)).rejects.toThrow(TypeError);
});

it('writes a repeated request once and reads back the dispatcher acknowledgement', async () => {
  const first = await requestJobControl({ action: 'pause', job: LIVE }, opts);
  const again = await requestJobControl({ action: 'pause', job: LIVE }, { ...opts, now: () => Date.parse('2026-11-01T01:00:00Z') });
  expect(again).toEqual({ ...first, duplicate: true });
  expect(await ledger()).toHaveLength(1);
  // The dispatcher answers by appending the same requestId with its status.
  await appendFile(join(dir, JOB_CONTROL_FILE), `${JSON.stringify({ schema: 'fleet.job.control.v1', requestId: first.requestId, status: 'applied', at: '2026-11-01T00:00:05.000Z' })}\nnot json\n`);
  expect(await requestJobControl({ action: 'pause', job: LIVE }, opts)).toMatchObject({ status: 'applied', duplicate: true, requestId: first.requestId });
  // A request the dispatcher refused no longer stands: asking again is a new request.
  const move = await requestJobControl({ action: 'move', job: LIVE, lane: 'claude' }, opts);
  await appendFile(join(dir, JOB_CONTROL_FILE), `${JSON.stringify({ requestId: move.requestId, status: 'refused', reason: 'lane went down' })}\n`);
  const retry = await requestJobControl({ action: 'move', job: LIVE, lane: 'claude' }, opts);
  expect(retry).toMatchObject({ status: 'requested', duplicate: false });
  expect(retry.requestId).not.toBe(move.requestId);
});

it('answers unknown for a job nobody has seen, and not running for one that is gone', async () => {
  expect(await requestJobControl({ action: 'stop', job: 'RQ-PHX-NOBODY99' }, opts)).toMatchObject({ status: 'unknown', reason: null, requestId: null });
  expect(await ledger()).toEqual([]);
  const stop = await requestJobControl({ action: 'stop', job: LIVE }, opts);
  const gone = { ...opts, workers: async () => [] };
  expect(await requestJobControl({ action: 'stop', job: LIVE }, gone)).toMatchObject({ status: 'applied', duplicate: true, requestId: stop.requestId });
  expect(await requestJobControl({ action: 'pause', job: LIVE }, gone)).toMatchObject({ status: 'refused', reason: 'Job is not running.' });
  // The same id running again (a retry) can be stopped again.
  expect(await requestJobControl({ action: 'stop', job: LIVE }, opts)).toMatchObject({ status: 'applied', duplicate: false });
  expect(stopJob).toHaveBeenCalledTimes(2);
});

it('dry run predicts the receipt and changes nothing', async () => {
  const before = await readFile(join(dir, 'queue', 'ready.tsv'), 'utf8');
  expect(await requestJobControl({ action: 'stop', job: LIVE, dryRun: true }, opts)).toMatchObject({ status: 'applied', dryRun: true, requestId: null });
  expect(await requestJobControl({ action: 'pause', job: LIVE, dryRun: true }, opts)).toMatchObject({ status: 'requested', dryRun: true });
  expect(await requestJobControl({ action: 'move', job: QUEUED, lane: 'claude', dryRun: true }, opts)).toMatchObject({ status: 'applied', dryRun: true });
  expect(await requestJobControl({ action: 'move', job: LIVE, lane: 'devin', dryRun: true }, opts)).toMatchObject({ status: 'refused', dryRun: true });
  expect(stopJob).not.toHaveBeenCalled();
  expect(await ledger()).toEqual([]);
  expect(await readFile(join(dir, 'queue', 'ready.tsv'), 'utf8')).toBe(before);
});

it('phm job: prints the receipt and exits 0, 1 or 2', async () => {
  const out = vi.spyOn(console, 'log').mockImplementation(() => {});
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(await cmdJob(['move', QUEUED, '--lane', 'claude', '--dry-run', '--json', '--runs-dir', dir])).toBe(0);
  expect(JSON.parse(String(out.mock.calls.at(-1)?.[0]))).toMatchObject({ schema: 'fleet.job.control.v1', action: 'move', job: QUEUED, lane: 'claude', status: 'applied', dryRun: true });
  expect(await cmdJob(['stop', QUEUED, '--runs-dir', dir])).toBe(0);
  expect(out.mock.calls.at(-1)?.[0]).toBe(`Stop requested for ${QUEUED}.`);
  expect(await cmdJob(['move', QUEUED, '--lane', 'devin', '--runs-dir', dir])).toBe(1);
  expect(out.mock.calls.at(-1)?.[0]).toBe('Lane devin is held.');
  expect(await cmdJob(['pause', 'RQ-PHX-NOBODY99', '--runs-dir', dir])).toBe(1);
  expect(out.mock.calls.at(-1)?.[0]).toBe('No job RQ-PHX-NOBODY99 found.');
  for (const args of [['move', QUEUED], ['pause', QUEUED, '--lane', 'claude'], ['stop'], ['stop', QUEUED, '--json', '--json'], ['stop', QUEUED, '--runs-dir', 'relative'], ['stop', QUEUED, '--nope']]) {
    expect(await cmdJob(args)).toBe(2);
  }
  expect(await cmdJob(['pause', '--help'])).toBe(0);
  expect(err).toHaveBeenCalled();
  expect(await ledger()).toHaveLength(1);
});

it('phm jobs: every action works under the plural verb with the same receipt', async () => {
  const out = vi.spyOn(console, 'log').mockImplementation(() => {});
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  const json = () => JSON.parse(String(out.mock.calls.at(-1)?.[0])) as Record<string, unknown>;
  expect(await cmdJobs(['move', QUEUED, '--lane', 'claude', '--dry-run', '--json', '--runs-dir', dir])).toBe(0);
  expect(json()).toMatchObject({ schema: 'fleet.job.control.v1', action: 'move', job: QUEUED, lane: 'claude', status: 'applied', dryRun: true });
  expect(await cmdJobs(['pause', QUEUED, '--dry-run', '--json', '--runs-dir', dir])).toBe(1);
  expect(json()).toMatchObject({ action: 'pause', job: QUEUED, status: 'refused' });
  expect(await cmdJobs(['resume', QUEUED, '--json', '--runs-dir', dir])).toBe(1);
  expect(json()).toMatchObject({ action: 'resume', status: 'refused', reason: 'Job is not paused.' });
  expect(await cmdJobs(['stop', QUEUED, '--runs-dir', dir])).toBe(0);
  expect(out.mock.calls.at(-1)?.[0]).toBe(`Stop requested for ${QUEUED}.`);
  expect(await cmdJobs(['pause', 'RQ-PHX-NOBODY99', '--json', '--runs-dir', dir])).toBe(1);
  expect(json()).toMatchObject({ schema: 'fleet.job.control.v1', job: 'RQ-PHX-NOBODY99', status: 'unknown' });
  expect(await cmdJobs(['pause', 'RQ-PHX-NOBODY99', '--runs-dir', dir])).toBe(1);
  expect(out.mock.calls.at(-1)?.[0]).toBe('No job RQ-PHX-NOBODY99 found.');
  expect(await cmdJobs(['move', QUEUED])).toBe(2);
  expect(String(err.mock.calls.at(-1)?.[0])).toContain('phm jobs pause|resume|stop|move');
  expect(await cmdJobs(['--help'])).toBe(0);
  expect(String(out.mock.calls.at(-1)?.[0])).toContain('phm jobs pause|resume|stop|move');
});

async function post(api: ReturnType<typeof createFleetRunsApi>, body: unknown, method = 'POST', token = 'fixture-token') {
  const req = new PassThrough() as IncomingMessage & PassThrough;
  Object.assign(req, { method, url: PATH, headers: { 'content-type': 'application/json', 'x-ashlr-token': token, 'x-ashlr-channel': 'mobile' } });
  req.end(JSON.stringify(body));
  let status = 0, payload = '';
  const res = { writeHead(code: number) { status = code; return this; }, end(chunk?: string) { payload = chunk ?? ''; return this; } } as unknown as ServerResponse;
  await api({ token: 'fixture-token', allowDispatch: true } as VerseApiContext, req, res, PATH, method);
  return { status, body: payload ? JSON.parse(payload) as Record<string, unknown> : null };
}

it('POST runs/control: answers every receipt with 200 and guards the body, method and token', async () => {
  const jobControl = vi.fn(requestJobControl);
  const api = createFleetRunsApi({ runsDir: dir, jobControl: (request, o) => jobControl(request, { ...opts, ...o }) });
  const moved = await post(api, { id: LIVE, action: 'move', lane: 'devin' });
  expect(moved).toMatchObject({ status: 200, body: { status: 'refused', reason: 'Lane devin is held.' } });
  expect(jobControl.mock.calls[0]?.[1]).toMatchObject({ runsDir: dir, by: 'mobile' });
  expect(await post(api, { id: LIVE, action: 'pause' })).toMatchObject({ status: 200, body: { status: 'requested', job: LIVE } });
  for (const body of [{ id: LIVE }, { id: LIVE, action: 'kill' }, { id: 'bad id', action: 'stop' }, { id: LIVE, action: 'move' }, { id: LIVE, action: 'stop', lane: 'claude' }, { id: LIVE, action: 'stop', extra: 1 }, { id: LIVE, action: 'stop', dryRun: 'yes' }]) {
    expect((await post(api, body)).status).toBe(400);
  }
  expect((await post(api, { id: LIVE, action: 'stop' }, 'GET')).status).toBe(405);
  expect((await post(api, { id: LIVE, action: 'stop' }, 'POST', 'wrong-token')).status).not.toBe(200);
  const broken = createFleetRunsApi({ runsDir: dir, jobControl: async () => { throw new Error('disk'); } });
  expect(await post(broken, { id: LIVE, action: 'stop' })).toEqual({ status: 503, body: { code: 'JOB_CONTROL_UNAVAILABLE' } });
  expect(stopJob).not.toHaveBeenCalled();
});
