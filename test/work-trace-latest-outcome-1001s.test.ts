import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import { mutateBusWorkClaim } from '../src/core/fleet/bus-work-claims.js';
import { collectBusWorkItemEvidence } from '../src/core/comms/work-item-bus-evidence.js';
import { cmdFleetWorkTrace } from '../src/cli/fleet-work-trace.js';

let root: string;
const now = Date.parse('2026-11-26T12:00:00Z');
function post(id: string, body: Record<string, unknown>, at: number, from = 'peer') {
  expect(appendBusInbox({ id, from, to: 'lane', priority: 'P1', ttl: 10_000_000, body },
    { root, now: () => at }).status).toBe('posted');
}
async function trace() {
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  try {
    expect(await cmdFleetWorkTrace(['--id', 'request', '--root', root, '--json'])).toBe(0);
    return JSON.parse(String(log.mock.calls[0]![0]));
  } finally { log.mockRestore(); }
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'latest-outcome-'));
  chmodSync(root, 0o700);
  vi.spyOn(Date, 'now').mockReturnValue(now);
  post('request', { kind: 'work' }, now - 5000);
  mutateBusWorkClaim({ action: 'acquire', id: 'request', owner: 'worker', leaseMs: 600_000, root });
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

it('reports a later blocker by cursor despite clock rollback and ignores invalid replies', async () => {
  post('verified', { inReplyTo: 'request', verified: { tests: 'passed' } }, now - 1000);
  post('blocked', { inReplyTo: 'request', blocked: { dependency: 'PR 123' } }, now - 2000);
  post('plain', { inReplyTo: 'request', text: 'hello' }, now - 500);
  post('bad', { inReplyTo: 'request', verified: { pr: 123 } }, now - 400);
  post('other', { inReplyTo: 'other-request', verified: { tests: 'other thread' } }, now - 300, 'other-peer');
  post('future', { inReplyTo: 'request', verified: { tests: 'future' } }, now + 600_000);
  expect(await trace()).toMatchObject({ state: 'BLOCKED', source: 'bus-reply:blocked',
    asOf: new Date(now - 2000).toISOString(), owner: 'worker', result: { kind: 'blocked', dependency: 'PR 123' } });
  expect(collectBusWorkItemEvidence('request', { root, now }).evidence.verified).toMatchObject({ tests: 'passed' });
});

it('reports a later verified proof and retains the blocker candidate', async () => {
  post('blocked', { inReplyTo: 'request', blocked: { dependency: 'PR 123' } }, now - 1000);
  post('verified', { inReplyTo: 'request', verified: { tests: 'passed' } }, now - 2000);
  expect(await trace()).toMatchObject({ state: 'VERIFIED', source: 'bus-reply:verified',
    asOf: new Date(now - 2000).toISOString(), result: { kind: 'verified', tests: 'passed' } });
  expect(collectBusWorkItemEvidence('request', { root, now }).evidence.blocker).toMatchObject({ dependency: 'PR 123' });
});

it('prefers verified when one receipt contains both valid outcomes', async () => {
  post('both', { inReplyTo: 'request', blocked: { dependency: 'PR 123' }, verified: { artifact: 'report' } }, now - 1000);
  expect(await trace()).toMatchObject({ state: 'VERIFIED', source: 'bus-reply:both',
    asOf: new Date(now - 1000).toISOString(), result: { kind: 'verified', artifact: 'report' } });
});
