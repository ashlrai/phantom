import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadQuietHours, QUIET_HOURS_KEY, saveQuietHours } from './quiet-hours.js';

describe('quiet hours storage round trip', () => {
  beforeEach(() => localStorage.clear());
  it('persists a window and clears it on null', () => {
    saveQuietHours({ start: '21:30', end: '08:15' });
    expect(loadQuietHours()).toEqual({ start: '21:30', end: '08:15' });
    saveQuietHours(null);
    expect(loadQuietHours()).toBeNull();
    expect(localStorage.getItem(QUIET_HOURS_KEY)).toBeNull();
  });
  it('announces changes so held notifications can flush', () => {
    const seen: string[] = [];
    const onChange = () => seen.push('changed');
    window.addEventListener('quiet-hours-change', onChange);
    try {
      saveQuietHours({ start: '22:00', end: '07:00' });
      saveQuietHours(null);
    } finally {
      window.removeEventListener('quiet-hours-change', onChange);
    }
    expect(seen).toHaveLength(2);
  });
  it('survives a throwing localStorage without raising', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    try {
      expect(() => saveQuietHours({ start: '22:00', end: '07:00' })).not.toThrow();
    } finally {
      spy.mockRestore();
    }
  });
});
