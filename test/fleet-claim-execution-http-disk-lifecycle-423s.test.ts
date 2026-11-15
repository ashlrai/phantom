/** GET /api/verse/fleet/runtime-identity/claim-execution — durable ledger
 * lifecycle over real scratch-file reads: missing ledger, two acquired claims
 * (one with a matching worker, one without), authenticated concludeFleetClaim
 * return, releaseFleetClaim, unreadable/corrupt ledger, restored ledger. One
 * handler instance throughout; only clock, process snapshot and ledger path
 * are injected. Reads must never mutate the ledger bytes. */
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ApiModule } from '../src/core/verse/api-modules.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import {
  claimFleetWork, concludeFleetClaim, readFleetBoard, releaseFleetClaim,
} from '../src/core/fleet/coordination.js';
import { readClaimExecution } from '../src/core/fleet/claim-execution-evidence.js';
import type { LiveWorkersSnapshot } from '../src/core/fleet/runs-live-workers.js';
import { createFleetRuntimeIdentityApi } from '../src/core/verse/fleet-runtime-identity-api.js';
import {
  createFleetClaimExecutionApi,
  VERSE_FLEET_CLAIM_EXECUTION_PATH as PATH,
} from '../src/core/verse/fleet-claim-execution-api.js';

const NOW = Date.parse('2026-11-14T14:00:00.000Z');
const STAMP = new Date(NOW).toISOString();
const PRIVATE = 'fake private task text';
const RETURN_BODY = 'fake private return body';

const WORKERS: LiveWorkersSnapshot = {
  v: 1, generatedAt: STAMP, sourceState: 'healthy',
  workers: [{ pid: 4242, job: 'RQ-PHX-FAKEJOB1', repo: 'fake-repo', lane: 'fake-lane', tier: 'work', ageSeconds: 30 }],
  leaders: [], orchestratorAgents: 0,
};

async function call(api: ApiModule) {
  const state = { status: 0, text: '', ends: 0 };
  const res = {
    writeHead(code: number) { state.status = code; return this; },
    end(body: string) { state.ends += 1; state.text = body; },
  } as unknown as ServerResponse;
  const req = { url: PATH } as IncomingMessage;
  const handled = await api({} as VerseApiContext, req, res, PATH, 'GET');
  return { handled, ...state, body: state.text ? JSON.parse(state.text) : null };
}

describe('claim-execution HTTP durable ledger lifecycle', () => {
  it('observes acquisition, return, release and recovery through one handler', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claim-execution-http-423s-'));
    const path = join(dir, 'coordination.jsonl');
    const saved = join(dir, 'saved.jsonl');
    const api = createFleetRuntimeIdentityApi({
      claimExecution: createFleetClaimExecutionApi({
        read: () => readClaimExecution({
          board: options => readFleetBoard({ ...options, path }),
          workers: async () => WORKERS,
          now: () => NOW,
        }),
        now: () => new Date(NOW),
      }),
      now: () => new Date(NOW),
    });
    const read = async () => {
      let before: Buffer | null;
      try { before = readFileSync(path); } catch { before = null; }
      const r = await call(api);
      expect(r).toMatchObject({ handled: true, status: 200, ends: 1 });
      expect(r.body).toMatchObject({ v: 1, authority: 'none', generatedAt: STAMP });
      if (before === null) expect(() => readFileSync(path)).toThrow();
      else expect(readFileSync(path)).toEqual(before);
      expect(r.body.report).toMatchObject({ authority: 'none', asOf: STAMP });
      return { body: r.body, text: r.text as string };
    };
    try {
      const missing = await read();
      expect(missing.body.report).toMatchObject({
        ledger: 'unavailable', processes: 'healthy', rows: [],
        counts: { running: 0, claimedNoWorker: 0, unknown: 0 },
      });

      const running = claimFleetWork(
        { repo: 'fake-owner/fake-repo', task: `RQ-PHX-FAKEJOB1 ${PRIVATE}`, agent: 'fake-agent', ttlMs: 86_400_000 },
        { path, now: NOW - 1000 });
      const waiting = claimFleetWork(
        { repo: 'fake-owner/fake-repo', task: `RQ-PHX-FAKEJOB2 ${PRIVATE}`, agent: 'fake-agent-2', ttlMs: 86_400_000 },
        { path, now: NOW - 1000 });
      if (!running.ok || !waiting.ok) throw new Error('fake claim acquisition failed');

      const acquired = await read();
      expect(acquired.text).not.toContain(PRIVATE);
      expect(acquired.text).not.toContain(running.value.lease);
      expect(acquired.body.report).toMatchObject({
        ledger: 'known', processes: 'healthy',
        counts: { running: 1, claimedNoWorker: 1, unknown: 0 },
      });
      expect(acquired.body.report.rows).toHaveLength(2);
      expect(acquired.body.report.rows).toEqual(expect.arrayContaining([
        expect.objectContaining({
          claimId: running.value.claim.id, agent: 'fake-agent', repo: 'fake-owner/fake-repo',
          jobId: 'RQ-PHX-FAKEJOB1', state: 'RUNNING', expiresInSeconds: 86399,
          worker: { pid: 4242, lane: 'fake-lane', tier: 'work', ageSeconds: 30 },
        }),
        expect.objectContaining({
          claimId: waiting.value.claim.id, agent: 'fake-agent-2',
          jobId: 'RQ-PHX-FAKEJOB2', state: 'CLAIMED_NO_WORKER', worker: null,
        }),
      ]));

      const returned = concludeFleetClaim({
        id: running.value.claim.id, agent: 'fake-agent', lease: running.value.lease,
        message: { id: 'fake-return-1', from: 'fake-agent', to: 'fake-owner', body: RETURN_BODY },
      }, { path, now: NOW });
      expect(returned.ok).toBe(true);
      const afterReturn = await read();
      expect(afterReturn.text).not.toContain(RETURN_BODY);
      expect(afterReturn.body.report).toMatchObject({
        ledger: 'known', processes: 'healthy',
        counts: { running: 0, claimedNoWorker: 1, unknown: 0 },
      });
      expect(afterReturn.body.report.rows).toHaveLength(1);
      expect(afterReturn.body.report.rows[0]).toMatchObject({
        claimId: waiting.value.claim.id, agent: 'fake-agent-2', jobId: 'RQ-PHX-FAKEJOB2',
      });

      expect(releaseFleetClaim(
        { id: waiting.value.claim.id, agent: 'fake-agent-2', lease: waiting.value.lease },
        { path, now: NOW }).ok).toBe(true);
      const afterRelease = await read();
      expect(afterRelease.body.report).toMatchObject({
        ledger: 'known', rows: [],
        counts: { running: 0, claimedNoWorker: 0, unknown: 0 },
      });

      renameSync(path, saved);
      expect((await read()).body.report).toMatchObject({ ledger: 'unavailable', rows: [] });
      writeFileSync(path, 'invalid ledger\n');
      expect((await read()).body.report).toMatchObject({ ledger: 'unavailable', rows: [] });
      rmSync(path);
      renameSync(saved, path);
      expect((await read()).body.report).toMatchObject({
        ledger: 'known', rows: [],
        counts: { running: 0, claimedNoWorker: 0, unknown: 0 },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
