import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { validateBusEnvelope } from './bus-envelope.js';
import { CHANNEL_BUS_TTL_MS } from './channel-bus-publish.js';
import { buildResetReleaseEnvelope, postResetReleaseNotice } from './reset-release-bus-notice.js';
import { runResetReleaseOnce, type ResetReleaseRecord } from './usage-reset-release.js';
import type { UsageResetRow } from './usage-reset-detect.js';

const at = '2026-10-31T19:28:00.000Z';
const now = () => Date.parse(at);
const record: ResetReleaseRecord = {
  v: 1, at, by: 'reset-detect', lane: 'codex-personal', state: 'reset-detected',
  reason: 'window reset: reads 3% at 2026-10-31T19:10:00Z', usedPct: 3,
  readingAsOf: '2026-10-31T19:10:00Z', heldUntil: '2026-11-04T00:00:00Z',
};

it('builds a valid deterministic broadcast with bounded text', () => {
  const envelope = buildResetReleaseEnvelope(record);
  expect(validateBusEnvelope(envelope).ok).toBe(true);
  expect(envelope).toEqual({
    id: expect.stringMatching(/^fleet-lane-released-[0-9a-f]{16}$/),
    from: 'fleet', to: 'all', priority: 'P2', ttl: CHANNEL_BUS_TTL_MS,
    body: { kind: 'lane-released', lane: record.lane, at, by: record.by, reason: record.reason,
      usedPct: 3, readingAsOf: record.readingAsOf, heldUntil: record.heldUntil,
      text: `${record.lane} released: ${record.reason}` },
  });
  expect(buildResetReleaseEnvelope(record).id).toBe(envelope.id);
  expect(buildResetReleaseEnvelope({ ...record, lane: 'another-lane' }).id).not.toBe(envelope.id);
  const long = buildResetReleaseEnvelope({ ...record, reason: 'x'.repeat(300) });
  expect((long.body as { text: string }).text).toHaveLength(200);
});

it('reports a throwing post as unavailable', () => {
  expect(postResetReleaseNotice(record, () => { throw new Error('offline'); }))
    .toEqual({ lane: record.lane, status: 'unavailable' });
});

it('posts once and deduplicates an identical notice in the real inbox', async () => {
  const root = await mkdtemp(join(tmpdir(), 'reset-bus-'));
  try {
    expect(postResetReleaseNotice(record, undefined, { root, now }).status).toBe('posted');
    expect(postResetReleaseNotice(record, undefined, { root, now }).status).toBe('duplicate');
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('keeps releases and audit records when the bus is full, and continues to the next lane', async () => {
  const runsDir = await mkdtemp(join(tmpdir(), 'reset-bus-run-'));
  try {
    const row = (lane: string): UsageResetRow => ({
      lane, held: true, heldReason: 'autobackoff fake', heldUntil: record.heldUntil,
      holdSince: '2026-10-31T19:00:00Z', heldBy: 'autobackoff', usedPct: record.usedPct,
      readingAsOf: record.readingAsOf, resetAt: null, state: 'reset-detected', releasable: true, tell: '',
    });
    const postBus = vi.fn(() => ({ status: 'full' as const }));
    const release = vi.fn(async () => ({ v: 1 as const, generatedAt: at, sourceState: 'healthy' as const, lanes: [] }));
    const result = await runResetReleaseOnce({
      runsDir, busRoot: join(runsDir, 'bus'), now, postBus, release,
      read: async () => ({ v: 1, generatedAt: at, sourceState: 'healthy', rows: [row(record.lane), row('lane-b')] }),
    });
    expect(result.released.map((r) => r.lane)).toEqual([record.lane, 'lane-b']);
    expect(result.errors).toEqual([]);
    expect(result.bus).toEqual([{ lane: record.lane, status: 'full' }, { lane: 'lane-b', status: 'full' }]);
    expect(release).toHaveBeenCalledTimes(2);
    const lines = (await readFile(join(runsDir, 'queue/reset-releases.jsonl'), 'utf8')).trim().split('\n');
    const records = lines.map((line) => JSON.parse(line) as ResetReleaseRecord);
    expect(records).toHaveLength(2);
    expect(records[0]).toEqual(record);
    expect(postBus).toHaveBeenCalledTimes(2);
    expect(postBus).toHaveBeenNthCalledWith(1, buildResetReleaseEnvelope(records[0]!), { root: join(runsDir, 'bus'), now: expect.any(Function) });
  } finally { await rm(runsDir, { recursive: true, force: true }); }
});
