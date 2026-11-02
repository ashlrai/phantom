import { vi } from 'vitest';
import type { PaneHost, PaneProps } from './pane-registry.js';

export function paneProps(overrides: Partial<Omit<PaneProps, 'host'>> & { host?: Partial<PaneHost> } = {}): PaneProps {
  const { host, ...props } = overrides;
  return {
    paneId: 'test-pane', sessionId: null, session: null, roots: [], events: [], turnFiles: [],
    visible: true, presentation: 'column', requests: { terminal: null, preview: null, diff: null },
    ...props,
    host: {
      sendToChat: vi.fn(), addToMessage: vi.fn(), openPane: vi.fn(), closePane: vi.fn(),
      openTerminal: vi.fn(), openTerminalBelow: vi.fn(), openDiff: vi.fn(), openSession: vi.fn(), ...host,
    },
  };
}
