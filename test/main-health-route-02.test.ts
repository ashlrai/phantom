/**
 * RQ-PHX-MAINHEALTHROUTE02 — the main-health route end to end: a guardian
 * status file under a temp runs dir → readMainHealth →
 * GET /api/verse/runs-history/main-health → mainHealthQuery.fetch →
 * deriveMainHealthNeedsYou, plus the operator glance's `main`. Fixture repo
 * names and temp dirs only; nothing touches the real runs dir.
 */
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMainHealthApi, VERSE_RUNS_HISTORY_MAIN_HEALTH_PATH as PATH, type MainHealthApiDeps } from '../src/core/verse/main-health-api.js';
import { readMainHealth } from '../src/core/fleet/main-health-read.js';
import { readOperatorGlance } from '../src/core/fleet/operator-glance-read.js';
import { mainHealthQuery, type MainHealthData } from '../src/web-ui/routes/verse/shell/main-health-query.js';
import { deriveMainHealthNeedsYou } from '../src/web-ui/routes/verse/shell/main-health-needs-you.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const ctx = { token: 'fixture-token', allowDispatch: false } as VerseApiContext;
const NOW = Date.parse('2026-11-02T14:00:00Z');
const dirs: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempRunsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'main-health-'));
  dirs.push(dir);
  return dir;
}

function writeStatus(runsDir: string, text: string, mtimeMs = NOW): string {
  mkdirSync(join(runsDir, 'supervisor'), { recursive: true });
  const path = join(runsDir, 'supervisor', 'status-main-guardian.md');
  writeFileSync(path, text);
  utimesSync(path, new Date(mtimeMs), new Date(mtimeMs));
  return path;
}

const HEADER = '| repo | branch | sha | state | checked | failing | fix | nightly |';
const row = (repo: string, state: string, cells: { sha?: string; branch?: string; checked?: string; failing?: string; fix?: string; nightly?: string } = {}) =>
  `| ${repo} | ${cells.branch ?? 'main'} | ${cells.sha ?? '-'} | ${state} | ${cells.checked ?? '2026-11-02T13:55:00Z'} | ${cells.failing ?? '-'} | ${cells.fix ?? '-'} | ${cells.nightly ?? '-'} |`;

const fixture = (rows: string[]): string => [
  '# Main guardian status',
  'generated: 2026-11-02T13:59:00Z',
  'interval: 300 seconds',
  '',
  HEADER,
  ...rows,
].join('\n');

async function call(method: string, url = PATH, deps: MainHealthApiDeps = {}) {
  const req = new PassThrough() as IncomingMessage & PassThrough;
  Object.assign(req, { method, url, headers: {} });
  req.end();
  let status = 0;
  let payload = '';
  const res = {
    writeHead(code: number) { status = code; return this; },
    end(chunk?: string) { payload = chunk ?? ''; return this; },
  } as unknown as ServerResponse;
  const handled = await createMainHealthApi(deps)(ctx, req, res, new URL(url, 'http://localhost').pathname, method);
  return { handled, status, json: payload ? (JSON.parse(payload) as MainHealthData) : null };
}

describe('GET /api/verse/runs-history/main-health', () => {
  it('serves a red repo the client validates and the needs-you row flags', async () => {
    const runsDir = tempRunsDir();
    writeStatus(runsDir, fixture([
      row('fixture-alpha', 'green', { sha: 'a1b2c3d4' }),
      row('fixture-beta', 'red', { sha: 'e5f6a7b8', failing: 'typecheck' }),
    ]));
    const result = await call('GET', PATH, { read: () => readMainHealth({ runsDir, now: () => NOW }) });
    expect(result.handled).toBe(true);
    expect(result.status).toBe(200);
    expect(result.json).toMatchObject({
      v: 1, source: 'ok', stale: false, guardianOff: false, red: 1,
      repos: [
        { repo: 'fixture-alpha', branch: 'main', sha: 'a1b2c3d4', state: 'green', failingCheck: null, fixJobs: [], nightlyRed: null },
        { repo: 'fixture-beta', branch: 'main', sha: 'e5f6a7b8', state: 'red', failingCheck: 'typecheck', fixJobs: [], nightlyRed: null },
      ],
    });
    expect(Number.isFinite(Date.parse(result.json!.statusAt!))).toBe(true);
    // The exact body the client must accept — pins server to web-ui.
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(result.json)));
    vi.stubGlobal('fetch', fetchMock);
    const read = await mainHealthQuery.fetch();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(PATH);
    expect(read).toEqual({ kind: 'available', data: result.json });
    const items = deriveMainHealthNeedsYou(read.kind === 'available' ? read : undefined);
    expect(items).toEqual([expect.objectContaining({
      id: 'main-red-fixture-beta', severity: 'urgent',
      title: expect.stringContaining('fixture-beta main is red with no fix job: typecheck'),
    })]);
  });

  it('answers 405 to non-GET and 400 to an unknown parameter', async () => {
    const post = await call('POST');
    expect(post.handled).toBe(true);
    expect(post.status).toBe(405);
    const bad = await call('GET', `${PATH}?bogus=1`);
    expect(bad.status).toBe(400);
    expect(bad.json).toMatchObject({ code: 'VERSE_INVALID' });
  });

  it('declines foreign paths and turns a thrown reader into source unavailable', async () => {
    const miss = await call('GET', '/api/verse/runs-history');
    expect(miss.handled).toBe(false);
    const thrown = await call('GET', PATH, { read: () => Promise.reject(new Error('no fs')) });
    expect(thrown.status).toBe(200);
    expect(thrown.json).toMatchObject({ source: 'unavailable', stale: false, red: 0, repos: [] });
  });

  it('is stale when the status file is absent and unavailable when the runs dir is absent', async () => {
    const runsDir = tempRunsDir();
    const absent = await readMainHealth({ runsDir, now: () => NOW });
    expect(absent).toMatchObject({ source: 'ok', stale: true, statusAt: null, repos: [] });
    const missing = await readMainHealth({ runsDir: join(runsDir, 'never-was'), now: () => NOW });
    expect(missing).toMatchObject({ source: 'unavailable', stale: false });
  });

  it('marks guardianOff when the kill switch exists and stale when mtime outlives the interval', async () => {
    const runsDir = tempRunsDir();
    mkdirSync(join(runsDir, 'queue'), { recursive: true });
    writeFileSync(join(runsDir, 'queue', 'MAIN_GUARDIAN_OFF'), '');
    writeStatus(runsDir, fixture([row('fixture-alpha', 'green', { sha: 'a1b2c3d4' })]));
    const off = await readMainHealth({ runsDir, now: () => NOW });
    expect(off.guardianOff).toBe(true);
    writeStatus(runsDir, fixture([row('fixture-alpha', 'green', { sha: 'a1b2c3d4' })]), NOW - 31 * 60_000);
    const stale = await readMainHealth({ runsDir, now: () => NOW });
    expect(stale.stale).toBe(true); // 31 min old > 3 × stated 5 min interval
  });

  it('never serves a home path in a failing-check or nightly cell', async () => {
    const runsDir = tempRunsDir();
    writeStatus(runsDir, fixture([
      row('fixture-alpha', 'red', { failing: 'check /Users/fixture-operator/build.log', nightly: '~/nightly.log' }),
      row('fixture-beta', 'green', { sha: 'a1b2c3d4' }),
    ]));
    const result = await call('GET', PATH, { read: () => readMainHealth({ runsDir, now: () => NOW }) });
    expect(result.status).toBe(200);
    const alpha = result.json!.repos.find((repo) => repo.repo === 'fixture-alpha');
    expect(alpha!.failingCheck).toBeNull();
    expect(alpha!.nightlyRed).toBeNull();
    expect(JSON.stringify(result.json)).not.toContain('/Users/');
    expect(JSON.stringify(result.json)).not.toContain('~/');
  });

  it('keeps only RQ-shaped fix job ids and unknown for unreadable states', async () => {
    const runsDir = tempRunsDir();
    writeStatus(runsDir, fixture([
      row('fixture-alpha', 'red', { fix: 'RQ-TEST-1, RQ-TEST-2 bogus-id' }),
      row('fixture-gamma', 'wobbly'),
    ]));
    const data = await readMainHealth({ runsDir, now: () => NOW });
    const alpha = data.repos.find((repo) => repo.repo === 'fixture-alpha');
    expect(alpha!.fixJobs).toEqual(['RQ-TEST-1', 'RQ-TEST-2']);
    const gamma = data.repos.find((repo) => repo.repo === 'fixture-gamma');
    expect(gamma!.state).toBe('unknown');
    expect(data.red).toBe(1);
  });
});

describe('readOperatorGlance main health', () => {
  it('says down for a red guardian even when a newer unrelated status file exists', async () => {
    const runsDir = tempRunsDir();
    writeStatus(runsDir, fixture([row('fixture-beta', 'red', { sha: 'e5f6a7b8', failing: 'typecheck' })]), NOW - 60_000);
    writeFileSync(join(runsDir, 'supervisor', 'status-other.md'), 'main: green\n');
    utimesSync(join(runsDir, 'supervisor', 'status-other.md'), new Date(NOW - 30_000), new Date(NOW - 30_000));
    const glance = await readOperatorGlance({ runsDir, now: () => new Date(NOW) });
    expect(glance.main).toBe('down');
  });

  it('does not say up for a stale guardian full of green repos', async () => {
    const runsDir = tempRunsDir();
    writeStatus(runsDir, fixture([
      row('fixture-alpha', 'green', { sha: 'a1b2c3d4' }),
      row('fixture-beta', 'green', { sha: 'e5f6a7b8' }),
    ]), NOW - 31 * 60_000);
    const glance = await readOperatorGlance({ runsDir, now: () => new Date(NOW) });
    expect(glance.main).not.toBe('up');
  });

  it('says up for a fresh all-green guardian', async () => {
    const runsDir = tempRunsDir();
    writeStatus(runsDir, fixture([
      row('fixture-alpha', 'green', { sha: 'a1b2c3d4' }),
      row('fixture-beta', 'green', { sha: 'e5f6a7b8' }),
    ]));
    const glance = await readOperatorGlance({ runsDir, now: () => new Date(NOW) });
    expect(glance.main).toBe('up');
  });

  it('falls back to the newest status file when the guardian never wrote', async () => {
    const runsDir = tempRunsDir();
    mkdirSync(join(runsDir, 'supervisor'), { recursive: true });
    writeFileSync(join(runsDir, 'supervisor', 'status-main.md'), 'main: down\n');
    const glance = await readOperatorGlance({ runsDir, now: () => new Date(NOW) });
    expect(glance.main).toBe('down');
  });
});
