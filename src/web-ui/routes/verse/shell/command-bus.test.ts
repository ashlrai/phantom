import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerCommandHandler, resetCommandBus, runCommand, runCommandWhenReady } from './command-bus.js';

afterEach(() => {
  resetCommandBus();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('command delivery', () => {
  it('lets the focused handler decline to the previous handler, then unregisters cleanly', () => {
    const previous = vi.fn();
    const focused = vi.fn(() => false);
    const removePrevious = registerCommandHandler('dock.terminal', previous);
    const removeFocused = registerCommandHandler('dock.terminal', focused);
    const invocation = { via: 'palette' } as const;

    expect(runCommand('dock.terminal', invocation)).toBe(true);
    expect(focused).toHaveBeenCalledWith(invocation);
    expect(previous).toHaveBeenCalledWith(invocation);
    expect(focused.mock.invocationCallOrder[0]).toBeLessThan(previous.mock.invocationCallOrder[0]!);

    removeFocused();
    removeFocused();
    expect(runCommand('dock.terminal')).toBe(true);
    expect(focused).toHaveBeenCalledTimes(1);
    removePrevious();
    expect(runCommand('dock.terminal')).toBe(false);
  });

  it('delivers a parked palette command once after its surface mounts', async () => {
    const invocation = { via: 'palette', argument: { kind: 'project', id: 'phantom', label: 'Phantom' } } as const;
    expect(runCommandWhenReady('dock.terminal', invocation)).toBe(false);
    const unrelated = vi.fn();
    registerCommandHandler('chat.sidebar', unrelated);
    const handler = vi.fn();
    const unregister = registerCommandHandler('dock.terminal', handler);
    expect(handler).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(handler).toHaveBeenCalledExactlyOnceWith(invocation);
    expect(unrelated).not.toHaveBeenCalled();
    unregister();
    registerCommandHandler('dock.terminal', handler);
    await Promise.resolve();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('expires a parked command before a late surface mounts', async () => {
    vi.useFakeTimers();
    runCommandWhenReady('dock.terminal', { via: 'menu' }, 100);
    vi.advanceTimersByTime(101);
    const handler = vi.fn();
    registerCommandHandler('dock.terminal', handler);
    await Promise.resolve();
    expect(handler).not.toHaveBeenCalled();
    expect(runCommand('dock.terminal')).toBe(true);
  });

  it('contains handler failures without invoking a second action', () => {
    const error = new Error('surface unavailable');
    const report = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fallback = vi.fn();
    registerCommandHandler('dock.terminal', fallback);
    registerCommandHandler('dock.terminal', () => { throw error; });
    expect(runCommand('dock.terminal')).toBe(true);
    expect(fallback).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledWith('[verse] command dock.terminal failed', error);
  });
});
