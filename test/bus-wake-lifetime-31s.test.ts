import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { getEventListeners } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBusWakeHook, sendWithBusWake, type BusWakeRequest } from '../src/core/fleet/bus-wake.js';

const ids = { id: 'message-31', from: 'sender', to: 'recipient' };
let root: string, file: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'bus-wake-lifetime-')); file = join(root, 'hops.jsonl'); });
afterEach(() => { vi.useRealTimers(); rmSync(root, { recursive: true, force: true }); });

describe('bus wake caller lifetime', () => {
  it('does not start a send for an already aborted caller', async () => {
    const controller = new AbortController();
    controller.abort('private cancellation detail');
    const send = vi.fn(), enqueue = vi.fn();
    const result = await sendWithBusWake(ids, { send, enqueue, signal: controller.signal, hoplogFile: file });
    expect(result).toEqual({ sent: false, reason: 'aborted' });
    expect(send).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(existsSync(file)).toBe(false);
  });

  it('validates routing metadata before sending even when cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const send = vi.fn();
    expect(await sendWithBusWake({ ...ids, id: '' }, { send, enqueue: vi.fn(), signal: controller.signal, hoplogFile: file }))
      .toEqual({ sent: false, reason: 'invalid-metadata' });
    expect(send).not.toHaveBeenCalled();
  });

  it('waits for in-flight transport acceptance and records its hop after cancellation', async () => {
    const controller = new AbortController();
    let accept!: (counts: { inputTokens: number }) => void;
    const send = vi.fn(() => new Promise<{ inputTokens: number }>(resolve => { accept = resolve; }));
    const enqueue = vi.fn();
    const message = { ...ids, body: 'private content' };
    const pending = sendWithBusWake(message, { send, enqueue, signal: controller.signal, hoplogFile: file });
    message.id = 'mutated';
    controller.abort('private cancellation detail');
    accept({ inputTokens: 4 });
    const result = await pending;
    expect(result).toEqual({ sent: true, hoplog: 'recorded', wake: 'aborted' });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ ...ids, inputTokens: 4, outputTokens: null });
    expect(enqueue).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it('still reports a transport failure after cancellation during send', async () => {
    const controller = new AbortController();
    let reject!: (reason: unknown) => void;
    const pending = sendWithBusWake(ids, {
      send: () => new Promise<void>((_resolve, fail) => { reject = fail; }),
      enqueue: vi.fn(), signal: controller.signal, hoplogFile: file,
    });
    controller.abort();
    reject(new Error('private transport error'));
    expect(await pending).toEqual({ sent: false, reason: 'send-failed' });
    expect(existsSync(file)).toBe(false);
  });

  it('cancels an in-flight enqueue and observes a late rejection', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let wakeSignal!: AbortSignal, reject!: (reason: unknown) => void;
    const enqueue = vi.fn((_request: BusWakeRequest, signal: AbortSignal) => {
      wakeSignal = signal;
      return new Promise<void>((_resolve, fail) => { reject = fail; });
    });
    const pending = sendWithBusWake(ids, { send: () => {}, enqueue, signal: controller.signal, hoplogFile: file });
    await vi.advanceTimersByTimeAsync(0);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1);
    controller.abort('private cancellation detail');
    expect(await pending).toEqual({ sent: true, hoplog: 'recorded', wake: 'aborted' });
    expect(wakeSignal.aborted).toBe(true);
    expect(wakeSignal.reason).not.toBe('private cancellation detail');
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    reject(new Error('private late failure'));
    await vi.advanceTimersByTimeAsync(0);
  });

  it('does not invoke an enqueue cancelled before its scheduled callback', async () => {
    const controller = new AbortController();
    const enqueue = vi.fn();
    const pending = createBusWakeHook({ enqueue, signal: controller.signal, hoplogFile: file })(ids);
    controller.abort();
    expect(await pending).toEqual({ hoplog: 'recorded', wake: 'aborted' });
    expect(enqueue).not.toHaveBeenCalled();
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it('keeps hoplog and wake outcomes independent after cancellation', async () => {
    const controller = new AbortController();
    controller.abort();
    mkdirSync(file);
    expect(await createBusWakeHook({ enqueue: vi.fn(), signal: controller.signal, hoplogFile: file })(ids))
      .toEqual({ hoplog: 'failed', wake: 'aborted' });
    expect(await createBusWakeHook({ enqueue: vi.fn(), signal: controller.signal, hoplogFile: file })(ids, { inputTokens: -1 }))
      .toEqual({ hoplog: 'invalid-metadata', wake: 'aborted' });
  });

  it.each(['queued', 'failed'] as const)('removes the listener and timer after enqueue %s', async outcome => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const enqueue = () => { if (outcome === 'failed') throw new Error('private wake error'); };
    const result = await createBusWakeHook({ enqueue, signal: controller.signal, hoplogFile: file })(ids);
    expect(result).toEqual({ hoplog: 'recorded', wake: outcome });
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('times out, aborts the enqueue signal, and removes the caller listener', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let wakeSignal!: AbortSignal;
    const pending = createBusWakeHook({
      enqueue: (_request, signal) => { wakeSignal = signal; return new Promise<void>(() => {}); },
      signal: controller.signal, wakeTimeoutMs: 20, hoplogFile: file,
    })(ids);
    await vi.advanceTimersByTimeAsync(20);
    expect(await pending).toEqual({ hoplog: 'recorded', wake: 'timed-out' });
    expect(wakeSignal.aborted).toBe(true);
    expect(controller.signal.aborted).toBe(false);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
