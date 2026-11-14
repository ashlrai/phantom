import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { readOrderTrace, type OrderTraceV1 } from '../src/core/fleet/order-trace.js';

// Fixture layout mirrors the supported runs root: leader/MASON-INBOX.md for
// orders and <root>/<RQ-id>.prompt for job bodies. Timestamps avoid the
// ET/DST boundary (DST ended 2026-11-01) and the 23:xx ambiguity noted in
// order-trace.test.ts.
const OLDER_MTIME = new Date('2026-11-12T10:00:00Z');
const NEWER_MTIME = new Date('2026-11-12T11:00:00Z');

async function makeRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'order-trace-bound-361s-'));
}

async function writeInbox(root: string, orders: Array<{ at: string; text: string }>): Promise<void> {
  await mkdir(join(root, 'leader'), { recursive: true });
  await writeFile(join(root, 'leader', 'MASON-INBOX.md'),
    orders.map(o => `## ${o.at} ET (Mason, Fake console) PRIORITY P0\n${o.text}\n`).join(''));
}

async function writePrompt(root: string, id: string, citation: string, mtime: Date): Promise<void> {
  const path = join(root, `${id}.prompt`);
  await writeFile(path, `Goal: Serve Mason's ${citation} order.\n`);
  await utimes(path, mtime, mtime);
}

/** Exact order key -> sorted job ids. Every order in the trace is included, so missing or extra keys fail. */
function membership(trace: OrderTraceV1): Record<string, string[]> {
  return Object.fromEntries(trace.orders.map(o => [o.key, o.jobs.map(j => j.id).sort()]));
}

it('bounded prompt scan stays partial, then a complete scan recovers the omitted association', async () => {
  const root = await makeRoot();
  try {
    await writeInbox(root, [
      { at: '2026-11-10 09:15', text: 'First fake order.' },
      { at: '2026-11-11 14:30', text: 'Second fake order.' },
    ]);
    await writePrompt(root, 'RQ-FAKE-OLDER', 'Nov 10 09:15', OLDER_MTIME);
    await writePrompt(root, 'RQ-FAKE-NEWER', 'Nov 11 14:30', NEWER_MTIME);

    // 1. Newest-first scan of one body: only RQ-FAKE-NEWER is read, so only its order is associated.
    let trace = await readOrderTrace({ runsDir: root, now: () => 0, maxBodies: 1 });
    expect(trace.sources).toEqual({ inbox: 'healthy', prompts: 'degraded', publishes: 'missing' });
    expect(membership(trace)).toEqual({ '11-10 09:15': [], '11-11 14:30': ['RQ-FAKE-NEWER'] });
    expect(trace.orders.find(o => o.key === '11-11 14:30')?.jobs).toEqual([
      { id: 'RQ-FAKE-NEWER', lane: null, state: 'queued', url: null },
    ]);

    // 2. Raising the bound covers both prompts: healthy coverage and both associations, including the omitted one.
    trace = await readOrderTrace({ runsDir: root, now: () => 0, maxBodies: 2 });
    expect(trace.sources).toEqual({ inbox: 'healthy', prompts: 'healthy', publishes: 'missing' });
    expect(membership(trace)).toEqual({ '11-10 09:15': ['RQ-FAKE-OLDER'], '11-11 14:30': ['RQ-FAKE-NEWER'] });

    // 3. Zero bound: nothing is scanned, so no association may survive from the earlier cached reads.
    trace = await readOrderTrace({ runsDir: root, now: () => 0, maxBodies: 0 });
    expect(trace.sources).toEqual({ inbox: 'healthy', prompts: 'degraded', publishes: 'missing' });
    expect(membership(trace)).toEqual({ '11-10 09:15': [], '11-11 14:30': [] });

    // 4. A later complete scan (default bound) recovers both associations with healthy coverage.
    trace = await readOrderTrace({ runsDir: root, now: () => 0 });
    expect(trace.sources).toEqual({ inbox: 'healthy', prompts: 'healthy', publishes: 'missing' });
    expect(membership(trace)).toEqual({ '11-10 09:15': ['RQ-FAKE-OLDER'], '11-11 14:30': ['RQ-FAKE-NEWER'] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('identical job basenames with different citations never leak evidence between runs roots', async () => {
  const rootA = await makeRoot();
  const rootB = await makeRoot();
  try {
    await writeInbox(rootA, [
      { at: '2026-11-10 09:15', text: 'First fake order.' },
      { at: '2026-11-11 14:30', text: 'Second fake order.' },
    ]);
    await writePrompt(rootA, 'RQ-FAKE-OLDER', 'Nov 10 09:15', OLDER_MTIME);
    await writePrompt(rootA, 'RQ-FAKE-NEWER', 'Nov 11 14:30', NEWER_MTIME);

    // Root B reuses the basename RQ-FAKE-NEWER with the same mtime but cites a different order.
    await writeInbox(rootB, [{ at: '2026-11-12 08:05', text: 'Other fake order.' }]);
    await writePrompt(rootB, 'RQ-FAKE-NEWER', 'Nov 12 08:05', NEWER_MTIME);

    // Interleave bounded and complete reads across both roots.
    let traceA = await readOrderTrace({ runsDir: rootA, now: () => 0, maxBodies: 1 });
    expect(traceA.sources.prompts).toBe('degraded');
    expect(membership(traceA)).toEqual({ '11-10 09:15': [], '11-11 14:30': ['RQ-FAKE-NEWER'] });

    let traceB = await readOrderTrace({ runsDir: rootB, now: () => 0 });
    expect(traceB.sources).toEqual({ inbox: 'healthy', prompts: 'healthy', publishes: 'missing' });
    expect(membership(traceB)).toEqual({ '11-12 08:05': ['RQ-FAKE-NEWER'] });

    traceA = await readOrderTrace({ runsDir: rootA, now: () => 0 });
    expect(traceA.sources).toEqual({ inbox: 'healthy', prompts: 'healthy', publishes: 'missing' });
    expect(membership(traceA)).toEqual({ '11-10 09:15': ['RQ-FAKE-OLDER'], '11-11 14:30': ['RQ-FAKE-NEWER'] });
    expect(traceA.orders.some(o => o.key === '11-12 08:05')).toBe(false);

    traceB = await readOrderTrace({ runsDir: rootB, now: () => 0, maxBodies: 0 });
    expect(traceB.sources.prompts).toBe('degraded');
    expect(membership(traceB)).toEqual({ '11-12 08:05': [] });

    traceA = await readOrderTrace({ runsDir: rootA, now: () => 0, maxBodies: 0 });
    expect(traceA.sources.prompts).toBe('degraded');
    expect(membership(traceA)).toEqual({ '11-10 09:15': [], '11-11 14:30': [] });

    traceB = await readOrderTrace({ runsDir: rootB, now: () => 0 });
    expect(traceB.sources.prompts).toBe('healthy');
    expect(membership(traceB)).toEqual({ '11-12 08:05': ['RQ-FAKE-NEWER'] });
    expect(traceB.orders.some(o => o.key === '11-11 14:30')).toBe(false);
  } finally {
    await rm(rootA, { recursive: true, force: true });
    await rm(rootB, { recursive: true, force: true });
  }
});
