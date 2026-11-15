import { describe, expect, it } from 'vitest';
import { emit, onFleetEvent } from '../src/core/fleet/event-bus.js';

describe('fleet event failure continuation', () => {
  it('continues in order after synchronous and asynchronous failures', async () => {
    const payload = { detail: 'synthetic anomaly' };
    const deliveries: Array<[string, unknown]> = [];
    const off = [
      onFleetEvent('anomaly', (event) => {
        deliveries.push(['sync', event]);
        throw new Error('synthetic synchronous failure');
      }),
      onFleetEvent('anomaly', async (event) => {
        deliveries.push(['async', event]);
        await Promise.resolve();
        throw new Error('synthetic asynchronous failure');
      }),
      onFleetEvent('anomaly', (event) => { deliveries.push(['success', event]); }),
    ];
    try {
      await expect(emit('anomaly', payload, {} as never)).resolves.toBeUndefined();
      expect(deliveries).toEqual([['sync', payload], ['async', payload], ['success', payload]]);
      for (const [, event] of deliveries) expect(event).toBe(payload);

      deliveries.length = 0;
      await expect(emit('anomaly', payload, { foundry: { eventBus: false } } as never)).resolves.toBeUndefined();
      expect(deliveries).toEqual([]);
    } finally {
      off.forEach((remove) => remove());
    }
  });

  it('keeps delivering once after a failed observer is removed twice', async () => {
    const deliveries: string[] = [];
    const removeFailed = onFleetEvent('anomaly', () => { throw new Error('synthetic failure'); });
    const removeSuccess = onFleetEvent('anomaly', (event) => { deliveries.push(event.detail ?? ''); });
    try {
      await expect(emit('anomaly', { detail: 'first' }, {} as never)).resolves.toBeUndefined();
      removeFailed();
      removeFailed();
      await expect(emit('anomaly', { detail: 'next' }, {} as never)).resolves.toBeUndefined();
      expect(deliveries).toEqual(['first', 'next']);
    } finally {
      removeFailed();
      removeSuccess();
    }
  });
});
