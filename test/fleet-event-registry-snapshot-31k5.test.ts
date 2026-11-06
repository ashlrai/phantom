import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _clearHandlers, emit, onFleetEvent } from '../src/core/fleet/event-bus.js';

const cfg = { foundry: {} } as never;
const payload = { detail: 'local fixture' };

describe('lifecycle event registry snapshots', () => {
  beforeEach(() => _clearHandlers());
  afterEach(() => _clearHandlers());

  it('defers handlers added by a handler until the next emission', async () => {
    const calls: string[] = [];
    onFleetEvent('anomaly', () => {
      calls.push('first');
      onFleetEvent('anomaly', () => { calls.push('added'); });
    });
    onFleetEvent('anomaly', () => { calls.push('second'); });

    await emit('anomaly', payload, cfg);
    expect(calls).toEqual(['first', 'second']);
    calls.length = 0;
    await emit('anomaly', payload, cfg);
    expect(calls).toEqual(['first', 'second', 'added']);
  });

  it('keeps self-removal and removal of a later handler for subsequent emissions', async () => {
    const calls: string[] = [];
    let removeLater = () => {};
    const removeSelf = onFleetEvent('anomaly', () => {
      calls.push('first');
      removeSelf();
      removeLater();
    });
    removeLater = onFleetEvent('anomaly', () => { calls.push('later'); });
    onFleetEvent('anomaly', () => { calls.push('last'); });

    await emit('anomaly', payload, cfg);
    expect(calls).toEqual(['first', 'later', 'last']);
    calls.length = 0;
    await emit('anomaly', payload, cfg);
    expect(calls).toEqual(['last']);
  });

  it('defers registrations made while an earlier asynchronous handler is pending', async () => {
    const calls: string[] = [];
    let resume = () => {};
    const pending = new Promise<void>((resolve) => { resume = resolve; });
    onFleetEvent('anomaly', async () => {
      calls.push('first:start');
      await pending;
      calls.push('first:end');
    });
    onFleetEvent('anomaly', () => { calls.push('second'); });

    const emission = emit('anomaly', payload, cfg);
    expect(calls).toEqual(['first:start']);
    onFleetEvent('anomaly', () => { calls.push('added'); });
    resume();
    await emission;
    expect(calls).toEqual(['first:start', 'first:end', 'second']);
    calls.length = 0;
    await emit('anomaly', payload, cfg);
    expect(calls).toEqual(['first:start', 'first:end', 'second', 'added']);
  });

  it('isolates synchronous throws and asynchronous rejections while draining the snapshot', async () => {
    const calls: string[] = [];
    onFleetEvent('anomaly', () => { calls.push('throw'); throw new Error('fixture'); });
    onFleetEvent('anomaly', async () => { calls.push('reject'); throw new Error('fixture'); });
    onFleetEvent('anomaly', () => { calls.push('last'); });

    await expect(emit('anomaly', payload, cfg)).resolves.toBeUndefined();
    expect(calls).toEqual(['throw', 'reject', 'last']);
  });

  it('does not invoke handlers while disabled, and retains them for the next enabled emission', async () => {
    const calls: string[] = [];
    onFleetEvent('anomaly', () => { calls.push('called'); });

    await expect(emit('anomaly', payload, { foundry: { eventBus: false } } as never)).resolves.toBeUndefined();
    expect(calls).toEqual([]);
    await emit('anomaly', payload, cfg);
    expect(calls).toEqual(['called']);
  });

  it('allows repeated unsubscribe calls without affecting other handlers', async () => {
    const calls: string[] = [];
    const remove = onFleetEvent('anomaly', () => { calls.push('removed'); });
    onFleetEvent('anomaly', () => { calls.push('retained'); });
    remove();
    remove();

    await emit('anomaly', payload, cfg);
    expect(calls).toEqual(['retained']);
    remove();
    await emit('anomaly', payload, cfg);
    expect(calls).toEqual(['retained', 'retained']);
  });
});
