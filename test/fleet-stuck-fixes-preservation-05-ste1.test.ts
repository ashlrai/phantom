/**
 * Preservation for the stuck-fixes reconciliation: the CLI, `readStuckFixes`
 * and `GET /api/verse/runs-history/stuck-fixes` fold one real temp ledger
 * through the shared core fold — no injected readers. Unreadable evidence
 * must surface as known:false on every surface, never as zero stuck.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetStuckFixes } from '../src/cli/fleet-stuck-fixes.js';
import { readStuckFixes } from '../src/core/fleet/stuck-fixes.js';
import { createRunsHistoryApi, VERSE_RUNS_HISTORY_STUCK_FIXES_PATH as PATH } from '../src/core/verse/runs-history-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const ctx = { token: 'fixture-token', allowDispatch: false } as VerseApiContext;
const NOW = new Date('2026-11-05T12:00:00.000Z');
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();
const pub = (job: string, url: string, ts: string) => JSON.stringify({ event: 'publish', class: 'pr', job, url, ts });
const outcome = (job: string, state: string, ts: string) => JSON.stringify({ event: 'outcome', job, state, ts });

const STUCK_ROW = {
  job: 'FIXUP-MAIN-phantom-a1f206c',
  repo: 'phantom',
  prUrl: 'https://github.com/ashlrai/phantom/pull/101',
  publishedAt: minutesAgo(45),
  ageMinutes: 45,
};
const LEDGER = [
  pub(STUCK_ROW.job, STUCK_ROW.prUrl, minutesAgo(45)),
  pub('FIXUP-MAIN-ashlr-b2f3e4d', 'https://github.com/ashlrai/ashlr/pull/9', minutesAgo(50)),
  outcome('FIXUP-MAIN-ashlr-b2f3e4d', 'MERGED', minutesAgo(10)),
  pub('FIXUP-MAIN-lexicon-c3d4e5f', 'https://github.com/ashlrai/lexicon/pull/7', minutesAgo(5)),
  'not json',
].join('\n');

const dirs: string[] = [];
let savedRunsDir: string | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  savedRunsDir = process.env.ASHLR_RUNS_DIR;
});
afterEach(() => {
  if (savedRunsDir === undefined) delete process.env.ASHLR_RUNS_DIR;
  else process.env.ASHLR_RUNS_DIR = savedRunsDir;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
});

/** Temp runs root whose metrics/jobs.jsonl is `ledger`; a directory when `ledger` is null. */
function runsWith(ledger: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), 'stuck-fixes-05ste1-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'metrics'));
  if (ledger === null) mkdirSync(join(dir, 'metrics', 'jobs.jsonl'));
  else writeFileSync(join(dir, 'metrics', 'jobs.jsonl'), ledger);
  return dir;
}

/** The CLI reads the same ledger via ASHLR_RUNS_DIR when no --jobs is given. */
async function cli(runs: string) {
  process.env.ASHLR_RUNS_DIR = runs;
  const logs: string[] = [];
  const errors: string[] = [];
  const code = await cmdFleetStuckFixes(['--json'], {
    output: { log: (s) => logs.push(s), error: (s) => errors.push(s) },
  });
  return { code, errors, report: JSON.parse(logs[0]!) as Record<string, unknown> };
}

/** Drives the route through the real module with no injected readers. */
async function route(runs: string) {
  const req = new PassThrough() as IncomingMessage & PassThrough;
  Object.assign(req, { method: 'GET', url: PATH, headers: {} });
  req.end();
  let status = 0;
  let payload = '';
  const res = {
    writeHead(code: number) { status = code; return this; },
    end(chunk?: string) { payload = chunk ?? ''; return this; },
  } as unknown as ServerResponse;
  await createRunsHistoryApi({ runsDir: runs })(ctx, req, res, PATH, 'GET');
  return { status, payload, json: JSON.parse(payload) as Record<string, unknown> };
}

describe('stuck-fixes preservation: one shared fold across CLI, core and route', () => {
  it('CLI, readStuckFixes and the route report the same stuck rows from one ledger', async () => {
    const runs = runsWith(LEDGER);
    const viaCli = await cli(runs);
    const viaCore = await readStuckFixes({ runsDir: runs });
    const viaRoute = await route(runs);

    expect(viaCli.code).toBe(0);
    expect(viaCli.report).toMatchObject({ known: true, rows: 4, stuck: [STUCK_ROW] });
    expect(viaCore).toMatchObject({ known: true, stuck: [STUCK_ROW] });
    expect(viaRoute).toMatchObject({ status: 200, json: { known: true, stuck: [STUCK_ROW] } });
    expect(viaRoute.json.stuck).toEqual(viaCore.stuck);
    expect(viaCli.report.stuck).toEqual(viaCore.stuck);
  });

  it('an unreadable ledger is known:false on every surface, never guessed as zero stuck', async () => {
    const runs = runsWith(null);
    const viaCli = await cli(runs);
    const viaCore = await readStuckFixes({ runsDir: runs });
    const viaRoute = await route(runs);

    expect(viaCli).toMatchObject({ code: 1, report: { known: false, stuck: [] } });
    expect(viaCli.errors).toEqual([]);
    expect(viaCore).toMatchObject({ known: false, stuck: [] });
    expect(viaRoute).toMatchObject({ status: 200, json: { known: false, stuck: [] } });
    expect(viaRoute.payload).not.toContain(runs);
    expect(viaRoute.payload).not.toContain('jobs.jsonl');
  });
});
