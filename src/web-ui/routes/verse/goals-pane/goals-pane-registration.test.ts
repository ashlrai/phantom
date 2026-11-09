import { describe, expect, it } from 'vitest';
import './goals.pane.js';
import { getPane, listPanes } from '../panes/pane-registry.js';

describe('goals pane registration', () => {
  it('registers the goals id', () => {
    expect(getPane('goals')?.title).toBe('Goals');
  });
  it('appears in listPanes()', () => {
    expect(listPanes().map(p => p.id)).toContain('goals');
  });
});
