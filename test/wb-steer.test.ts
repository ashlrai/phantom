/**
 * wb steer verbs — the three new POST /api/wb/v1/action actions and their
 * `phm wb` CLI twins, sharing core/workbench/steer.ts so a refusal or a
 * write is identical from either surface. The parity cases pin that:
 * same request in, same normalized result out, whichever door it came in.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleWbAction } from '../src/core/web/wb-action-api.js';
import { QueueStore } from '../src/core/queue/store.js';
import { runSteerAction, SteerRefusedError } from '../src/core/workbench/steer.js';
import { cmdWb } from '../src/cli/wb.js';
import type { JobStopResult } from '../src/core/fleet/job-stop.js';

let root: string;
let nonce = 0;
const token = 'fixture-mutation-capability';
const JOB = 'RQ-STEER-FIXTURE-1';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wb-steer-'));
  await mkdir(join(root, 'queue'), { recursive: true });
  await new QueueStore(join(root, 'queue')).add({ id: JOB, status: 'READY', priority: 'P2', pool: 'devin', tier: 'mid', repo: 'phantom', deps: [], scope: 'fixture', acceptance: '', claims: [] });
});
afterEach(async () => { vi.unstubAllEnvs(); vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

async function request(body: unknown, deps?: Parameters<typeof handleWbAction>[3]['steerDeps']) {
  const req = Readable.from([JSON.stringify(body)]) as IncomingMessage;
  req.method = 'POST';
  req.headers = { 'x-ashlr-token': token, 'content-type': 'application/json' };
  let status = 0;
  let payload = '';
  const res = { writeHead(code: number) { status = code; }, end(text: string) { payload = text; } } as unknown as ServerResponse;
  await handleWbAction(req, res, { token, allowDispatch: true }, { directory: join(root, 'wb'), runsDir: root, steerDeps: deps });
  return { status, json: () => JSON.parse(payload), text: () => payload };
}
const body = (action: string, rest = {}) => ({ action, nonce: (++nonce).toString(16).padStart(32, '0'), ...rest });
const auditText = () => readFile(join(root, 'wb', 'audit.jsonl'), 'utf8').catch(() => '');
const inboxText = () => readFile(join(root, 'leader', 'MASON-INBOX.md'), 'utf8').catch(() => '');

/** One CLI invocation with stdout captured; ASHLR_RUNS_DIR points at the fixture. */
async function cli(args: string[]): Promise<{ code: number; json: unknown }> {
  vi.stubEnv('ASHLR_RUNS_DIR', root);
  const lines: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((line: string) => { lines.push(String(line)); });
  try {
    const code = await cmdWb([...args, '--json']);
    return { code, json: lines.length ? JSON.parse(lines.at(-1)!) : null };
  } finally { log.mockRestore(); }
}

describe('steer.note', () => {
  it('validates text strictly: absent, empty, oversized, secret-shaped, extra fields', async () => {
    const secret = 'sk-proj-' + 'x'.repeat(60);
    for (const input of [
      body('steer.note'), body('steer.note', { text: 7 }), body('steer.note', { text: '   ' }),
      body('steer.note', { text: 'x'.repeat(6001) }), body('steer.note', { text: `key is ${secret}` }),
      body('steer.note', { text: 'hi', job: 'x' }),
    ]) {
      const res = await request(input);
      expect(res.status, JSON.stringify(input)).toBe(400);
      expect(res.text()).not.toContain(secret);
    }
    expect(await auditText()).not.toContain(secret);
  });

  it('dry run plans without writing; apply appends on the workbench channel', async () => {
    const dry = await request(body('steer.note', { text: 'hold codex until the release lands' }));
    expect(dry.status).toBe(200);
    expect(dry.json()).toMatchObject({ v: 1, dryRun: true, outcome: 'accepted' });
    expect(existsSync(join(root, 'leader', 'MASON-INBOX.md'))).toBe(false);

    const applied = await request(body('steer.note', { text: 'hold codex until the release lands', dryRun: false }));
    expect(applied.status).toBe(200);
    const inbox = await inboxText();
    expect(inbox).toContain('[src:phantom-workbench id:phantom-workbench-');
    expect(inbox).toContain('hold codex until the release lands');
    expect(await auditText()).not.toContain('hold codex');
  });

  it('CLI twin reaches the same writer: identical dry run, identical applied entry', async () => {
    const text = 'hold the grok lane';
    const direct = await runSteerAction({ action: 'steer.note', text }, { runsDir: root });
    const cliRun = await cli(['steer', '--text', text]);
    const http = await request(body('steer.note', { text }));
    expect(cliRun.code).toBe(0);
    expect(cliRun.json).toMatchObject({ v: 1, dryRun: true, action: 'steer.note', outcome: 'accepted', bytes: (direct as { bytes: number }).bytes });
    expect(http.json()).toMatchObject({ outcome: 'accepted', count: (direct as { bytes: number }).bytes });
    expect(existsSync(join(root, 'leader', 'MASON-INBOX.md'))).toBe(false);
    const applied = await cli(['steer', '--text', text, '--apply']);
    expect(applied.code).toBe(0);
    expect(await inboxText()).toContain('hold the grok lane');
  });
});

describe('queue.reprioritize', () => {
  it('validates job and priority strictly', async () => {
    const secret = 'ghp_' + 'x'.repeat(50);
    for (const input of [
      body('queue.reprioritize'), body('queue.reprioritize', { job: JOB }), body('queue.reprioritize', { job: JOB, priority: 'P4' }),
      body('queue.reprioritize', { job: JOB, priority: 'p1' }), body('queue.reprioritize', { job: 'bad id!', priority: 'P1' }),
      body('queue.reprioritize', { job: secret, priority: 'P1' }), body('queue.reprioritize', { job: JOB, priority: 'P1', text: 'x' }),
    ]) {
      const res = await request(input);
      expect(res.status, JSON.stringify(input)).toBe(400);
      expect(res.text()).not.toContain(secret);
    }
    expect(await auditText()).not.toContain(secret);
  });

  it('re-priorities READY and HOLD lines only; dry run never writes', async () => {
    const store = new QueueStore(join(root, 'queue'));
    const dry = await request(body('queue.reprioritize', { job: JOB, priority: 'P0' }));
    expect(dry.status).toBe(200);
    expect(dry.json()).toMatchObject({ dryRun: true, outcome: 'P2>P0' });
    expect((await store.read()).jobs[0]!.priority).toBe('P2');

    const applied = await request(body('queue.reprioritize', { job: JOB, priority: 'P0', dryRun: false }));
    expect(applied.status).toBe(200);
    expect(applied.json()).toMatchObject({ dryRun: false, outcome: 'P2>P0' });
    expect((await store.read()).jobs[0]!.priority).toBe('P0');

    await store.hold(JOB, true);
    expect((await request(body('queue.reprioritize', { job: JOB, priority: 'P3', dryRun: false }))).status).toBe(200);
    expect((await store.read()).jobs[0]!.priority).toBe('P3');
  });

  it('refuses a claimed or unknown line like every other queue action', async () => {
    const store = new QueueStore(join(root, 'queue'));
    await store.claim(JOB, 'fixture');
    expect((await request(body('queue.reprioritize', { job: JOB, priority: 'P0', dryRun: false }))).status).toBe(503);
    expect((await request(body('queue.reprioritize', { job: 'RQ-NOPE-9', priority: 'P0', dryRun: false }))).status).toBe(503);
  });

  it('CLI twin reports the same from/to as the API', async () => {
    const cliRun = await cli(['reprioritize', JOB, '--priority', 'P1']);
    const http = await request(body('queue.reprioritize', { job: JOB, priority: 'P1' }));
    expect(cliRun.code).toBe(0);
    expect(cliRun.json).toMatchObject({ v: 1, dryRun: true, action: 'queue.reprioritize', job: JOB, from: 'P2', to: 'P1' });
    expect(http.json()).toMatchObject({ outcome: 'P2>P1' });
    const applied = await cli(['reprioritize', JOB, '--priority', 'P1', '--apply']);
    expect(applied.code).toBe(0);
    expect((await new QueueStore(join(root, 'queue')).read()).jobs[0]!.priority).toBe('P1');
    expect((await cli(['reprioritize', JOB, '--priority', 'P9'])).code).toBe(2);
    expect((await cli(['reprioritize', JOB])).code).toBe(2);
  });
});

describe('job.stop', () => {
  const deps = {
    findJobProcesses: async () => [101, 202],
    stopJob: async (id: string): Promise<JobStopResult> => ({ id, pids: [101, 202], outcome: 'stopped', at: '2026-11-10T00:00:00Z' }),
  };

  it('validates the id against the stray-worker shape', async () => {
    const secret = 'sk-' + 'x'.repeat(60);
    for (const input of [
      body('job.stop'), body('job.stop', { job: 'has space' }), body('job.stop', { job: '../etc' }),
      body('job.stop', { job: 'x'.repeat(81) }), body('job.stop', { job: secret }), body('job.stop', { job: JOB, priority: 'P1' }),
    ]) {
      const res = await request(input);
      expect(res.status, JSON.stringify(input)).toBe(400);
      expect(res.text()).not.toContain(secret);
    }
    expect(await auditText()).not.toContain(secret);
  });

  it('dry run plans over the injected process table; apply stops through the same writer', async () => {
    const calls: string[] = [];
    const dry = await request(body('job.stop', { job: JOB }), {
      ...deps,
      stopJob: async (id: string) => { calls.push(id); return deps.stopJob(id); },
    });
    expect(dry.status).toBe(200);
    expect(dry.json()).toMatchObject({ dryRun: true, outcome: 'planned', count: 2 });
    expect(calls).toEqual([]);

    const applied = await request(body('job.stop', { job: JOB, dryRun: false }), {
      ...deps,
      stopJob: async (id: string) => { calls.push(id); return deps.stopJob(id); },
    });
    expect(applied.status).toBe(200);
    expect(applied.json()).toMatchObject({ dryRun: false, outcome: 'stopped', count: 2 });
    expect(calls).toEqual([JOB]);
  });

  it('reports not-running and passes the refused outcome through as a refusal', async () => {
    expect((await request(body('job.stop', { job: JOB, dryRun: false }), {
      findJobProcesses: async () => [],
      stopJob: async (id: string): Promise<JobStopResult> => ({ id, pids: [], outcome: 'not-running', at: '2026-11-10T00:00:00Z' }),
    })).status).toBe(200);
    expect((await request(body('job.stop', { job: JOB, dryRun: false }), {
      stopJob: async (id: string): Promise<JobStopResult> => ({ id, pids: [], outcome: 'refused', at: '2026-11-10T00:00:00Z' }),
    })).status).toBe(503);
  });

  it('CLI twin refuses a bad id exactly like the API (no process table touched)', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect((await cli(['stop', 'bad id!'])).code).toBe(2);
    expect((await cli(['stop'])).code).toBe(2);
    expect((await request(body('job.stop', { job: 'bad id!' }))).status).toBe(400);
    expect((await request(body('job.stop'))).status).toBe(400);
    spy.mockRestore();
  });
});

describe('shared module refusals', () => {
  it('raises SteerRefusedError on bad input and never on operational failures', async () => {
    await expect(runSteerAction({ action: 'steer.note', text: '' }, { runsDir: root })).rejects.toBeInstanceOf(SteerRefusedError);
    await expect(runSteerAction({ action: 'queue.reprioritize', job: 'bad!', priority: 'P1' }, { runsDir: root })).rejects.toBeInstanceOf(SteerRefusedError);
    await expect(runSteerAction({ action: 'job.stop', job: 'bad!' }, { runsDir: root })).rejects.toBeInstanceOf(SteerRefusedError);
    // Unknown queue line: operational, not a refusal.
    await expect(runSteerAction({ action: 'queue.reprioritize', job: 'RQ-NOPE-9', priority: 'P1' }, { runsDir: root })).rejects.not.toBeInstanceOf(SteerRefusedError);
  });
});
