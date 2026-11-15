/**
 * RQ-RADAR-DESKTOP-ACTIVITY — fleet.job.activity.v1 per-job activity stream.
 *
 * Contract:
 *   - entries merge four guarded sources in fixed order: ledger `event`
 *     rows (metrics/jobs.jsonl tail, this job only, allowlisted summary
 *     fields), `command` rows observed in the worker log's bounded scan
 *     (only lines starting with a known verb or `$`/`›`/`❯` prompt), one
 *     `files` entry (the runs-job-changes projection) and `report` entries
 *     for notes (body.md fallback) and the brief.
 *   - every source degrades independently: a missing ledger, log, worktree
 *     or report file never fabricates entries and never throws.
 *   - text is scrubbed: credential-keyword log lines collapse before a
 *     command can quote them, ledger summaries keep allowlisted scalars.
 *   - GET /api/fleet/job/activity?id=<J> serves the same projection; a bad
 *     id is a 400, a well-formed unknown id is a 200.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import * as http from 'node:http';

import {
  extractJobCommands,
  getFleetJobActivity,
  type FleetJobActivityV1,
} from '../src/core/fleet/runs-job-activity.js';
import { makeCfg } from './helpers/h1-fixture.js';
import { readAuthHeaders, startServer } from './helpers/authenticated-web-server.js';

let scratch: string;
let openHandles: Array<{ close(): Promise<void> }>;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'runs-activity-'));
  openHandles = [];
});

afterEach(async () => {
  for (const h of openHandles) {
    try { await h.close(); } catch { /* ignore */ }
  }
  vi.restoreAllMocks();
  await rm(scratch, { recursive: true, force: true });
});

async function runsDir(files: Record<string, string>): Promise<string> {
  const dir = join(scratch, `runs-${Math.random().toString(36).slice(2)}`);
  await mkdir(join(dir, 'metrics'), { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(dir, name.split('/').slice(0, -1).join('/')), { recursive: true }).catch(() => undefined);
    await writeFile(join(dir, name), content);
  }
  return dir;
}

const opts = { now: () => new Date('2026-11-09T12:00:00Z') } as const;

// ---------------------------------------------------------------------------
// extractJobCommands — the conservative command grammar
// ---------------------------------------------------------------------------

describe('extractJobCommands', () => {
  it('keeps prompt and verb-led lines, drops prose and bare verbs', () => {
    const lines = [
      'worker boot RQ-X lane=codex pid=1',
      'npm run dev --port 7777',
      'The build passed and all tests are green now.',
      '$ git status --short',
      '› pnpm test',
      'git',
      '  cargo build --release',
      'heartbeat tick 3',
      'Authorization: Bearer fake-token',
    ];
    const out = extractJobCommands(lines);
    expect(out.map(e => e.text)).toEqual([
      'npm run dev --port 7777',
      'git status --short',
      'pnpm test',
      'cargo build --release',
    ]);
    expect(out[0]!.line).toBe(2);
  });

  it('honours the entry cap', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `npm run step-${i}`);
    expect(extractJobCommands(lines, 3)).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// getFleetJobActivity — merged stream
// ---------------------------------------------------------------------------

describe('getFleetJobActivity', () => {
  it('merges events, commands, files state and reports for one job', async () => {
    const dir = await runsDir({
      'JOB-A1.launch': 'launched JOB-A1 codex pid 42 base abc1234\n',
      'JOB-A1.log': [
        'worker boot JOB-A1',
        'npm ci',
        'some prose about the work',
        'git diff --stat',
        'Authorization: Bearer fake-secret-token',
        'npm test',
      ].join('\n'),
      'JOB-A1.notes.md': '# Report\n\nAll done.\n',
      'JOB-A1.prompt': 'do the thing\n',
      'metrics/jobs.jsonl': [
        JSON.stringify({ event: 'enqueue', job: 'JOB-A1', repo: 'phantom', lane: 'codex', tier: 'mid', ts: '2026-11-09T10:00:00+0000' }),
        JSON.stringify({ event: 'launch', job: 'JOB-A1', lane: 'codex', model: 'gpt-5', ts: '2026-11-09T10:01:00+0000' }),
        JSON.stringify({ event: 'finish', job: 'JOB-OTHER', wall_s: 5, ts: '2026-11-09T10:02:00+0000' }),
        'not json at all',
        JSON.stringify({ event: 'publish', job: 'JOB-A1', outcome: 'MERGED', url: 'https://github.com/x/y/pull/1', ts: '2026-11-09T11:00:00+0000' }),
      ].join('\n'),
    });
    const a = await getFleetJobActivity('JOB-A1', { runsDir: dir, ...opts });
    expect(a.schema).toBe('fleet.job.activity.v1');
    expect(a.job).toBe('JOB-A1');
    expect(a.state).toBe('running');
    expect(a.lane).toBe('codex');

    const kinds = a.entries.map(e => e.kind);
    expect(kinds).toEqual(['event', 'event', 'event', 'command', 'command', 'command', 'files', 'report', 'report']);

    const events = a.entries.filter(e => e.kind === 'event');
    expect(events.map(e => (e as { event: string }).event)).toEqual(['enqueue', 'launch', 'publish']);
    expect((events[0] as { at: string | null }).at).toBe('2026-11-09T10:00:00+0000');
    expect((events[2] as { summary: string }).summary).toContain('outcome=MERGED');
    expect((events[2] as { summary: string }).summary).not.toContain('JOB-OTHER');

    const commands = a.entries.filter(e => e.kind === 'command') as Array<{ text: string; line: number }>;
    expect(commands.map(c => c.text)).toEqual(['npm ci', 'git diff --stat', 'npm test']);
    // The credential-keyword line never reaches the stream.
    expect(JSON.stringify(a.entries)).not.toContain('fake-secret-token');

    const files = a.entries.find(e => e.kind === 'files');
    expect(files).toMatchObject({ kind: 'files', state: 'missing' });

    const reports = a.entries.filter(e => e.kind === 'report') as Array<{ name: string; state: string; text: string }>;
    expect(reports[0]).toMatchObject({ name: 'notes', state: 'ok', text: '# Report\n\nAll done.\n' });
    expect(reports[1]).toMatchObject({ name: 'brief', state: 'ok' });

    expect(a.counts).toEqual({ events: 3, commands: 3, files: 0, reports: 2 });
    expect(a.sources).toEqual({ events: 'healthy', commands: 'healthy', files: 'missing', reports: 'healthy' });
    expect(a.truncated).toBe(false);
  });

  it('degrades each source independently over an empty runs dir', async () => {
    const dir = await runsDir({});
    const a = await getFleetJobActivity('JOB-EMPTY', { runsDir: dir, ...opts });
    expect(a.state).toBe('unknown');
    expect(a.entries.map(e => e.kind)).toEqual(['files', 'report', 'report']);
    expect(a.sources).toEqual({ events: 'missing', commands: 'missing', files: 'missing', reports: 'missing' });
    const reports = a.entries.filter(e => e.kind === 'report') as Array<{ state: string }>;
    expect(reports.every(r => r.state === 'missing')).toBe(true);
  });

  it('reads commands from an archived .log.gz and marks the window truncated when clipped', async () => {
    const { gzipSync } = await import('node:zlib');
    const dir = await runsDir({
      'JOB-GZ1.log.gz': gzipSync(['noise line', 'npm run build', 'tail line'].join('\n')),
      'metrics/jobs.jsonl': '',
    });
    const a = await getFleetJobActivity('JOB-GZ1', { runsDir: dir, scan: { maxLines: 2 }, ...opts });
    const commands = a.entries.filter(e => e.kind === 'command') as Array<{ text: string }>;
    expect(commands.map(c => c.text)).toEqual(['npm run build']);
    expect(a.sources.commands).toBe('healthy');
    expect(a.truncated).toBe(true); // maxLines clipped the window
  });

  it('keeps only the newest maxEvents ledger rows and flags truncation', async () => {
    const rows = Array.from({ length: 5 }, (_, i) =>
      JSON.stringify({ event: 'tick', job: 'JOB-EV', wall_s: i, ts: `2026-11-09T10:0${i}:00+0000` }));
    const dir = await runsDir({
      'JOB-EV.log': 'npm run x\n',
      'metrics/jobs.jsonl': rows.join('\n'),
    });
    const a = await getFleetJobActivity('JOB-EV', { runsDir: dir, maxEvents: 2, ...opts });
    const events = a.entries.filter(e => e.kind === 'event') as Array<{ summary: string }>;
    expect(events).toHaveLength(2);
    expect(events[1]!.summary).toContain('wall_s=4');
    expect(a.truncated).toBe(true);
  });

  it('rejects a bad job id and a relative runsDir', async () => {
    await expect(getFleetJobActivity('../etc', { runsDir: scratch })).rejects.toThrow('invalid fleet job id');
    await expect(getFleetJobActivity('JOB1', { runsDir: 'relative' })).rejects.toThrow('absolute path');
  });
});

// ---------------------------------------------------------------------------
// GET /api/fleet/job/activity — loopback route
// ---------------------------------------------------------------------------

describe('GET /api/fleet/job/activity', () => {
  function get(url: string, port: number): Promise<{ statusCode: number; body: string }> {
    return new Promise((resolvePromise, reject) => {
      const parsed = new URL(url);
      const req = http.request(
        {
          hostname: parsed.hostname, port, path: parsed.pathname + parsed.search,
          method: 'GET', headers: { Host: `127.0.0.1:${port}`, ...readAuthHeaders(port) },
        },
        (res) => {
          let data = '';
          res.on('data', (c: Buffer) => { data += c.toString(); });
          res.on('end', () => resolvePromise({ statusCode: res.statusCode ?? 0, body: data }));
        },
      );
      req.on('error', reject);
      req.end();
    });
  }

  it('serves fleet.job.activity.v1 and 400s on a bad id', async () => {
    const runs = join(homedir(), '.ashlr-runs');
    await mkdir(join(runs, 'metrics'), { recursive: true });
    await writeFile(join(runs, 'JOBACT1.log'), 'npm test\n');
    await writeFile(join(runs, 'metrics', 'jobs.jsonl'),
      JSON.stringify({ event: 'launch', job: 'JOBACT1', lane: 'codex', ts: '2026-11-09T10:00:00+0000' }) + '\n');

    const h = await startServer(makeCfg(), { port: 0, open: false, allowDispatch: false });
    openHandles.push(h);

    const res = await get(`${h.url}/api/fleet/job/activity?id=JOBACT1`, h.port);
    expect(res.statusCode).toBe(200);
    const a = JSON.parse(res.body) as FleetJobActivityV1;
    expect(a.schema).toBe('fleet.job.activity.v1');
    expect(a.job).toBe('JOBACT1');
    expect(a.entries.map(e => e.kind)).toEqual(['event', 'command', 'files', 'report', 'report']);

    expect((await get(`${h.url}/api/fleet/job/activity`, h.port)).statusCode).toBe(400);
    expect((await get(`${h.url}/api/fleet/job/activity?id=${encodeURIComponent('../etc')}`, h.port)).statusCode).toBe(400);
  });
});
