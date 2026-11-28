import { afterEach, expect, it } from 'vitest';
import { getPane, paneApplies } from '../panes/pane-registry.js';
import './replay.pane.js';

afterEach(() => { localStorage.clear(); });

it('registers a lazy dock pane that stays hidden until agentWorkspace is explicitly enabled', () => {
  const pane = getPane('run-replay');
  expect(pane).not.toBeNull();
  if (!pane) return;
  const context = { sessionId: null, session: null, roots: [] };
  expect(pane.needsSession).toBe(false);
  expect(paneApplies(pane, context)).toBe(false);
  localStorage.setItem('agentWorkspace', 'true');
  expect(paneApplies(pane, context)).toBe(true);
  expect(pane.component).toHaveProperty('preload');
});
