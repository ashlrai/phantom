import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FEATURE_FLAGS_STORAGE_KEY,
  getFeatureFlag,
  resetFeatureFlagsForTests,
  setFeatureFlag,
  subscribeFeatureFlags,
  type FeatureFlag,
} from './feature-flags.js';

beforeEach(() => {
  localStorage.clear();
  resetFeatureFlagsForTests();
});
afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  resetFeatureFlagsForTests();
});

describe('UI feature flags', () => {
  it('defaults agentWorkspace to off without writing storage', () => {
    expect(getFeatureFlag('agentWorkspace')).toBe(false);
    expect(localStorage.getItem(FEATURE_FLAGS_STORAGE_KEY)).toBeNull();
  });

  it.each(['{', 'null', '[]', 'true', '{}', '{"agentWorkspace":"true"}', '{"agentWorkspace":1}', '{"agentWorkspace":false}'])(
    'fails closed for invalid or disabled stored data: %s', (raw) => {
      localStorage.setItem(FEATURE_FLAGS_STORAGE_KEY, raw);
      expect(getFeatureFlag('agentWorkspace')).toBe(false);
    },
  );

  it('persists both choices across reloads', () => {
    for (const enabled of [true, false]) {
      setFeatureFlag('agentWorkspace', enabled);
      expect(JSON.parse(localStorage.getItem(FEATURE_FLAGS_STORAGE_KEY)!)).toEqual({ agentWorkspace: enabled });
      resetFeatureFlagsForTests();
      expect(getFeatureFlag('agentWorkspace')).toBe(enabled);
    }
  });

  it('notifies subscribers only on a change and supports unsubscribe', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeFeatureFlags(listener);
    try {
      setFeatureFlag('agentWorkspace', false);
      expect(listener).not.toHaveBeenCalled();
      setFeatureFlag('agentWorkspace', true);
      setFeatureFlag('agentWorkspace', true);
      expect(listener).toHaveBeenCalledTimes(1);
      unsubscribe();
      setFeatureFlag('agentWorkspace', false);
      expect(listener).toHaveBeenCalledTimes(1);
    } finally {
      unsubscribe();
    }
  });

  it('rejects unknown keys and non-boolean values at runtime', () => {
    setFeatureFlag('token' as FeatureFlag, true);
    setFeatureFlag('agentWorkspace', 'true' as unknown as boolean);
    expect(getFeatureFlag('token' as FeatureFlag)).toBe(false);
    expect(getFeatureFlag('agentWorkspace')).toBe(false);
    expect(localStorage.getItem(FEATURE_FLAGS_STORAGE_KEY)).toBeNull();
  });

  it('defaults off when storage is blocked and keeps toggles usable for the page', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(getFeatureFlag('agentWorkspace')).toBe(false);
    setFeatureFlag('agentWorkspace', true);
    expect(getFeatureFlag('agentWorkspace')).toBe(true);
    setFeatureFlag('agentWorkspace', false);
    expect(getFeatureFlag('agentWorkspace')).toBe(false);
  });

  it('drops secret, token and capability fields without logging their values', () => {
    const logs = ['log', 'info', 'warn', 'error', 'debug'] as const;
    const spies = logs.map((method) => vi.spyOn(console, method));
    localStorage.setItem(FEATURE_FLAGS_STORAGE_KEY, JSON.stringify({
      agentWorkspace: true, secret: 'secret-sentinel', token: 'token-sentinel', capability: 'capability-sentinel',
    }));
    expect(getFeatureFlag('agentWorkspace')).toBe(true);
    setFeatureFlag('agentWorkspace', false);
    expect(localStorage.getItem(FEATURE_FLAGS_STORAGE_KEY)).toBe('{"agentWorkspace":false}');
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});
