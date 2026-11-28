import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { appendBusInbox, listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import { mutateBusWorkClaim } from '../src/core/fleet/bus-work-claims.js';
import { collectBusWorkItemEvidence } from '../src/core/comms/work-item-bus-evidence.js';
import { classifyWorkItem, formatWorkItemStatusLine, type WorkItemEvidence } from '../src/core/comms/work-item-state.js';

const now = Date.parse('2026-11-12T22:30:00.000Z');
const iso = new Date(now).toISOString();
const receivedAt = '2026-11-12T21:00:00.000Z';
const base: WorkItemEvidence = { id: 'fake', receivedAt };
const assignment = { owner: 'fake-owner', claimReceipt: 'fake-claim' };

it('round trips a durable receipt-bound claim into the formatted status', () => {
  const root = mkdtempSync(join(tmpdir(), 'owner-roundtrip-905s-'));
  vi.spyOn(Date, 'now').mockReturnValue(now);
  try {
    expect(appendBusInbox({ id: 'fake-request', from: 'fake-sender', to: 'fake-lane', priority: 'P1',
      ttl: 600000, body: { kind: 'work' } }, { root, now: () => now }).status).toBe('posted');
    expect(mutateBusWorkClaim({ action: 'acquire', id: 'fake-request', owner: 'fake-owner', leaseMs: 60000, root }).status).toBe('acquired');
    const page = listBusInboxAfter(0, 100, { root, now: () => now });
    if (page.status !== 'ok') throw new Error('inbox unavailable');
    const receipt = page.messages[0];
    const { evidence, sources } = collectBusWorkItemEvidence('fake-request', { root, now });
    expect(sources).toEqual({ inbox: 'found', claims: 'available' });
    expect(evidence.claimReceipt).toBe(`bus-claim:fake-request:${receipt.cursor}:${receipt.receivedAt}`);
    const result = classifyWorkItem(evidence, iso);
    expect(result).toEqual({ state: 'RUNNING', owner: 'fake-owner', asOf: iso,
      source: `bus-work-claims lease-until ${new Date(now + 60000).toISOString()}`, missing: [] });
    expect(formatWorkItemStatusLine(result)).toBe(`RUNNING · fake-owner · as of ${iso} · source ${result.source}`);
  } finally {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  }
});

it('preserves only qualified owners without changing state precedence or evidence', () => {
  const runningEvidence = { source: 'heartbeat', at: iso };
  const blocker = { dependency: 'dependency', source: 'blocker', at: iso };
  const verified = { tests: 'passed', source: 'tests', at: iso };
  const cases: [WorkItemEvidence, object][] = [
    [{ ...base, ...assignment }, { state: 'ASSIGNED', owner: 'fake-owner', asOf: receivedAt, source: 'claim:fake-claim', missing: [] }],
    [{ ...base, ...assignment, runningEvidence }, { state: 'RUNNING', owner: 'fake-owner', asOf: iso, source: 'heartbeat', missing: [] }],
    [{ ...base, ...assignment, runningEvidence: { ...runningEvidence, at: receivedAt } }, { state: 'ASSIGNED', owner: 'fake-owner', asOf: receivedAt, source: 'claim:fake-claim', missing: ['fresh running evidence'] }],
    [{ ...base, ...assignment, runningEvidence, blocker }, { state: 'BLOCKED', owner: 'fake-owner', asOf: iso, source: 'blocker', missing: [] }],
    [{ ...base, blocker }, { state: 'BLOCKED', asOf: iso, source: 'blocker', missing: [] }],
    [{ ...base, ...assignment, blocker, verified }, { state: 'VERIFIED', owner: 'fake-owner', asOf: iso, source: 'tests', missing: [] }],
    [{ ...base, verified }, { state: 'VERIFIED', asOf: iso, source: 'tests', missing: [] }],
    [{ ...base, owner: 'fake-owner' }, { state: 'RECEIVED', asOf: receivedAt, source: 'receivedAt', missing: ['durable claim receipt'] }],
    [{ ...base, owner: 'fake-owner', claimReceipt: '  ' }, { state: 'RECEIVED', asOf: receivedAt, source: 'receivedAt', missing: ['durable claim receipt'] }],
    [{ ...base, claimReceipt: 'fake-claim' }, { state: 'RECEIVED', asOf: receivedAt, source: 'receivedAt', missing: ['named owner'] }],
  ];
  for (const [evidence, expected] of cases) expect(classifyWorkItem(evidence, iso)).toEqual(expected);
  expect(formatWorkItemStatusLine(classifyWorkItem(base, iso))).toContain('owner unknown');
  const sanitized = classifyWorkItem({ ...base, owner: 'fake\nowner\u0000name', claimReceipt: 'claim' }, iso);
  expect(formatWorkItemStatusLine(sanitized)).toContain('fake owner name');
});
