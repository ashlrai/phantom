import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { BrowserCard } from './BrowserCard.js';

const PATH = '/api/verse/apps/browser';
const IMAGE = 'data:image/png;base64,cGljdHVyZQ==';
const report = (extra: Record<string, unknown> = {}) => ({
  schema: 'phm.browser/1', version: 1, browser: 'safari', action: 'tabs', ok: true, outcome: 'done', detail: '2 agent tabs open in Safari.', running: true,
  tabs: [{ id: '41:1', window: 41, index: 1, url: 'https://example.com/', title: 'Example Domain' }, { id: '41:2', window: 41, index: 2, url: 'https://example.org/docs', title: '' }],
  shot: { path: '/tmp/latest.png', at: '2026-11-17T12:00:00.000Z', bytes: 7 }, ...extra,
});

beforeEach(() => { evictAll(); setMutationToken('fixture'); });
afterEach(() => { clearMutationToken(); vi.unstubAllGlobals(); });
function serve(body: unknown = report(), post: unknown = { ok: true, detail: 'saved a screenshot of Safari.' }) {
  const fetcher = vi.fn(async (url: unknown, init?: RequestInit) => init?.method === 'POST' ? Response.json(post)
    : url === `${PATH}/shot` ? Response.json({ version: 1, dataUrl: IMAGE }) : Response.json(body));
  vi.stubGlobal('fetch', fetcher); return fetcher;
}
const setWidth = (width: number) => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  window.dispatchEvent(new Event('resize'));
};

describe.each([['desktop', 1280], ['phone', 390]])('Browser card at %s width (%i px)', (_name, width) => {
  beforeEach(() => setWidth(width));
  afterEach(() => setWidth(1024));

  it('shows the open agent tabs, the latest screenshot and one button', async () => {
    serve(); render(<BrowserCard visible />);
    const card = await screen.findByRole('region', { name: 'Browser' });
    expect(await within(card).findByText('2 agent tabs open in Safari.')).toBeInTheDocument();
    const rows = within(card).getAllByRole('listitem');
    expect(rows.map(r => [...r.children].map(c => c.textContent))).toEqual([['Example Domain', 'https://example.com/'], ['Untitled', 'https://example.org/docs']]);
    expect(await within(card).findByRole('img', { name: 'Latest Safari screenshot' })).toHaveAttribute('src', IMAGE);
    expect(within(card).getByText(/^Screenshot from /)).toBeInTheDocument();
    expect(within(card).getAllByRole('button').map(b => b.textContent)).toEqual(['Take screenshot']);
  });
});

it('takes a screenshot through the shared API with the mutation token, then reads again', async () => {
  const fetcher = serve(); render(<BrowserCard visible />);
  fireEvent.click(await screen.findByRole('button', { name: 'Take screenshot' }));
  expect(await screen.findByText('Screenshot taken.')).toBeInTheDocument();
  expect(fetcher).toHaveBeenCalledWith(PATH, expect.objectContaining({ method: 'POST', body: JSON.stringify({ action: 'shot' }), headers: expect.objectContaining({ 'x-ashlr-token': 'fixture' }) }));
  await waitFor(() => expect(fetcher.mock.calls.filter(([url, init]) => url === PATH && init?.method !== 'POST')).toHaveLength(2));
});

it('says why a screenshot was not taken, and posts nothing while controls are locked', async () => {
  const fetcher = serve(report(), { ok: false, detail: 'Safari has no window. Open a page first: phm browser open <url>' });
  const { unmount } = render(<BrowserCard visible />);
  fireEvent.click(await screen.findByRole('button', { name: 'Take screenshot' }));
  expect(await screen.findByText('Safari has no window. Open a page first: phm browser open <url>')).toBeInTheDocument();
  unmount(); evictAll(); clearMutationToken(); fetcher.mockClear();
  render(<BrowserCard visible />);
  fireEvent.click(await screen.findByRole('button', { name: 'Take screenshot' }));
  expect(screen.getByText('Unlock controls to take a screenshot.')).toBeInTheDocument();
  expect(fetcher.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
});

it('shows empty and unknown states in plain words', async () => {
  serve(report({ detail: 'Safari is not running. No agent tabs.', running: false, tabs: [], shot: null }));
  const { unmount } = render(<BrowserCard visible />);
  expect(await screen.findByText('Safari is not running. No agent tabs.')).toBeInTheDocument();
  expect(screen.getByText('No screenshot yet.')).toBeInTheDocument();
  expect(screen.queryAllByRole('listitem')).toHaveLength(0);
  expect(screen.getByRole('button', { name: 'Take screenshot' })).toBeDisabled();
  unmount(); evictAll();
  serve(report({ ok: false, outcome: 'needs_permission', detail: 'Phantom needs permission to control Safari.', running: null, tabs: [], shot: null }));
  render(<BrowserCard visible />);
  expect(await screen.findByText('Unknown: Phantom needs permission to control Safari.')).toHaveAttribute('data-unknown', 'true');
});

it('rejects malformed responses and does not fetch while hidden', async () => {
  serve({ schema: 'phm.browser/1', tabs: {} }); const { unmount } = render(<BrowserCard visible />);
  expect(await screen.findByText('Browser state is unavailable.')).toBeInTheDocument();
  unmount(); evictAll();
  const fetcher = serve(); render(<BrowserCard visible={false} />);
  expect(fetcher).not.toHaveBeenCalled();
});

it('fits a 390 px column: titles and addresses wrap and the screenshot scales down', () => {
  // jsdom has no layout engine: assert the rules the 390 px layout depends on.
  const css = readFileSync(resolve(process.cwd(), 'src/web-ui/routes/verse/fleet-host/fleet-host.module.css'), 'utf8');
  expect(css).toMatch(/\.tabTitle \{[^}]*min-width: 0[^}]*overflow-wrap: anywhere/);
  expect(css).toMatch(/\.shot img \{[^}]*max-width: 100%[^}]*height: auto/);
  expect(css.match(/^\.(tabTitle|shot)[^{]*\{[^}]*\}/gm)!.join('\n')).not.toMatch(/(?:^|[^-])width:\s*\d+px|min-width:\s*\d{3,}px/);
});
