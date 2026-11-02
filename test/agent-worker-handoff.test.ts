import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { runWorkerHandoff } from '../examples/agents/worker-handoff.js';
import { getFleetJobDetail, type FleetJobDetailV1 } from '../src/core/fleet/runs-job-detail.js';
import { getFleetJobChanges, type FleetJobChangesV1 } from '../src/core/fleet/runs-job-changes.js';

const job = 'RQ-FAKE-JOB';
const now = () => new Date('2026-01-01T00:00:00Z');
const args = (budget = 8192) => ['--job', job, '--byte-budget', String(budget)];
const detail = (): FleetJobDetailV1 => ({
  schema: 'fleet.job.v1', generatedAt: now().toISOString(), job, state: 'running',
  lane: null, tier: null, model: null, pid: null, launchedAt: null, baseSha: null,
  branch: null, promptBytes: null, publish: null,
  notes: { hasNotes: false, hasBody: false, notesBytes: null },
  log: { source: 'live', bytes: 12, tail: ['work started', 'work finished'], truncated: false },
  sources: { launch: 'healthy', base: 'healthy', meta: 'missing', publish: 'missing', log: 'healthy' },
});
const changes = (): FleetJobChangesV1 => ({
  schema: 'fleet.job.changes.v1', generatedAt: now().toISOString(), job, state: 'live', baseSha: 'abcdef1',
  files: [{ path: 'src/example.ts', status: 'modified', added: 2, removed: 1 }],
  totals: { files: 1, added: 2, removed: 1 }, truncated: false,
});
async function run(d: FleetJobDetailV1, c: FleetJobChangesV1, budget = 8192) {
  let output = '';
  const code = await runWorkerHandoff(args(budget), {
    readDetail: async () => d, readChanges: async () => c, now, write: text => { output += text; },
  });
  return { code, output, value: JSON.parse(output) };
}

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

describe('worker handoff workflow', () => {
  it('composes and cites a live job and changed files', async () => {
    const { code, value } = await run(detail(), changes());
    expect(code).toBe(0);
    expect(value).toMatchObject({ schema: 'fleet.worker-handoff.v1', job, state: 'running',
      sources: { log: 'healthy', changes: 'live' },
      changes: { citation: { job, source: 'fleet.job.changes.v1' }, totals: { files: 1 }, omittedFiles: 0 },
      log: { citation: { job, source: `${job}.log` }, context: { jobId: job, kind: 'output', text: 'work started\nwork finished', truncated: false } },
    });
  });

  it('uses the actual readers for an archived job with scrubbed, cited log data', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'worker-handoff-')); dirs.push(dir);
    await writeFile(join(dir, `${job}.log.gz`), gzipSync('before\napi_key=fake-secret\nafter\n'));
    let output = '';
    const code = await runWorkerHandoff(args(), {
      readDetail: id => getFleetJobDetail(id, { runsDir: dir, now }),
      readChanges: id => getFleetJobChanges(id, { runsDir: dir, homeDir: dir }),
      now, write: text => { output += text; },
    });
    const value = JSON.parse(output);
    expect(code).toBe(0);
    expect(value).toMatchObject({ state: 'archived', publishUrl: null,
      changes: { totals: null }, log: { citation: { job, source: `${job}.log.gz` }, context: { jobId: job } } });
    expect(value.log.context.text).toContain('after');
    expect(output).not.toContain('fake-secret');
  });

  it('keeps Unicode, JSON escaping and newline inside the budget while retaining the end of the log', async () => {
    const d = detail();
    d.log.tail = [`${'😀\\"漢'.repeat(1500)} END`]; d.log.truncated = true;
    const c = changes(); c.files = Array.from({ length: 100 }, (_, i) => ({ path: `file-${i}-${'界'.repeat(30)}`, status: 'added', added: 1, removed: 0 }));
    c.truncated = true;
    const { output, value } = await run(d, c, 2048);
    expect(Buffer.byteLength(output)).toBeLessThanOrEqual(2048);
    expect(value.log.context.text.endsWith(' END')).toBe(true);
    expect(value.log.context.truncated).toBe(true);
    expect(value.log.sourceTruncated).toBe(true);
    expect(value.changes.sourceTruncated).toBe(true);
    expect(value.changes.omittedFiles).toBeGreaterThan(0);
    expect(value.changes.files.length).toBeGreaterThan(0);
    expect(value.log.context.text).not.toContain('\ufffd');
  });

  it('preserves publish URL and reports missing changes as unknown when log is unavailable', async () => {
    const d = detail(); d.state = 'published'; d.publish = { prUrl: 'https://example.invalid/pull/9', autoMerge: null, testLine: null, sensitive: null };
    d.log = { source: 'missing', bytes: null, tail: [], truncated: false }; d.sources.log = 'missing';
    const c = changes(); c.state = 'missing'; c.files = []; c.totals = { files: 0, added: 0, removed: 0 };
    const { value } = await run(d, c);
    expect(value.publishUrl).toBe('https://example.invalid/pull/9');
    expect(value.changes.totals).toBeNull();
    expect(value.log).toMatchObject({ citation: { source: null }, context: null, omitted: false });
  });

  it('reports omitted log text, degraded sources and unknown evidence honestly', async () => {
    const d = detail(); d.log.tail = ['   ']; d.sources.log = 'degraded';
    const c = changes(); c.state = 'degraded'; c.comparisonBase = 'HEAD';
    const { code, value } = await run(d, c);
    expect(code).toBe(4);
    expect(value.log.omitted).toBe(true);
    expect(value.changes.comparisonBase).toBe('HEAD');
    const missing = detail(); missing.sources = { launch: 'missing', base: 'missing', meta: 'missing', publish: 'missing', log: 'missing' };
    missing.log = { source: 'missing', bytes: null, tail: [], truncated: false };
    c.state = 'missing';
    expect((await run(missing, c)).code).toBe(3);
  });

  it('cites the output even when the job is named handoff', async () => {
    const d = detail(); d.job = 'handoff';
    const c = changes(); c.job = 'handoff';
    let output = '';
    const code = await runWorkerHandoff(['--job', 'handoff', '--byte-budget', '8192'], {
      readDetail: async () => d, readChanges: async () => c, now, write: text => { output += text; },
    });
    expect(code).toBe(0);
    expect(JSON.parse(output).log.context).toMatchObject({ jobId: 'handoff', text: 'work started\nwork finished' });
  });

  it('rejects invalid options and reader failures with generic JSON errors', async () => {
    const write = vi.fn(); const readDetail = vi.fn(async () => { throw new Error('/private/secret'); });
    expect(await runWorkerHandoff(['--job', job, '--byte-budget', '1'], { write, readDetail })).toBe(2);
    expect(readDetail).not.toHaveBeenCalled();
    expect(await runWorkerHandoff(args(), { write, readDetail, readChanges: async () => changes() })).toBe(1);
    expect(write.mock.calls.at(-1)?.[0]).not.toContain('/private/secret');
    expect(JSON.parse(write.mock.calls.at(-1)![0]).error).toBeTruthy();
  });

  it('stops waiting on deadline or signal and cancels its timer', async () => {
    const never = () => new Promise<never>(() => {});
    const write = vi.fn();
    expect(await runWorkerHandoff(args(), { write, readDetail: never, readChanges: never, wait: async () => {} })).toBe(1);
    const controller = new AbortController();
    let timerSignal: AbortSignal | undefined;
    const running = runWorkerHandoff(args(), { write, readDetail: never, readChanges: never, signal: controller.signal,
      wait: async (_ms, signal) => { timerSignal = signal; return new Promise<void>(() => {}); } });
    controller.abort();
    expect(await running).toBe(130);
    expect(timerSignal?.aborted).toBe(true);
  });
});
