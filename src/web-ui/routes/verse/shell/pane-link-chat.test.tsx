import { beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { loadMarkdownRenderer, MessageMarkdown } from '../MessageMarkdown.js';
import { openDockPane } from '../dock/dock-store.js';
import { paneLinkUrl, parsePaneLink } from './deep-link.js';

vi.mock('../dock/dock-store.js', () => ({ openDockPane: vi.fn() }));

beforeAll(() => loadMarkdownRenderer());

describe('pane links in chat', () => {
  it('parses only complete pane links and normalizes legacy ids', () => {
    expect(parsePaneLink('verse://pane/fleet-lanes')).toBe('fleet-lanes');
    expect(parsePaneLink('verse://pane/fleet-lanes/')).toBe('fleet-lanes');
    expect(parsePaneLink('verse://pane/preview')).toBe('browser');
    for (const href of [
      'verse://pane/', 'verse://pane/../x', 'verse://pane/a/b',
      'VERSE://pane/fleet-lanes', 'verse://pane/fleet-lanes?x=1',
      'verse://pane/fleet-lanes#x', 'verse://pane/fleet-lanes\n', 'verse://settings',
    ]) expect(parsePaneLink(href), href).toBeNull();
    expect(paneLinkUrl('preview')).toBe('verse://pane/browser');
    expect(() => paneLinkUrl('../x')).toThrow(RangeError);
  });

  it('opens a pane without navigating and strips other verse links', () => {
    render(<MessageMarkdown text="see [lanes](verse://pane/fleet-lanes) [bad](verse://settings)" />);
    const link = screen.getByRole('link', { name: 'lanes' });
    expect(link.getAttribute('href')).toBe('verse://pane/fleet-lanes');
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(openDockPane).toHaveBeenCalledWith('fleet-lanes');
    expect(screen.getByText('bad').hasAttribute('href')).toBe(false);
  });
});
