import type { IncomingMessage, ServerResponse } from 'node:http';
import { expect, it, vi } from 'vitest';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import { CLAIM_EXECUTION_SCHEMA, type ClaimExecutionReport } from '../src/core/fleet/claim-execution-evidence.js';
import { createFleetClaimExecutionApi, VERSE_FLEET_CLAIM_EXECUTION_PATH as PATH, type FleetClaimExecutionResponse } from '../src/core/verse/fleet-claim-execution-api.js';

const stamp = '2026-11-14T18:00:00.000Z';
function report(jobId: string, pid: number): ClaimExecutionReport {
  return {
    schema: CLAIM_EXECUTION_SCHEMA, authority: 'none', asOf: stamp, ledger: 'known', processes: 'healthy',
    rows: [{ claimId: `claim-${jobId}`, agent: 'fake-agent', repo: 'fake/repo', jobId, state: 'RUNNING',
      worker: { pid, lane: 'fake-lane', tier: 'fake-tier', ageSeconds: 1 }, expiresInSeconds: 60 }],
    counts: { running: 1, claimedNoWorker: 0, unknown: 0 }, reasons: [],
  };
}
function deferred() {
  let resolve!: (value: ClaimExecutionReport) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<ClaimExecutionReport>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

it('isolates simultaneous reads and recovers on the same handler', async () => {
  const a = deferred();
  const b = deferred();
  const third = report('RQ-FAKE-C', 3333);
  const read = vi.fn().mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise).mockResolvedValueOnce(third);
  const api = createFleetClaimExecutionApi({ read, now: () => new Date(stamp) });
  function call() {
    const state = { status: 0, text: '', ends: 0 };
    const res = { writeHead(code: number) { state.status = code; return this; },
      end(body: string) { state.ends++; state.text = body; } } as unknown as ServerResponse;
    const done = api({} as VerseApiContext, { url: PATH } as IncomingMessage, res, PATH, 'GET');
    return { state, done };
  }
  const first = call();
  const second = call();
  await Promise.resolve();
  expect(read).toHaveBeenCalledTimes(2);
  const secondReport = report('RQ-FAKE-B', 2222);
  b.resolve(secondReport);
  expect(await second.done).toBe(true);
  expect(first.state.ends).toBe(0);
  a.reject(new Error('private-sentinel-423s'));
  expect(await first.done).toBe(true);
  const recovered = call();
  expect(await recovered.done).toBe(true);
  expect(read).toHaveBeenCalledTimes(3);
  for (const response of [first, second, recovered]) {
    expect(response.state).toMatchObject({ status: 200, ends: 1 });
    expect(response.state.text).not.toContain('private-sentinel-423s');
  }
  const parse = (text: string) => JSON.parse(text) as FleetClaimExecutionResponse;
  expect(parse(second.state.text)).toEqual({ v: 1, authority: 'none', generatedAt: stamp, report: secondReport });
  expect(parse(first.state.text)).toEqual({ v: 1, authority: 'none', generatedAt: stamp, report: {
    schema: CLAIM_EXECUTION_SCHEMA, authority: 'none', asOf: stamp, ledger: 'unavailable', processes: 'unavailable',
    rows: [], counts: { running: 0, claimedNoWorker: 0, unknown: 0 }, reasons: ['claim execution: reader failed'],
  } });
  expect(first.state.text).not.toContain('RQ-FAKE-B');
  expect(parse(recovered.state.text)).toEqual({ v: 1, authority: 'none', generatedAt: stamp, report: third });
});
