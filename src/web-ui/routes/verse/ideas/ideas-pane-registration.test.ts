import { describe, expect, it } from 'vitest';
import { getPane } from '../panes/pane-registry.js';
import './ideas.pane.js';

describe('ideas pane registration', () => {
  it('registers the ideas pane without needing a session', () => {
    const pane = getPane('ideas');
    expect(pane?.title).toBe('Ideas');
    expect(pane?.needsSession).toBe(false);
  });
});
