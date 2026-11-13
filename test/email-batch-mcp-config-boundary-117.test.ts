/**
 * RQ-PHX-EMAILBATCHMCPCONFIG117 — the batch MCP reader bounds config
 * discovery inside the same timeoutMs budget as polling: a stalled,
 * rejected or late-settling readConfig can no longer wedge the call, and
 * awaitBatch only ever runs with the undiscovered remainder. Hermetic: temp
 * roots, fake addresses, deferred promises — no live mailbox access.
 */
import { getEventListeners } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readFleetEmailOutboxBatchAwait, type FleetEmailOutboxBatchAwaitDeps,
} from '../src/mcp/fleet-email-outbox-batch-await.js';
import type { BatchOptions, BatchResult } from '../src/core/comms/email-outbox-batch-await.js';
import { writeEmailDropConfig } from '../src/core/comms/email-drop-config.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'email-batch-config-boundary-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); vi.useRealTimers(); vi.restoreAllMocks(); });

const NAMES = ['one.reply.eml', 'two.reply.eml', 'three.reply.eml', 'four.reply.eml'];
const INPUT = { names: NAMES, timeoutMs: 300, pollMs: 100 };

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void; let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const okConfig = (outbox: string) => ({
  state: 'ok' as const, path: join(root, 'cfg'),
  config: { v: 1 as const, inboxDir: join(root, 'inbox'), outboxDir: outbox, from: ['fake@example.test'] },
});
const batchOk = (rows: BatchResult['rows']): BatchResult => ({ rows, timedOut: false, cancelled: false, sourceFailure: false });

describe('readFleetEmailOutboxBatchAwait config boundary', () => {
  it('reports unobserved/cancelled before discovery when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const readConfig = vi.fn();
    const awaitBatch = vi.fn();
    const out = await readFleetEmailOutboxBatchAwait(INPUT, controller.signal, { runsDir: root, readConfig, awaitBatch });
    expect(out).toMatchObject({ sourceState: 'unobserved', rows: null, timedOut: false, cancelled: true, sourceFailure: false });
    expect(readConfig).not.toHaveBeenCalled();
    expect(awaitBatch).not.toHaveBeenCalled();
  });

  it('cancels a pending config read on abort, disposes listeners and ignores the late settle', async () => {
    const outbox = join(root, 'outbox'); mkdirSync(outbox);
    const gate = deferred<ReturnType<typeof okConfig>>();
    const readConfig = vi.fn(() => gate.promise);
    const awaitBatch = vi.fn(async (_opts: BatchOptions) => batchOk([]));
    const controller = new AbortController();
    const listenersBefore = getEventListeners(controller.signal, 'abort').length;
    const pending = readFleetEmailOutboxBatchAwait(INPUT, controller.signal, {
      runsDir: root, readConfig: readConfig as FleetEmailOutboxBatchAwaitDeps['readConfig'], awaitBatch,
    });
    await vi.waitFor(() => expect(readConfig).toHaveBeenCalledTimes(1));
    controller.abort();
    const out = await pending;
    expect(out).toMatchObject({ sourceState: 'unobserved', rows: null, timedOut: false, cancelled: true, sourceFailure: false });
    expect(getEventListeners(controller.signal, 'abort').length).toBe(listenersBefore);
    // Late resolve is observed by the still-attached handler, never unhandled,
    // and never reaches polling.
    gate.resolve(okConfig(outbox));
    await Promise.resolve(); await Promise.resolve();
    expect(awaitBatch).not.toHaveBeenCalled();
  });

  it('expires a pending config read at the shared deadline without polling or fabricating rows', async () => {
    vi.useFakeTimers();
    const readConfig = vi.fn(() => new Promise<never>(() => {}));
    const awaitBatch = vi.fn(async (_opts: BatchOptions) => batchOk([]));
    const pending = readFleetEmailOutboxBatchAwait({ names: NAMES, timeoutMs: 1000 }, undefined, {
      runsDir: root, readConfig: readConfig as FleetEmailOutboxBatchAwaitDeps['readConfig'], awaitBatch,
    });
    await vi.advanceTimersByTimeAsync(1000);
    const out = await pending;
    expect(out).toMatchObject({ sourceState: 'unobserved', rows: null, timedOut: true, cancelled: false, sourceFailure: false });
    expect(awaitBatch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('passes only the remaining budget to awaitBatch after a delayed config success', async () => {
    const outbox = join(root, 'outbox'); mkdirSync(outbox);
    const gate = deferred<ReturnType<typeof okConfig>>();
    const readConfig = vi.fn(() => gate.promise);
    let now = 0;
    const seen: BatchOptions[] = [];
    const awaitBatch = vi.fn(async (opts: BatchOptions) => { seen.push(opts); return batchOk([{ name: NAMES[0]!, state: 'sent' }]); });
    const pending = readFleetEmailOutboxBatchAwait({ names: NAMES, timeoutMs: 300 }, undefined, {
      runsDir: root,
      readConfig: readConfig as FleetEmailOutboxBatchAwaitDeps['readConfig'],
      awaitBatch,
      now: () => now,
    });
    await vi.waitFor(() => expect(readConfig).toHaveBeenCalledTimes(1));
    now = 200;
    gate.resolve(okConfig(outbox));
    const out = await pending;
    expect(out).toMatchObject({ sourceState: 'ok', timedOut: false, cancelled: false, sourceFailure: false });
    expect(out.rows).toEqual([{ name: NAMES[0], state: 'sent' }]);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.timeoutMs).toBe(100);
    expect(seen[0]!.names).toEqual(NAMES);
  });

  it('reports invalid-config sourceFailure when the config read rejects', async () => {
    const readConfig = vi.fn(async () => { throw new Error('synthetic read failure'); });
    const awaitBatch = vi.fn(async (_opts: BatchOptions) => batchOk([]));
    const out = await readFleetEmailOutboxBatchAwait(INPUT, undefined, {
      runsDir: root, readConfig: readConfig as FleetEmailOutboxBatchAwaitDeps['readConfig'], awaitBatch,
    });
    expect(out).toMatchObject({ sourceState: 'invalid-config', rows: null, timedOut: false, cancelled: false, sourceFailure: true });
    expect(awaitBatch).not.toHaveBeenCalled();
  });

  it('handles a late config rejection after expiry without unhandled rejection or polling', async () => {
    const gate = deferred<never>();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const awaitBatch = vi.fn(async (_opts: BatchOptions) => batchOk([]));
      const out = await readFleetEmailOutboxBatchAwait({ names: NAMES, timeoutMs: 20 }, undefined, {
        runsDir: root,
        readConfig: (() => gate.promise) as FleetEmailOutboxBatchAwaitDeps['readConfig'],
        awaitBatch,
      });
      expect(out).toMatchObject({ sourceState: 'unobserved', rows: null, timedOut: true, cancelled: false, sourceFailure: false });
      gate.reject(new Error('late synthetic failure'));
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(unhandled).toEqual([]);
      expect(awaitBatch).not.toHaveBeenCalled();
    } finally {
      process.removeListener('unhandledRejection', onUnhandled);
    }
  });

  it('observes a real temporary outbox with mixed terminal states in input order', async () => {
    const outbox = join(root, 'outbox');
    mkdirSync(join(outbox, 'sending'), { recursive: true });
    mkdirSync(join(outbox, 'sent'));
    mkdirSync(join(outbox, 'drafted'));
    const message = 'To: fake@example.test\nSubject: synthetic\n\nsynthetic-body';
    writeFileSync(join(outbox, 'sent', NAMES[0]!), message);
    writeFileSync(join(outbox, 'drafted', NAMES[1]!), message);
    writeFileSync(join(outbox, 'sending', NAMES[2]!), message);
    writeFileSync(join(outbox, NAMES[3]!), message);
    writeFileSync(join(outbox, 'sent', NAMES[3]!), message);
    await writeEmailDropConfig(root, { v: 1, inboxDir: join(root, 'inbox'), outboxDir: outbox, from: ['fake@example.test'] });
    const out = await readFleetEmailOutboxBatchAwait({ names: NAMES, timeoutMs: 5000, pollMs: 100 }, undefined, { runsDir: root });
    expect(out).toMatchObject({ sourceState: 'ok', timedOut: false, cancelled: false, sourceFailure: false });
    expect(out.rows).toEqual([
      { name: NAMES[0], state: 'sent' },
      { name: NAMES[1], state: 'drafted' },
      { name: NAMES[2], state: 'stuck', reason: 'interrupted-send' },
      { name: NAMES[3], state: 'stuck', reason: 'malformed' },
    ]);
  });
});
