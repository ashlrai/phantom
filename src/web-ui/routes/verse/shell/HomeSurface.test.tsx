import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { registerPane } from '../panes/pane-registry.js';
import { HomeSurface } from './HomeSurface.js';

afterEach(cleanup);

function mount(visible: boolean) {
  const dispose = registerPane({ id: 'goals', title: 'Goals', icon: () => null, component: () => <div>Goals content</div> });
  const view = render(<HomeSurface paneId="goals" visible={visible} compact={false} />);
  return { dispose, home: view.container.querySelector<HTMLElement>('[data-home-pane="goals"]')! };
}

it('shows the landing pane while it is the current view', () => {
  const { dispose, home } = mount(true);
  expect(home.hidden).toBe(false);
  expect(home.hasAttribute('inert')).toBe(false);
  expect(screen.getByText('Goals content')).toBeTruthy();
  dispose();
});

it('gives the window back when a section is showing, and keeps the pane mounted', () => {
  // The landing pane used to stay in the column under Command, Fleet and Chat
  // and take half the window from each of them.
  const { dispose, home } = mount(false);
  expect(home.hidden).toBe(true);
  expect(home.hasAttribute('inert')).toBe(true);
  // Still mounted: a draft or a scroll position must survive a trip to Fleet.
  expect(home.textContent).toBe('Goals content');
  dispose();
});

it('really removes the hidden pane from layout', () => {
  // `.home` sets `display: flex`, which outranks the browser's own `[hidden]`
  // rule. Without this line the attribute alone changes nothing on screen.
  const css = readFileSync(join(process.cwd(), 'src/web-ui/routes/verse/shell/HomeSurface.module.css'), 'utf8');
  expect(css).toMatch(/\.home\[hidden\]\s*\{\s*display:\s*none;\s*\}/);
});
