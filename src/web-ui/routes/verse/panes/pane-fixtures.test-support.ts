import { vi } from 'vitest';
import type { PaneProps } from './pane-registry.js';

export function paneProps(overrides: Partial<PaneProps> = {}): PaneProps {
  return {
    paneId: 'test-pane', sessionId: null, session: null, roots: [], events: [], turnFiles: [],
    visible: true, presentation: 'column', requests: { terminal: null, preview: null, diff: null },
    host: {
      sendToChat: vi.fn(), addToMessage: vi.fn(), openPane: vi.fn(), closePane: vi.fn(),
      openTerminal: vi.fn(), openTerminalBelow: vi.fn(), openDiff: vi.fn(), openSession: vi.fn(),
    },
    ...overrides,
  };
}
