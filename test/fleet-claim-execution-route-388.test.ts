/** GET /api/verse/fleet/runtime-identity/claim-execution — sanitized claim execution evidence. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import type { ApiModule } from '../src/core/verse/api-modules.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import {
  CLAIM_EXECUTION_SCHEMA,
  type ClaimExecutionReport,
} from '../src/core/fleet/claim-execution-evidence.js';
import type { RuntimeIdentityDeps } from '../src/core/fleet/runtime-identity.js';
import {
  createFleetRuntimeIdentityApi,
} from '../src/core/verse/fleet-runtime-identity-api.js';
import {
  createFleetClaimExecutionApi,
  VERSE_FLEET_CLAIM_EXECUTION_PATH as PATH,
} from '../src/core/verse/fleet-claim-execution-api.js';

const NOW = new Date('2026-11-14T18:00:00.000Z');
const READER_FAILED_REASON = 'claim execution: reader failed';
const READ_DEADLINE_REASON = 'claim execution: read deadline exceeded';

const FAKE_REPORT: ClaimExecutionReport = {
  schema: CLAIM_EXECUTION_SCHEMA,
  authority: 'none',
  asOf: NOW.toISOString(),
  ledger: 'known',
  processes: 'healthy',
  rows: [
    {
      claimId: 'claim-fake-1',
      agent: 'agent-fake-1',
      repo: 'ashlrai/phantom',
      jobId: 'RQ-PHX-FAKEJOB1',
      state: 'RUNNING',
      worker: { pid: 4321, lane: 'fake-lane', tier: 'fake-tier', ageSeconds: 120 },
      expiresInSeconds: 300,
    },
  ],
  counts: { running: 1, claimedNoWorker: 0, unknown: 0 },
  reasons: [],
};

const UNKNOWN_REPORT: ClaimExecutionReport = {
  schema: CLAIM_EXECUTION_SCHEMA,
  authority: 'none',
  asOf: NOW.toISOString(),
  ledger: 'unavailable',
  processes: 'unavailable',
  rows: [],
  counts: { running: 0, claimedNoWorker: 0, unknown: 0 },
  reasons: [READER_FAILED_REASON],
};

const identityDeps: RuntimeIdentityDeps = {
  hostname: () => 'fake-host', platform: () => 'fake-os', now: () => NOW,
  homeDir: () => '/fake-home', statePath: () => '/fake-home/state.json',
  statMtimeMs: () => NOW.getTime() - 1000,
  readSourcePackageJson: () => '{"version":"1.0.0"}',
  installedVersion: () => '1.0.0',
  exec: () => { throw new Error('no tailnet'); },
};

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
  return createFleetRuntimeIdentityApi({
    claimExecution: createFleetClaimExecutionApi({ read, now: () => NOW, deadlineMs }),
    identityDeps,
    now: () => NOW,
  });
}

describe('claim-execution HTTP route', () => {
  it('answers the injected report with one RUNNING row', async () => {
    const read = vi.fn(async () => FAKE_REPORT);
    const r = await call(apiWithRead(read));
    expect(r).toMatchObject({ handled: true, status: 200, ends: 1 });
    expect(r.body).toEqual({
      v: 1, authority: 'none', generatedAt: NOW.toISOString(), report: FAKE_REPORT,
    });
    expect(r.body.report.rows[0]).toMatchObject({ jobId: 'RQ-PHX-FAKEJOB1', state: 'RUNNING' });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('rejects POST with 405 before any read', async () => {
    const read = vi.fn(async () => FAKE_REPORT);
    const r = await call(apiWithRead(read), 'POST');
    expect(r).toMatchObject({ handled: true, status: 405, body: { error: 'method not allowed' } });
    expect(read).not.toHaveBeenCalled();
  });

  it.each([`${PATH}?x=1`, `${PATH}?surface=coordination`, `${PATH}?a=1&b=2`])(
    'rejects %s with 400 before any read',
    async url => {
      const read = vi.fn(async () => FAKE_REPORT);
      const r = await call(apiWithRead(read), 'GET', PATH, url);
      expect(r).toMatchObject({ handled: true, status: 400 });
      expect(r.body).toEqual({ v: 1, authority: 'none', error: 'no query accepted' });
      expect(read).not.toHaveBeenCalled();
    },
  );

  it('degrades a throwing reader to UNKNOWN without leaking the message', async () => {
    const read = vi.fn(async () => { throw new Error('/Users/someone/secret'); });
    const r = await call(apiWithRead(read));
    expect(r).toMatchObject({ handled: true, status: 200, ends: 1 });
    expect(r.body.report).toEqual(UNKNOWN_REPORT);
    expect(r.text).not.toContain('/Users/');
    expect(r.text).not.toContain('secret');
  });

  it('answers UNKNOWN at the deadline when the read never settles', async () => {
    const read = vi.fn(() => new Promise<ClaimExecutionReport>(() => {}));
    const r = await call(apiWithRead(read, 20));
    expect(r).toMatchObject({ handled: true, status: 200, ends: 1 });
    expect(r.body.report).toEqual({ ...UNKNOWN_REPORT, reasons: [READ_DEADLINE_REASON] });
  });

  it('routes the path before the hostReach fallthrough', async () => {
    const claimExecution = vi.fn<ApiModule>(
      createFleetClaimExecutionApi({ read: async () => FAKE_REPORT, now: () => NOW }),
    );
    const hostReach = vi.fn<ApiModule>(async () => false);
    const api = createFleetRuntimeIdentityApi({ claimExecution, hostReach, identityDeps, now: () => NOW });
    const r = await call(api);
    expect(r).toMatchObject({ handled: true, status: 200 });
    expect(claimExecution.mock.calls[0]!.slice(3)).toEqual([PATH, 'GET']);
    expect(hostReach).not.toHaveBeenCalled();
  });

  it('answers through the default claimExecution module without touching hostReach', async () => {
    const hostReach = vi.fn<ApiModule>(async () => false);
    const api = createFleetRuntimeIdentityApi({ hostReach, identityDeps, now: () => NOW });
    const r = await call(api);
    expect(r).toMatchObject({ handled: true, status: 200, ends: 1 });
    expect(r.body).toMatchObject({
      v: 1, authority: 'none', generatedAt: expect.any(String),
      report: { schema: CLAIM_EXECUTION_SCHEMA, authority: 'none' },
    });
    expect(hostReach).not.toHaveBeenCalled();
  });
});
