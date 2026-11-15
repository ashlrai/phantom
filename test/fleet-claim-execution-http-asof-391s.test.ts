/** RQ-PHX-CLAIMHTTPASOF391S — GET
 * /api/verse/fleet/runtime-identity/claim-execution must qualify a
 * reader-supplied report's `asOf` at response observation time: a retained
 * report whose stamp is missing, invalid, ahead of the response clock, or
 * older than PROCESS_SNAPSHOT_MAX_AGE_MS degrades to bounded UNKNOWN
 * evidence with a fixed sanitized reason — never retained RUNNING
 * rows/counts under a new response timestamp. The observation clock is
 * sampled after the read settles so a fresh stamp is never seen as
 * future-dated. Fixtures are plainly fake; nothing touches the real home,
 * `ps` or network. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import type { ApiModule } from '../src/core/verse/api-modules.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import {
  CLAIM_EXECUTION_SCHEMA,
  PROCESS_SNAPSHOT_MAX_AGE_MS,
  type ClaimExecutionReport,
} from '../src/core/fleet/claim-execution-evidence.js';
import {
  createFleetClaimExecutionApi,
  VERSE_FLEET_CLAIM_EXECUTION_PATH as PATH,
} from '../src/core/verse/fleet-claim-execution-api.js';

const NOW = new Date('2026-11-14T18:00:00.000Z');
const NOW_MS = NOW.getTime();
const NOW_ISO = NOW.toISOString();
const STALE_AS_OF_REASON = 'claim execution report: missing or invalid asOf';
const FUTURE_AS_OF_REASON = 'claim execution report: asOf ahead of response clock';
const OLD_AS_OF_REASON = 'claim execution report: asOf older than freshness bound';
const READ_DEADLINE_REASON = 'claim execution: read deadline exceeded';

function reportAt(asOf: unknown): ClaimExecutionReport {
  return {
    schema: CLAIM_EXECUTION_SCHEMA,
    authority: 'none',
    asOf: asOf as string,
    ledger: 'known',
    processes: 'healthy',
    rows: [
      {
        claimId: 'claim-fake-391s',
        agent: 'agent-fake-391s',
        repo: 'ashlrai/phantom',
        jobId: 'RQ-PHX-FAKEJOB391S',
        state: 'RUNNING',
        worker: { pid: 9911, lane: 'fake-lane', tier: 'fake-tier', ageSeconds: 60 },
        expiresInSeconds: 300,
      },
    ],
    counts: { running: 1, claimedNoWorker: 0, unknown: 0 },
    reasons: [],
  };
}

const FRESH_REPORT = reportAt(NOW_ISO);

function unknownBody(reason: string) {
  return {
    schema: CLAIM_EXECUTION_SCHEMA,
    authority: 'none',
    asOf: NOW_ISO,
    ledger: 'unavailable',
    processes: 'unavailable',
    rows: [],
    counts: { running: 0, claimedNoWorker: 0, unknown: 0 },
    reasons: [reason],
  };
}

// `path` arrives already stripped of the query (the router keeps it in req.url).
async function call(api: ApiModule, method = 'GET', path = PATH, url = path) {
  const state = { status: 0, text: '', ends: 0 };
  const res = {
    writeHead(code: number) { state.status = code; return this; },
    end(body: string) { state.ends += 1; state.text = body; },
  } as unknown as ServerResponse;
  const req = { url } as IncomingMessage;
  const handled = await api({} as VerseApiContext, req, res, path, method);
  return { handled, ...state, body: state.text ? JSON.parse(state.text) : null };
}

function apiWithRead(read: () => Promise<ClaimExecutionReport>, deadlineMs?: number) {
  return createFleetClaimExecutionApi({ read, now: () => NOW, deadlineMs });
}

describe('claim-execution HTTP asOf qualification', () => {
  it('passes a fresh report through unchanged', async () => {
    const read = vi.fn(async () => FRESH_REPORT);
    const r = await call(apiWithRead(read));
    expect(r).toMatchObject({ handled: true, status: 200, ends: 1 });
    expect(r.body).toEqual({
      v: 1, authority: 'none', generatedAt: NOW_ISO, report: FRESH_REPORT,
    });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('awaits the reader and samples the response clock only after it settles', async () => {
    const order: string[] = [];
    const read = vi.fn(async () => {
      await new Promise(resolve => setTimeout(resolve, 5));
      order.push('read');
      return reportAt(NOW_ISO);
    });
    const api = createFleetClaimExecutionApi({
      read,
      now: () => { order.push('now'); return NOW; },
    });
    const r = await call(api);
    expect(r).toMatchObject({ handled: true, status: 200, ends: 1 });
    expect(order).toEqual(['read', 'now']);
    expect(r.body.report).toEqual(FRESH_REPORT);
  });

  it('accepts a report stamped exactly at the freshness bound', async () => {
    const read = vi.fn(async () => reportAt(new Date(NOW_MS - PROCESS_SNAPSHOT_MAX_AGE_MS).toISOString()));
    const r = await call(apiWithRead(read));
    expect(r.status).toBe(200);
    expect(r.body.report.rows[0]).toMatchObject({ state: 'RUNNING', worker: { pid: 9911 } });
    expect(r.body.report.counts).toEqual({ running: 1, claimedNoWorker: 0, unknown: 0 });
  });

  it('degrades a report one ms past the freshness bound to bounded UNKNOWN', async () => {
    const read = vi.fn(async () =>
      reportAt(new Date(NOW_MS - PROCESS_SNAPSHOT_MAX_AGE_MS - 1).toISOString()));
    const r = await call(apiWithRead(read));
    expect(r).toMatchObject({ handled: true, status: 200, ends: 1 });
    expect(r.body.report).toEqual(unknownBody(OLD_AS_OF_REASON));
    expect(r.text).not.toContain('RUNNING');
    expect(r.text).not.toContain('9911');
  });

  it('degrades a future-stamped report to bounded UNKNOWN', async () => {
    const read = vi.fn(async () => reportAt(new Date(NOW_MS + 1).toISOString()));
    const r = await call(apiWithRead(read));
    expect(r.body.report).toEqual(unknownBody(FUTURE_AS_OF_REASON));
  });

  it.each([
    ['empty', ''],
    ['unparseable', 'bogus-391s-stamp'],
    ['missing', undefined],
    ['null', null],
    ['non-string', 42],
  ])('degrades a report with %s asOf to bounded UNKNOWN without leaking the stamp', async (_name, asOf) => {
    const read = vi.fn(async () => reportAt(asOf));
    const r = await call(apiWithRead(read));
    expect(r.body.report).toEqual(unknownBody(STALE_AS_OF_REASON));
    expect(r.text).not.toContain('bogus-391s-stamp');
  });

  it('recovers immediately when a subsequent read returns a fresh report', async () => {
    const read = vi.fn()
      .mockImplementationOnce(async () => reportAt(new Date(NOW_MS - PROCESS_SNAPSHOT_MAX_AGE_MS - 1).toISOString()))
      .mockImplementationOnce(async () => FRESH_REPORT);
    const api = apiWithRead(read);
    const stale = await call(api);
    expect(stale.body.report).toEqual(unknownBody(OLD_AS_OF_REASON));
    const fresh = await call(api);
    expect(fresh.body.report).toEqual(FRESH_REPORT);
    expect(fresh.body.report.rows[0]).toMatchObject({ state: 'RUNNING' });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('writes no second response when a stalled read settles after the deadline', async () => {
    let settle!: (report: ClaimExecutionReport) => void;
    const read = vi.fn(() => new Promise<ClaimExecutionReport>(resolve => { settle = resolve; }));
    const api = apiWithRead(read, 20);
    const r = await call(api);
    expect(r).toMatchObject({ handled: true, status: 200, ends: 1 });
    expect(r.body.report).toEqual(unknownBody(READ_DEADLINE_REASON));
    settle(FRESH_REPORT);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(r.ends).toBe(1);
    expect(r.body.report).toEqual(unknownBody(READ_DEADLINE_REASON));
  });
});
