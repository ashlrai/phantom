import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import { mutateBusWorkClaim } from '../src/core/fleet/bus-work-claims.js';
import { collectBusWorkItemEvidence } from '../src/core/comms/work-item-bus-evidence.js';
import { RUNNING_FRESH_MS } from '../src/core/comms/work-item-state.js';
import { cmdFleetWorkTrace } from '../src/cli/fleet-work-trace.js';

let root: string, now: number;
const id = 'fake-request-996s';
const leaseMs = 120_000;
function post(name: string, body: Record<string, unknown>) {
  expect(appendBusInbox({ id: name, from: 'fake-host', to: 'fake-lane', priority: 'P1',
    ttl: 10_000_000, body }, { root, now: () => now }).status).toBe('posted');
}
async function run(json: boolean, request = id) {
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  expect(await cmdFleetWorkTrace(['--id', request, '--root', root, ...(json ? ['--json'] : [])])).toBe(0);
  const output = String(log.mock.calls[0]![0]);
  log.mockRestore();
  return output;
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'trace-running-996s-'));
  chmodSync(root, 0o700);
  now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  post(id, { kind: 'work' });
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

it('reports the collector’s lease evidence in both formats', async () => {
  const claim = mutateBusWorkClaim({ action: 'acquire', id, owner: 'fake-worker', leaseMs, root });
  expect(claim.status).toBe('acquired');
  now += 5_000;
  const evidence = collectBusWorkItemEvidence(id, { root, now }).evidence.runningEvidence;
  expect(evidence).toEqual({ source: `bus-work-claims lease-until ${new Date(now - 5_000 + leaseMs).toISOString()}`,
    at: new Date(now).toISOString() });
  const json = await run(true), text = await run(false);
  expect(JSON.parse(json)).toMatchObject({ state: 'RUNNING', owner: 'fake-worker',
    claimReceipt: `bus-claim:${id}:1:${now - 5_000}`, runningEvidence: evidence });
  expect(text).toContain(`runningEvidence=${JSON.stringify(evidence)}`);
  expect(json).not.toContain(claim.token!);
  expect(text).not.toContain(claim.token!);
});

it('does not present stale or unknown evidence as current', async () => {
  mutateBusWorkClaim({ action: 'acquire', id, owner: 'fake-worker', leaseMs, root });
  now += leaseMs + RUNNING_FRESH_MS + 1;
  expect(collectBusWorkItemEvidence(id, { root, now }).evidence.runningEvidence).toBeDefined();
  expect(JSON.parse(await run(true))).toMatchObject({ state: 'ASSIGNED', owner: 'fake-worker' });
  for (const output of [await run(true), await run(false), await run(true, 'fake-unknown'), await run(false, 'fake-unknown')]) {
    expect(output).not.toContain('runningEvidence');
  }
  expect(JSON.parse(await run(true, 'fake-unknown'))).toMatchObject({ state: 'RECEIVED', asOf: 'unknown' });
});

it('preserves result proof without exposing a current lease for a blocked item', async () => {
  mutateBusWorkClaim({ action: 'acquire', id, owner: 'fake-worker', leaseMs, root });
  now += 1_000;
  post('fake-reply', { kind: 'work', inReplyTo: id, blocked: { dependency: 'fake-dependency' } });
  const json = JSON.parse(await run(true));
  expect(json).toMatchObject({ state: 'BLOCKED', owner: 'fake-worker', result: { kind: 'blocked', dependency: 'fake-dependency' } });
  expect(json.runningEvidence).toBeUndefined();
  expect(await run(false)).toContain('result={"kind":"blocked","dependency":"fake-dependency"}');
});
