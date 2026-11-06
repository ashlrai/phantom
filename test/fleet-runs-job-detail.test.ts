/**
 * RQ-PHX-JOBDETAIL — fleet.job.v1 single-job detail projection.
 *
 * Contract:
 *   - state: 'running' = .launch newer than any .publish + .log + no .log.gz;
 *     'published' = .publish present; 'archived' = .log.gz with no newer
 *     .launch; otherwise 'unknown' (a bare id over an empty dir is a 200,
 *     not a 404 — the id namespace is unbounded).
 *   - J.prompt/J.notes.md/J.body.md contribute sizes and booleans only;
 *     the worktree path in J.base never leaves the module.
 *   - The log tail is bounded (last 120 lines, ≤32 KiB seek from the end),
 *     scrubSecrets + home-path redacted, and credential-keyword lines
 *     collapse to '[redacted line]'. .log.gz is read only when ≤2 MiB.
 *   - lstat before every read: a symlinked J.log is 'degraded' and nothing
 *     is read through it. Only whitelisted J.<suffix> files are ever opened.
 *   - GET /api/fleet/job?id=<J> serves the same projection; a missing or
 *     malformed id is a 400.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lstat, mkdir, mkdtemp, open, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import * as http from 'node:http';

import {
  getFleetJobDetail,
  isFleetJobId,
  type FleetJobDetailV1,
} from '../src/core/fleet/runs-job-detail.js';
import { makeCfg } from './helpers/h1-fixture.js';
import { readAuthHeaders, startServer } from './helpers/authenticated-web-server.js';

const FIXTURE_RUNS = resolve('test/fixtures/runs-job');
const ANCHOR = new Date('2026-10-30T12:00:00Z');
const opts = { runsDir: FIXTURE_RUNS, now: () => ANCHOR } as const;

let scratch: string;
let openHandles: Array<{ close(): Promise<void> }>;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'runs-job-'));
  openHandles = [];
});

afterEach(async () => {
  for (const h of openHandles) {
    try { await h.close(); } catch { /* ignore */ }
  }
  vi.restoreAllMocks();
  await rm(scratch, { recursive: true, force: true });
});

async function runsDir(files: Record<string, string | Buffer>): Promise<string> {
  const dir = join(scratch, `runs-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), content);
  }
  return dir;
}

// ---------------------------------------------------------------------------
// isFleetJobId + argument validation
// ---------------------------------------------------------------------------

describe('isFleetJobId', () => {
  it('accepts dispatchd job ids and rejects everything else', () => {
    for (const ok of ['RQ-PHX-JOBDETAIL', 'JOB1', 'a.b_c-d', 'RQ1234567890']) {
      expect(isFleetJobId(ok)).toBe(true);
    }
    for (const bad of ['', 'ab', '-lead', '.dot', '../etc', 'a/b', 'has space', 'x'.repeat(81)]) {
      expect(isFleetJobId(bad)).toBe(false);
    }
  });

  it('getFleetJobDetail rejects a bad id and a relative runsDir', async () => {
    await expect(getFleetJobDetail('../etc', { runsDir: scratch })).rejects.toThrow('invalid fleet job id');
    await expect(getFleetJobDetail('JOB1', { runsDir: 'relative/dir' })).rejects.toThrow('absolute path');
  });
});

// ---------------------------------------------------------------------------
// getFleetJobDetail against the committed fixture
// ---------------------------------------------------------------------------

describe('getFleetJobDetail (fixture)', () => {
  it('projects a running job with provenance, notes and a scrubbed log tail', async () => {
    const d = await getFleetJobDetail('RQ-FIXTURE-RUN', opts);
    expect(d.schema).toBe('fleet.job.v1');
    expect(d.generatedAt).toBe('2026-10-30T12:00:00.000Z');
    expect(d.job).toBe('RQ-FIXTURE-RUN');
    expect(d.state).toBe('running');
    expect(d.lane).toBe('codex-cmp');           // J.launch lane
    expect(d.tier).toBe('work');               // J.base.meta
    expect(d.model).toBe('gpt-5-codex');
    expect(d.pid).toBe(4242);
    expect(d.launchedAt).toBe(new Date((await lstat(join(FIXTURE_RUNS, 'RQ-FIXTURE-RUN.launch'))).mtimeMs).toISOString());
    expect(d.baseSha).toBe('0123abcd4567');    // J.base wins over the launch line
    expect(d.branch).toBe('codex-bridge/RQ-FIXTURE-RUN');
    expect(d.publish).toBeNull();
    expect(d.notes).toMatchObject({ hasNotes: true, hasBody: true });
    expect(d.notes.notesBytes).toBe((await lstat(join(FIXTURE_RUNS, 'RQ-FIXTURE-RUN.notes.md'))).size);

    expect(d.log.source).toBe('live');
    expect(d.log.bytes).toBe((await lstat(join(FIXTURE_RUNS, 'RQ-FIXTURE-RUN.log'))).size);
    expect(d.log.truncated).toBe(false);
    expect(d.log.tail).toHaveLength(5);
    expect(d.log.tail[0]).toContain('worker boot');
    expect(d.log.tail[2]).toBe('[redacted line]');                    // Authorization: Bearer …
    expect(d.log.tail[3]).toContain('~/wt/RQ-FIXTURE-RUN');           // home path collapsed
    expect(d.log.tail[3]).not.toContain('/Users/fixture-user');

    expect(d.sources).toMatchObject({ launch: 'healthy', base: 'healthy', meta: 'healthy', log: 'healthy' });
    expect(d.sources.publish).toBe('missing');
  });

  it('never returns prompt contents or worktree paths', async () => {
    const d = await getFleetJobDetail('RQ-FIXTURE-RUN', opts);
    expect(d.promptBytes).toBe((await lstat(join(FIXTURE_RUNS, 'RQ-FIXTURE-RUN.prompt'))).size);
    const wire = JSON.stringify(d);
    expect(wire).not.toContain('FAKE-PROMPT-9f4e2c');
    expect(wire).not.toContain('/fake/worktree');
    expect(wire).not.toContain('fake-value-123');
  });

  it('projects a published job: prUrl, autoMerge, testLine and sensitive list', async () => {
    const d = await getFleetJobDetail('RQ-FIXTURE-PUB', opts);
    expect(d.state).toBe('published');
    expect(d.lane).toBe('devin');
    expect(d.publish).toEqual({
      prUrl: 'https://github.com/ashlrai/phantom/pull/9999',
      autoMerge: true,
      testLine: expect.stringContaining('exit 0'),
      sensitive: ['docs/x.ts', 'G1-pass:abc123'],
    });
    // Its live log was archived: the .log.gz slice serves a scrubbed tail.
    expect(d.log.source).toBe('archived');
    expect(d.log.tail[0]).toContain('[archived] worker log');
    expect(d.sources.log).toBe('healthy');
    expect(d.sources.publish).toBe('healthy');
  });
});

// ---------------------------------------------------------------------------
// State machine and defensive reads (scratch dirs)
// ---------------------------------------------------------------------------

describe('getFleetJobDetail (scratch)', () => {
  it('is unknown over an empty runs dir with every source missing', async () => {
    const d = await getFleetJobDetail('JOB9', { runsDir: join(scratch, 'empty'), now: () => ANCHOR });
    expect(d.state).toBe('unknown');
    expect(d.sources).toEqual({ launch: 'missing', base: 'missing', meta: 'missing', publish: 'missing', log: 'missing' });
    expect(d).toMatchObject({
      lane: null, tier: null, model: null, pid: null, launchedAt: null,
      baseSha: null, branch: null, promptBytes: null, publish: null,
      log: { source: 'missing', bytes: null, tail: [], truncated: false },
    });
  });

  it('is archived when .log.gz exists with no newer .launch', async () => {
    const dir = await runsDir({
      'JOB7.launch': 'launched JOB7 devin pid 5 base abc1234\n',
      'JOB7.log.gz': gzipSync('archived line one\napi_key=fake-secret-value\narchived last\n'),
    });
    await utimes(join(dir, 'JOB7.launch'), new Date('2020-01-01'), new Date('2020-01-01'));
    const d = await getFleetJobDetail('JOB7', { runsDir: dir, now: () => ANCHOR });
    expect(d.state).toBe('archived');
    expect(d.log.source).toBe('archived');
    expect(d.log.tail[0]).toContain('archived line one');
    expect(d.log.tail[1]).toBe('[redacted line]');  // api_key=… keyword line
    expect(d.log.truncated).toBe(false);
  });

  it('is running when .launch is newer than .publish', async () => {
    const dir = await runsDir({
      'JOB8.publish': 'RESULT PR https://example.invalid/pr/1 SENS=[]\n',
      'JOB8.launch': 'launched JOB8 devin pid 6 base def5678\n',
      'JOB8.log': 'relaunched and working\n',
    });
    await utimes(join(dir, 'JOB8.publish'), new Date('2020-01-01'), new Date('2020-01-01'));
    const d = await getFleetJobDetail('JOB8', { runsDir: dir, now: () => ANCHOR });
    expect(d.state).toBe('running');
  });

  it('refuses a symlinked J.log: degraded source, nothing read through it', async () => {
    const dir = await runsDir({ 'JOB2.launch': 'launched JOB2 devin pid 1 base abc1234\n' });
    const outside = join(scratch, 'outside-target.log');
    await writeFile(outside, 'OUTSIDE-SENTINEL-77 must never be served\n');
    await symlink(outside, join(dir, 'JOB2.log'));
    const d = await getFleetJobDetail('JOB2', { runsDir: dir, now: () => ANCHOR });
    expect(d.sources.log).toBe('degraded');
    expect(d.log).toMatchObject({ source: 'missing', bytes: null, tail: [] });
    expect(JSON.stringify(d)).not.toContain('OUTSIDE-SENTINEL-77');
  });

  it('reads only the tail window of a multi-MiB live log', async () => {
    const dir = join(scratch, 'big');
    await mkdir(dir, { recursive: true });
    const head = 'HEAD-SENTINEL first line\n';
    const tail = 'TAIL-SENTINEL last line\n';
    const filler = 'y'.repeat(511) + '\n';
    // Whole filler lines only — the tail line must stand alone.
    const content = head + filler.repeat(Math.ceil(5 * 1024 * 1024 / filler.length)) + tail;
    await writeFile(join(dir, 'JOB5.log'), content);

    const probeFh = await open(join(dir, 'JOB5.log'));
    const proto = Object.getPrototypeOf(probeFh) as { read: (...args: unknown[]) => Promise<{ bytesRead: number }> };
    await probeFh.close();
    const original = proto.read;
    let bytesRead = 0;
    vi.spyOn(proto, 'read').mockImplementation(async function (this: unknown, ...args: unknown[]) {
      const r = await Reflect.apply(original, this, args) as { bytesRead: number };
      bytesRead += r.bytesRead;
      return r;
    });

    const d = await getFleetJobDetail('JOB5', { runsDir: dir, now: () => ANCHOR });
    expect(bytesRead).toBeLessThanOrEqual(32 * 1024);
    expect(d.log.bytes).toBeGreaterThan(5 * 1024 * 1024);
    expect(d.log.truncated).toBe(true);
    expect(d.log.tail.at(-1)).toBe('TAIL-SENTINEL last line');
    expect(d.log.tail.join('\n')).not.toContain('HEAD-SENTINEL');
  });

  it('serves tail: [] + truncated for a .log.gz over the 2 MiB bound', async () => {
    const dir = await runsDir({ 'JOB6.log.gz': Buffer.alloc(3 * 1024 * 1024) });
    const d = await getFleetJobDetail('JOB6', { runsDir: dir, now: () => ANCHOR });
    expect(d.log).toMatchObject({ source: 'archived', tail: [], truncated: true });
    expect(d.sources.log).toBe('degraded');
    expect(d.state).toBe('archived');
  });
});

// ---------------------------------------------------------------------------
// GET /api/fleet/job — loopback route serves the same projection.
// ---------------------------------------------------------------------------

describe('GET /api/fleet/job', () => {
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

  it('serves fleet.job.v1 on the loopback server and 400s on a bad id', async () => {
    // The suite HOME is relocated (test/setup/home.ts); seed the default runs dir.
    const runs = join(homedir(), '.ashlr-runs');
    await mkdir(runs, { recursive: true });
    await writeFile(join(runs, 'JOB9.launch'), 'launched JOB9 devin pid 9 base abc1234\n');
    await writeFile(join(runs, 'JOB9.log'), 'line one\nline two\n');

    const h = await startServer(makeCfg(), { port: 0, open: false, allowDispatch: false });
    openHandles.push(h);

    const res = await get(`${h.url}/api/fleet/job?id=JOB9`, h.port);
    expect(res.statusCode).toBe(200);
    const d = JSON.parse(res.body) as FleetJobDetailV1;
    expect(d.schema).toBe('fleet.job.v1');
    expect(d.job).toBe('JOB9');
    expect(d.state).toBe('running');
    expect(d.lane).toBe('devin');
    expect(d.log.tail).toEqual(['line one', 'line two']);

    expect((await get(`${h.url}/api/fleet/job`, h.port)).statusCode).toBe(400);
    expect((await get(`${h.url}/api/fleet/job?id=${encodeURIComponent('../etc')}`, h.port)).statusCode).toBe(400);
    expect((await get(`${h.url}/api/fleet/job?id=ab`, h.port)).statusCode).toBe(400);
    // A well-formed id over an empty namespace is a 200 'unknown', not a 404.
    const empty = JSON.parse((await get(`${h.url}/api/fleet/job?id=NOJOBHERE`, h.port)).body) as FleetJobDetailV1;
    expect(empty.state).toBe('unknown');
  });
});
