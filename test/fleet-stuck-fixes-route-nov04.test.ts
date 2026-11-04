/**
 * Stuck guardian fix PRs on the wire: `readStuckFixes` and
 * `GET /api/verse/runs-history/stuck-fixes`. Temp runs dirs and fixture ids
 * only; the payload must never carry the ledger path.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readStuckFixes, STUCK_FIX_MIN_AGE_MINUTES } from '../src/core/fleet/stuck-fixes.js';
import { createRunsHistoryApi, VERSE_RUNS_HISTORY_STUCK_FIXES_PATH as PATH } from '../src/core/verse/runs-history-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const ctx = { token: 'fixture-token', allowDispatch: false } as VerseApiContext;
const NOW = new Date('2026-11-04T12:00:00.000Z').getTime();
const iso = (ms: number) => new Date(ms).toISOString();
const pub = (job: string, url: string, ts: string) =>
  JSON.stringify({ event: 'publish', class: 'pr', job, url, ts });
const outcome = (job: string, state: string, ts: string) =>
  JSON.stringify({ event: 'outcome', job, state, ts });

const PR_STUCK = 'https://github.com/ashlrai/phantom/pull/101';
const STUCK_JOB = 'FIXUP-MAIN-phantom-a1f206c';

const LEDGER = [
  // Stuck: PR published 45 min ago, no terminal outcome.
  pub(STUCK_JOB, PR_STUCK, iso(NOW - 45 * 60_000)),
  // Resolved: MERGED row closes it even though the PR is old.
  pub('FIXUP-MAIN-ashlr-b2f3e4d', 'https://github.com/ashlrai/ashlr/pull/9', iso(NOW - 50 * 60_000)),
  outcome('FIXUP-MAIN-ashlr-b2f3e4d', 'MERGED', iso(NOW - 10 * 60_000)),
  // Fresh: only 5 min old.
  pub('FIXUP-MAIN-lexicon-c3d4e5f', 'https://github.com/ashlrai/lexicon/pull/7', iso(NOW - 5 * 60_000)),
].join('\n');

const dirs: string[] = [];
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Temp runs root; writes `ledger` to metrics/jobs.jsonl when given. */
function runsDir(ledger?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'stuck-fixes-'));
  dirs.push(dir);
  if (ledger !== undefined) {
    mkdirSync(join(dir, 'metrics'));
    writeFileSync(join(dir, 'metrics', 'jobs.jsonl'), ledger);
  }
  return dir;
}

describe('readStuckFixes', () => {
  it('folds <runsDir>/metrics/jobs.jsonl into the v1 verdict', async () => {
    const report = await readStuckFixes({ runsDir: runsDir(LEDGER) });
    expect(report).toEqual({
      v: 1,
      generatedAt: iso(NOW),
      known: true,
      thresholdMinutes: STUCK_FIX_MIN_AGE_MINUTES,
      stuck: [{
        job: STUCK_JOB,
        repo: 'phantom',
        prUrl: PR_STUCK,
        publishedAt: iso(NOW - 45 * 60_000),
        ageMinutes: 45,
      }],
    });
  });

  it('answers known:false for a missing ledger and never throws', async () => {
    await expect(readStuckFixes({ runsDir: runsDir() })).resolves.toEqual({
      v: 1,
      generatedAt: iso(NOW),
      known: false,
      thresholdMinutes: 20,
      stuck: [],
    });
  });
});

describe('GET /api/verse/runs-history/stuck-fixes', () => {
  async function call(method: string, dir: string, url = PATH) {
    const req = new PassThrough() as IncomingMessage & PassThrough;
    Object.assign(req, { method, url, headers: {} });
    req.end();
    let status = 0;
    let payload = '';
    const res = {
      writeHead(code: number) { status = code; return this; },
      end(chunk?: string) { payload = chunk ?? ''; return this; },
    } as unknown as ServerResponse;
    const handled = await createRunsHistoryApi({ runsDir: dir })(
      ctx, req, res, new URL(url, 'http://localhost').pathname, method);
    return { handled, status, payload, json: payload ? (JSON.parse(payload) as Record<string, unknown>) : null };
  }

  it('serves the pinned shape with exactly the one stuck row', async () => {
    const result = await call('GET', runsDir(LEDGER));
    expect(result).toMatchObject({ handled: true, status: 200 });
    expect(result.json).toEqual({
      v: 1,
      generatedAt: iso(NOW),
      known: true,
      thresholdMinutes: 20,
      stuck: [{
        job: STUCK_JOB,
        repo: 'phantom',
        prUrl: PR_STUCK,
        publishedAt: iso(NOW - 45 * 60_000),
        ageMinutes: 45,
      }],
    });
  });

  it('answers 200 known:false when the ledger is missing', async () => {
    const result = await call('GET', runsDir());
    expect(result).toMatchObject({ handled: true, status: 200 });
    expect(result.json).toEqual({
      v: 1, generatedAt: iso(NOW), known: false, thresholdMinutes: 20, stuck: [],
    });
  });

  it('rejects other methods and any query parameter', async () => {
    expect((await call('POST', runsDir(LEDGER))).status).toBe(405);
    const bad = await call('GET', runsDir(LEDGER), `${PATH}?x=1`);
    expect(bad.status).toBe(400);
    expect(bad.json).toMatchObject({ code: 'VERSE_INVALID' });
  });

  it('never leaks the ledger path or file name', async () => {
    const dir = runsDir(LEDGER);
    const result = await call('GET', dir);
    expect(result.status).toBe(200);
    expect(result.payload).not.toContain(dir);
    expect(result.payload).not.toContain('jobs.jsonl');
  });
});
