/** Synthetic HTTP serialization → desktop consumption; no live host or install evidence. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import {
  CLAIM_EXECUTION_SCHEMA, PROCESS_SNAPSHOT_MAX_AGE_MS, type ClaimExecutionReport,
} from '../src/core/fleet/claim-execution-evidence.js';
import {
  createFleetClaimExecutionApi, VERSE_FLEET_CLAIM_EXECUTION_PATH as PATH,
} from '../src/core/verse/fleet-claim-execution-api.js';
import {
  parseClaimExecution, claimExecutionHeadline,
} from '../src/web-ui/routes/verse/fleet-host/claim-execution-model.js';

const NOW = new Date('2026-11-17T18:00:00.000Z');
const RAW_MARKER = 'fake-host-reader-threw-536s';
const FRESH: ClaimExecutionReport = {
  schema: CLAIM_EXECUTION_SCHEMA, authority: 'none', asOf: NOW.toISOString(),
  ledger: 'known', processes: 'healthy',
  rows: [{
    claimId: 'claim-fake-536s', agent: 'owner-fake-536s', repo: 'fake-owner/fake-repo',
    jobId: 'RQ-FAKE-536S', state: 'RUNNING', expiresInSeconds: 300,
    worker: { pid: 9536, lane: 'fake-lane', tier: 'work', ageSeconds: 12 },
  }],
  counts: { running: 1, claimedNoWorker: 0, unknown: 0 }, reasons: [],
};

// Same response harness as the route tests: capture sendJson's actual wire body.
async function roundTrip(reader: () => Promise<ClaimExecutionReport>) {
  const read = vi.fn(reader);
  const api = createFleetClaimExecutionApi({ read, now: () => NOW });
  const response = { status: 0, text: '', ends: 0 };
  const res = {
    writeHead(code: number) { response.status = code; return this; },
    end(body: string) { response.text = body; response.ends++; },
  } as unknown as ServerResponse;
  const handled = await api({} as VerseApiContext, { url: PATH } as IncomingMessage, res, PATH, 'GET');
  expect({ handled, status: response.status, ends: response.ends }).toEqual({ handled: true, status: 200, ends: 1 });
  expect(read).toHaveBeenCalledTimes(1);
  const body: unknown = JSON.parse(response.text);
  expect(body).toMatchObject({ v: 1, authority: 'none', generatedAt: NOW.toISOString() });
  const parsed = parseClaimExecution(body);
  return { raw: response.text, parsed, headline: claimExecutionHeadline(parsed) };
}

describe('claim-report HTTP JSON to desktop headline (536s)', () => {
  it('preserves a fresh named owner, claim and RUNNING worker', async () => {
    const { parsed, headline } = await roundTrip(async () => FRESH);
    expect(parsed.kind).toBe('ok');
    if (parsed.kind !== 'ok') throw new Error('desktop parser rejected valid HTTP evidence');
    expect(parsed.rows).toEqual([{
      claimId: 'claim-fake-536s', agent: 'owner-fake-536s', repo: 'fake-owner/fake-repo',
      jobId: 'RQ-FAKE-536S', state: 'RUNNING', expiresInSeconds: 300,
      worker: { pid: 9536, lane: 'fake-lane', ageSeconds: 12 },
    }]);
    expect(parsed.counts).toEqual({ running: 1, claimedNoWorker: 0, unknown: 0 });
    expect(headline).toEqual({ text: '1 running', tone: 'ok' });
  });

  it.each([
    ['rejecting reader', async (): Promise<ClaimExecutionReport> => { throw new Error(RAW_MARKER); },
      'claim execution: reader failed'],
    ['retained stale report', async (): Promise<ClaimExecutionReport> => ({
      ...FRESH, asOf: new Date(NOW.getTime() - PROCESS_SNAPSHOT_MAX_AGE_MS - 1).toISOString(),
    }), 'claim execution report: asOf older than freshness bound'],
  ] as const)('shows UNKNOWN for %s without advertising an empty or running host', async (_name, read, reason) => {
    const { raw, parsed, headline } = await roundTrip(read);
    expect(parsed).toMatchObject({
      kind: 'ok', ledger: 'unavailable', processes: 'unavailable', rows: [],
      counts: { running: 0, claimedNoWorker: 0, unknown: 0 }, reasons: [reason],
    });
    expect(headline).toEqual({ text: `Claim execution unknown: ${reason}`, tone: 'unknown' });
    expect(headline.text).not.toContain('No live claims');
    expect(headline.text).not.toMatch(/\d+\s+running/i);
    expect(raw).not.toContain('RUNNING');
    expect(raw).not.toContain('claim-fake-536s');
    expect(raw).not.toContain(RAW_MARKER);
    expect(headline.text).not.toContain(RAW_MARKER);
  });
});
