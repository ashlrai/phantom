import { afterEach, describe, expect, it } from 'vitest';
import {
  AGENT_WORKSPACE_STORAGE_KEY,
  isAgentWorkspaceEnabled,
} from '../src/web-ui/data/agent-workspace-flag.js';

const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

function stubLocalStorage(store: Record<string, string> | null): void {
  if (store === null) {
    delete (globalThis as { localStorage?: unknown }).localStorage;
    return;
  }
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => (key in store ? store[key] : null),
      setItem: (key: string, value: string) => { store[key] = value; },
      removeItem: (key: string) => { delete store[key]; },
    },
  });
}

afterEach(() => {
  if (original) Object.defineProperty(globalThis, 'localStorage', original);
  else stubLocalStorage(null);
});

describe('agentWorkspace local flag (RQ-QUEUE-5, recut of #950)', () => {
  it('is off when localStorage is absent (server-side / node)', () => {
    stubLocalStorage(null);
    expect(isAgentWorkspaceEnabled()).toBe(false);
  });

  it('is off by default and on only for the exact value "1"', () => {
    stubLocalStorage({});
    expect(isAgentWorkspaceEnabled()).toBe(false);
    stubLocalStorage({ [AGENT_WORKSPACE_STORAGE_KEY]: 'yes' });
    expect(isAgentWorkspaceEnabled()).toBe(false);
    stubLocalStorage({ [AGENT_WORKSPACE_STORAGE_KEY]: '1' });
    expect(isAgentWorkspaceEnabled()).toBe(true);
  });

  it('is off when the localStorage read throws', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() { throw new Error('denied'); },
    });
    expect(isAgentWorkspaceEnabled()).toBe(false);
  });
});
