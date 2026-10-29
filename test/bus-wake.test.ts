import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBusWakeHook, sendWithBusWake, type BusWakeOptions, type BusWakeRequest } from '../src/core/fleet/bus-wake.js';

let root: string, file: string;
const ids = { id: 'message-1', from: 'codex-cmp', to: 'agent:reviewer' };
const message = () => ({ ...ids, priority: 'P0' as const, ttl: 1000, body: 'PRIVATE-MESSAGE-BODY' });
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'bus-wake-')); file = join(root, 'hops.jsonl'); });
afterEach(() => { vi.useRealTimers(); rmSync(root, { recursive: true, force: true }); });

describe('bus send → RQ-EVENTD', () => {
  it('waits for send acceptance, records usage, then queues only routing IDs', async () => {
    let accept!: (counts: { inputTokens: number; outputTokens: number }) => void;
    const send = vi.fn(() => new Promise<{ inputTokens: number; outputTokens: number }>(resolve => { accept = resolve; }));
    const enqueue = vi.fn((request: BusWakeRequest) => {
      expect(existsSync(file)).toBe(true);
      expect(request).toEqual({ kind: 'bus.send', ...ids });
    });
    const pending = sendWithBusWake(message(), { send, enqueue, hoplogFile: file });
    expect(enqueue).not.toHaveBeenCalled();
    expect(existsSync(file)).toBe(false);
    accept({ inputTokens: 21, outputTokens: 7 });
    expect(await pending).toEqual({ sent: true, hoplog: 'recorded', wake: 'queued' });
    expect(enqueue).toHaveBeenCalledOnce();
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ ...ids, inputTokens: 21, outputTokens: 7 });
    expect(readFileSync(file, 'utf8').includes(message().body)).toBe(false);
  });

  it('does not wake or log failed sends, or expose transport error text', async () => {
    const enqueue = vi.fn();
    const result = await sendWithBusWake(message(), {
      send: () => { throw new Error(message().body); }, enqueue, hoplogFile: file,
    });
    expect(result).toEqual({ sent: false, reason: 'send-failed' });
    expect(JSON.stringify(result).includes(message().body)).toBe(false);
    expect(enqueue).not.toHaveBeenCalled();
    expect(existsSync(file)).toBe(false);
  });

  it('handles async transport rejection identically', async () => {
    const enqueue = vi.fn();
    expect(await sendWithBusWake(message(), {
      send: async () => { throw new Error('private transport failure'); }, enqueue, hoplogFile: file,
    })).toEqual({ sent: false, reason: 'send-failed' });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('snapshots IDs before a transport mutates its input and ignores body getters', async () => {
    const body = vi.fn(() => { throw new Error('private body getter'); });
    const envelope = { ...ids, get body() { return body(); } };
    const enqueue = vi.fn();
    expect(await sendWithBusWake(envelope, {
      send: input => { input.id = 'mutated'; input.to = 'changed'; }, enqueue, hoplogFile: file,
    })).toMatchObject({ sent: true, wake: 'queued' });
    expect(enqueue.mock.calls[0][0]).toEqual({ kind: 'bus.send', ...ids });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject(ids);
    expect(body).not.toHaveBeenCalled();
  });

  it('returns sent:true on synchronous and asynchronous wake failures, preserving the hop', async () => {
    for (const enqueue of [() => { throw new Error(message().body); }, async () => { throw new Error(message().body); }]) {
      expect(await sendWithBusWake(message(), { send: () => {}, enqueue, hoplogFile: file }))
        .toEqual({ sent: true, hoplog: 'recorded', wake: 'failed' });
    }
    expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(2);
  });

  it('still queues a wake when the log cannot be written', async () => {
    mkdirSync(file);
    const enqueue = vi.fn();
    expect(await sendWithBusWake(message(), { send: () => {}, enqueue, hoplogFile: file }))
      .toEqual({ sent: true, hoplog: 'failed', wake: 'queued' });
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it('refuses invalid metadata before invoking the transport', async () => {
    const send = vi.fn(), enqueue = vi.fn();
    expect(await sendWithBusWake({ ...message(), id: 'bad\nid' }, { send, enqueue, hoplogFile: file }))
      .toEqual({ sent: false, reason: 'invalid-metadata' });
    expect(send).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(existsSync(file)).toBe(false);
  });

  it('also refuses invalid IDs through the direct post-send hook', async () => {
    const enqueue = vi.fn();
    expect(await createBusWakeHook({ enqueue, hoplogFile: file })({ ...ids, to: '' }))
      .toEqual({ hoplog: 'invalid-metadata', wake: 'invalid-metadata' });
    expect(enqueue).not.toHaveBeenCalled();
    expect(existsSync(file)).toBe(false);
  });

  it('requires a daemon callback before transport mutation', async () => {
    const send = vi.fn();
    const options = { send, enqueue: null, hoplogFile: file } as unknown as BusWakeOptions & { send: typeof send };
    await expect(sendWithBusWake(message(), options)).rejects.toThrow('Bus wake requires an RQ-EVENTD enqueue callback.');
    expect(send).not.toHaveBeenCalled();
  });

  it('exposes an invalid-usage result without suppressing an accepted message wake', async () => {
    const enqueue = vi.fn();
    expect(await sendWithBusWake(message(), {
      send: () => ({ inputTokens: NaN }), enqueue, hoplogFile: file,
    })).toEqual({ sent: true, hoplog: 'invalid-metadata', wake: 'queued' });
    expect(enqueue).toHaveBeenCalledOnce();
    expect(existsSync(file)).toBe(false);
  });

  it('bounds a stuck daemon enqueue and aborts its request without resending', async () => {
    vi.useFakeTimers();
    let signal!: AbortSignal;
    const send = vi.fn();
    const enqueue = vi.fn((_request: BusWakeRequest, requestSignal: AbortSignal) => {
      signal = requestSignal;
      return new Promise<void>(() => {});
    });
    const pending = sendWithBusWake(message(), { send, enqueue, hoplogFile: file, wakeTimeoutMs: 50 });
    await vi.advanceTimersByTimeAsync(50);
    expect(await pending).toEqual({ sent: true, hoplog: 'recorded', wake: 'timed-out' });
    expect(signal.aborted).toBe(true);
    expect(send).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('handles late rejection after timeout without an unhandled rejection', async () => {
    vi.useFakeTimers();
    let reject!: (error: Error) => void;
    const hook = createBusWakeHook({ enqueue: () => new Promise<void>((_resolve, fail) => { reject = fail; }), hoplogFile: file, wakeTimeoutMs: 10 });
    const pending = hook(ids);
    await vi.advanceTimersByTimeAsync(10);
    expect((await pending).wake).toBe('timed-out');
    reject(new Error('private late error'));
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears the timeout after successful enqueue and gives the daemon immutable IDs', async () => {
    vi.useFakeTimers();
    const enqueue = vi.fn((request: BusWakeRequest) => { expect(Object.isFrozen(request)).toBe(true); });
    expect((await createBusWakeHook({ enqueue, hoplogFile: file })(ids)).wake).toBe('queued');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves a stable wake identity across repeated accepted hops for daemon deduplication', async () => {
    const enqueue = vi.fn();
    const hook = createBusWakeHook({ enqueue, hoplogFile: file });
    await hook(ids);
    await hook(ids);
    expect(enqueue.mock.calls.map(call => call[0])).toEqual([
      { kind: 'bus.send', ...ids }, { kind: 'bus.send', ...ids },
    ]);
    expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(2);
  });

  it.each([0, -1, 0.5, NaN, Infinity, 60_001])('rejects invalid timeout (%s) before sending', async wakeTimeoutMs => {
    const send = vi.fn();
    await expect(sendWithBusWake(message(), { send, enqueue: vi.fn(), hoplogFile: file, wakeTimeoutMs }))
      .rejects.toThrow('Bus wake timeout must be an integer');
    expect(send).not.toHaveBeenCalled();
  });
});
