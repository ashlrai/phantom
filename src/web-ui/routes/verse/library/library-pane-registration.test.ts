import { describe, expect, it } from 'vitest';
import '../panes/index.js';
import { getPane } from '../panes/pane-registry.js';

describe('library pane registration', () => {
  it('registers the library pane without a session', () => {
    const pane = getPane('library');
    expect(pane?.title).toBe('Library');
    expect(pane?.needsSession).toBe(false);
  });
});
