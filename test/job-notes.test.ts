import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cmdJob } from '../src/cli/job.js';
import { readJobNotes, sayToJob, type JobNoteOptions } from '../src/core/fleet/job-notes.js';
import { JOB_NOTES_FILE, VERSE_FLEET_RUNS_NOTES_PATH as PATH, jobNotesLines, jobSayText } from '../src/core/fleet/job-notes-types.js';
import { createFleetRunsApi } from '../src/core/verse/fleet-runs-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

// The CLI has no injection seam, so its process-table read is replaced here:
// tests never read the real `ps`. Every other test injects `running` and `state`.
vi.mock('../src/core/fleet/runs-live-workers.js', () => ({
  listLiveWorkers: async () => ({ v: 1, generatedAt: 'unused', sourceState: 'healthy', workers: [{ pid: 1, job: 'RQ-LIVE', repo: 'repo', lane: 'claude', tier: 'mid', ageSeconds: 5 }], leaders: [], orchestratorAgents: 0 }),
}));

const LIVE = 'RQ-LIVE';
const QUEUED = 'RQ-QUEUED';
const DONE = 'RQ-DONE';
let dir: string;
let opts: JobNoteOptions;
let clock: number;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'job-notes-'));
  await mkdir(join(dir, 'queue'), { recursive: true });
  await writeFile(join(dir, 'queue', 'ready.tsv'), `${QUEUED}\tphantom\tclaude\twork\t${dir}/p.md\n`);
  clock = Date.parse('2026-11-01T00:00:00Z');
  opts = {
    runsDir: dir, by: 'test', now: () => (clock += 60_000),
    running: async () => [LIVE],
    state: async (job) => (job === DONE ? 'finished' : 'unknown'),
  };
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

const file = async (): Promise<Array<Record<string, unknown>>> =>
  (await readFile(join(dir, JOB_NOTES_FILE), 'utf8').catch(() => '')).split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);

it('appends timestamped notes in stable JSON, for running and queued jobs', async () => {
  const first = await sayToJob(LIVE, '  also update\nthe docs  ', opts);
  expect(JSON.stringify(first)).toBe(
    '{"schema":"fleet.job.say.v1","job":"RQ-LIVE","status":"sent","reason":null,' +
    '"note":{"id":"n-1","at":"2026-11-01T00:01:00.000Z","text":"also update the docs","by":"test"},"dryRun":false,"duplicate":false}');
  expect(await sayToJob(LIVE, 'skip the phone view', opts)).toMatchObject({ status: 'sent', note: { id: 'n-2' } });
  expect(await sayToJob(QUEUED, 'start with the tests', opts)).toMatchObject({ status: 'sent', note: { id: 'n-1' } });
  expect(await file()).toEqual([
    { schema: 'fleet.job.say.v1', job: LIVE, id: 'n-1', at: '2026-11-01T00:01:00.000Z', text: 'also update the docs', by: 'test' },
    { schema: 'fleet.job.say.v1', job: LIVE, id: 'n-2', at: '2026-11-01T00:02:00.000Z', text: 'skip the phone view', by: 'test' },
    { schema: 'fleet.job.say.v1', job: QUEUED, id: 'n-1', at: '2026-11-01T00:03:00.000Z', text: 'start with the tests', by: 'test' },
  ]);
});

it('lists a job\'s notes oldest first and counts them', async () => {
  expect(await readJobNotes(LIVE, { runsDir: dir })).toEqual({ schema: 'fleet.job.notes.v1', job: LIVE, count: 0, notes: [] });
  await sayToJob(LIVE, 'one', opts);
  await sayToJob(QUEUED, 'other job', opts);
  await sayToJob(LIVE, 'two', opts);
  const read = await readJobNotes(LIVE, { runsDir: dir });
  expect(read).toMatchObject({ schema: 'fleet.job.notes.v1', job: LIVE, count: 2 });
  expect(read.notes.map((n) => n.text)).toEqual(['one', 'two']);
  expect(jobNotesLines(read.notes)).toEqual(['2026-11-01 00:01 · one', '2026-11-01 00:03 · two']);
});

it('refuses a note for a finished job in plain words and records nothing', async () => {
  const receipt = await sayToJob(DONE, 'too late', opts);
  expect(receipt).toMatchObject({ status: 'refused', reason: 'Job RQ-DONE has finished, so it cannot read a note.', note: null });
  expect(jobSayText(receipt)).toBe('Job RQ-DONE has finished, so it cannot read a note.');
  expect(await sayToJob('RQ-NOBODY', 'hello', opts)).toMatchObject({ status: 'unknown', note: null });
  expect(await file()).toEqual([]);
});

it('keeps a job that finished after taking notes known, and still refuses', async () => {
  await sayToJob(LIVE, 'early', opts);
  const ended = await sayToJob(LIVE, 'late', { ...opts, running: async () => [], state: async () => 'unknown' });
  expect(ended.status).toBe('refused');
  expect(await file()).toHaveLength(1);
});

it('sends the same text once, supports a dry run, and rejects empty or long text', async () => {
  await sayToJob(LIVE, 'again', opts);
  const repeat = await sayToJob(LIVE, 'again', opts);
  expect(repeat).toMatchObject({ status: 'sent', duplicate: true, note: { id: 'n-1' } });
  expect(jobSayText(repeat)).toBe('Already sent to RQ-LIVE.');
  const dry = await sayToJob(LIVE, 'maybe', { ...opts, dryRun: true });
  expect(dry).toMatchObject({ status: 'sent', dryRun: true, note: { id: 'n-2' } });
  expect(jobSayText(dry)).toBe('Dry run, nothing changed. Note sent to RQ-LIVE.');
  expect(await file()).toHaveLength(1);
  await expect(sayToJob(LIVE, '   ', opts)).rejects.toThrow('note is empty');
  await expect(sayToJob(LIVE, 'x'.repeat(501), opts)).rejects.toThrow('longer than 500');
  await expect(sayToJob('bad id', 'hi', opts)).rejects.toThrow(TypeError);
});

it('scrubs secrets out of a note before it is written', async () => {
  const receipt = await sayToJob(LIVE, 'use password=hunter2value for the db', opts);
  expect(receipt.note?.text).not.toContain('hunter2value');
  expect(JSON.stringify(await file())).not.toContain('hunter2value');
});

it('skips damaged lines when reading', async () => {
  await writeFile(join(dir, JOB_NOTES_FILE), `not json\n${JSON.stringify({ job: LIVE, id: 'n-1', at: '2026-11-01T00:00:00Z', text: 'kept' })}\n{"job":"${LIVE}"}\n`);
  expect((await readJobNotes(LIVE, { runsDir: dir })).notes).toMatchObject([{ id: 'n-1', text: 'kept', by: 'unknown' }]);
});

async function run(args: string[]) {
  const out: string[] = [], err: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((line: unknown) => { out.push(String(line)); });
  vi.spyOn(console, 'error').mockImplementation((line: unknown) => { err.push(String(line)); });
  const code = await cmdJob(args);
  vi.restoreAllMocks();
  return { code, out: out.join('\n'), err: err.join('\n') };
}

it('phm job say and notes: text, --json, exit codes and usage', async () => {
  const said = await run(['say', LIVE, 'also update the docs', '--json', '--runs-dir', dir]);
  expect(said.code).toBe(0);
  expect(JSON.parse(said.out)).toMatchObject({ schema: 'fleet.job.say.v1', job: LIVE, status: 'sent', note: { by: 'cli', text: 'also update the docs' } });
  expect(await run(['say', LIVE, 'again please', '--runs-dir', dir])).toMatchObject({ code: 0, out: 'Note sent to RQ-LIVE.' });
  const listed = await run(['notes', LIVE, '--runs-dir', dir]);
  expect(listed.code).toBe(0);
  expect(listed.out).toContain('Notes sent to RQ-LIVE (2):');
  expect(listed.out).toContain('also update the docs');
  expect(JSON.parse((await run(['notes', LIVE, '--json', '--runs-dir', dir])).out)).toMatchObject({ schema: 'fleet.job.notes.v1', count: 2 });
  expect(await run(['notes', QUEUED, '--runs-dir', dir])).toMatchObject({ code: 0, out: `No notes sent to ${QUEUED}.` });
  // The mocked process table has only RQ-LIVE and no run files exist here, so any other id is unknown.
  expect(await run(['say', 'RQ-NOBODY', 'hello', '--runs-dir', dir])).toMatchObject({ code: 1, out: 'No job RQ-NOBODY found.' });
  expect(await run(['say', LIVE])).toMatchObject({ code: 2, err: expect.stringContaining('Say what?') });
  expect(await run(['say', LIVE, '   ', '--runs-dir', dir])).toMatchObject({ code: 2, err: expect.stringContaining('Note is empty.') });
  expect((await run(['say'])).code).toBe(2);
  expect((await run(['say', LIVE, 'a', '--json', '--json'])).code).toBe(2);
  expect((await run(['notes', LIVE, 'extra'])).code).toBe(2);
  expect((await run(['say', LIVE, 'a', '--runs-dir', 'relative'])).code).toBe(2);
  expect((await run(['say', '--help'])).out).toContain('fleet.job.say.v1');
  expect(await file()).toHaveLength(2);
});

async function call(api: ReturnType<typeof createFleetRunsApi>, method: string, body?: unknown, url = PATH, token = 'fixture-token') {
  const req = new PassThrough() as IncomingMessage & PassThrough;
  Object.assign(req, { method, url, headers: { 'content-type': 'application/json', 'x-ashlr-token': token, 'x-ashlr-channel': 'mobile' } });
  req.end(body === undefined ? undefined : JSON.stringify(body));
  let status = 0, payload = '';
  const res = { writeHead(code: number) { status = code; return this; }, end(chunk?: string) { payload = chunk ?? ''; return this; } } as unknown as ServerResponse;
  await api({ token: 'fixture-token', allowDispatch: true } as VerseApiContext, req, res, PATH, method);
  return { status, body: payload ? JSON.parse(payload) as Record<string, unknown> : null };
}

it('runs/notes: POST answers every receipt with 200, GET lists, bad bodies are 400', async () => {
  const api = createFleetRunsApi({ runsDir: dir, jobSay: (job, text, o) => sayToJob(job, text, { ...opts, ...o }) });
  expect(await call(api, 'POST', { id: LIVE, text: 'skip the phone view' })).toMatchObject({ status: 200, body: { status: 'sent', note: { by: 'mobile' } } });
  expect(await call(api, 'POST', { id: DONE, text: 'late' })).toMatchObject({ status: 200, body: { status: 'refused' } });
  expect(await call(api, 'GET', undefined, `${PATH}?id=${LIVE}`)).toMatchObject({ status: 200, body: { schema: 'fleet.job.notes.v1', count: 1 } });
  for (const body of [{ id: LIVE }, { id: LIVE, text: 5 }, { id: 'bad id', text: 'x' }, { id: LIVE, text: 'x', extra: 1 }, { id: LIVE, text: '   ' }, { id: LIVE, text: 'x'.repeat(501) }]) {
    expect((await call(api, 'POST', body)).status).toBe(400);
  }
  expect((await call(api, 'GET', undefined, `${PATH}?id=bad%20id`)).status).toBe(400);
  expect((await call(api, 'PUT', { id: LIVE, text: 'x' })).status).toBe(405);
  expect((await call(api, 'POST', { id: LIVE, text: 'x' }, PATH, 'wrong-token')).status).not.toBe(200);
  const broken = createFleetRunsApi({ runsDir: dir, jobSay: async () => { throw new Error('disk'); } });
  expect(await call(broken, 'POST', { id: LIVE, text: 'x' })).toEqual({ status: 503, body: { code: 'JOB_NOTES_UNAVAILABLE' } });
  expect(await file()).toHaveLength(1);
});
