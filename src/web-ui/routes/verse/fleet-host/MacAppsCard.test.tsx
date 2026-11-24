import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { MacAppsCard, macAppLastAction } from './MacAppsCard.js';

const row = (id: string, name: string, extra: Record<string, unknown>) => ({
  id, name, role: 'Assistant', installed: true, running: true, frontmost: false, pid: 4321, memoryMb: 150, path: `/Applications/${name}.app`,
  bundleId: null, lastFocus: 'unknown', lastFocusedAt: null, quit: id === 'safari' ? 'allowed' : 'protected', action: 'focus', reason: null, ...extra,
});
const fixture = { schema: 'phm.apps/2', version: 2, probe: 'ok', reason: null, apps: [
  row('phantom', 'Phantom', { frontmost: true, action: null }),
  row('claude', 'Claude', { memoryMb: 2048 }),
  row('codex', 'Codex', { installed: false, running: false, frontmost: false, memoryMb: null, action: null }),
  row('chatgpt', 'ChatGPT', { running: false, memoryMb: null, action: 'open' }),
  row('grok', 'Grok', { installed: null, running: null, frontmost: null, memoryMb: null, action: null, reason: 'ps failed' }),
] };

beforeEach(() => { evictAll(); setMutationToken('a'.repeat(64)); });
afterEach(() => { clearMutationToken(); vi.unstubAllGlobals(); });
function serve(body: unknown = fixture, status = 200) {
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => init?.method === 'POST'
    ? Response.json({ action: 'focus', app: 'claude', outcome: 'done', detail: 'raised Claude.' })
    : Response.json(body, { status }));
  vi.stubGlobal('fetch', fetcher); return fetcher;
}

it('renders one row per app with plain state and at most one obvious action', async () => {
  serve(); render(<MacAppsCard visible />);
  expect(await screen.findByText('Running · 2.0 GB')).toBeInTheDocument();
  expect(screen.getByText('In front · 150 MB')).toBeInTheDocument();
  expect(screen.getByText('Not installed')).toBeInTheDocument();
  expect(screen.getByText('Not running')).toBeInTheDocument();
  expect(screen.getByText('Unknown')).toBeInTheDocument();
  expect(screen.getAllByRole('listitem')).toHaveLength(5);
  // Phantom, a missing app and an unknown app get no button; nothing offers quit.
  expect(screen.getAllByRole('button').map(b => b.getAttribute('aria-label'))).toEqual(['Bring to front Claude', 'Open ChatGPT']);
  expect(screen.queryByRole('button', { name: /quit/i })).not.toBeInTheDocument();
});

it('shows a Last used column in plain words; unknown stays unknown', async () => {
  const at = new Date(Date.now() - 5 * 60_000 - 5_000).toISOString();
  serve({ ...fixture, apps: [
    row('claude', 'Claude', { lastFocus: 'known', lastFocusedAt: at }),
    row('codex', 'Codex', { lastFocus: 'never' }),
    row('cursor', 'Cursor', { lastFocus: 'unknown' }),
    row('chatgpt', 'ChatGPT', { running: false, memoryMb: null, action: 'open' }),
  ] });
  render(<MacAppsCard visible />);
  expect(await screen.findByLabelText('Claude last used')).toHaveTextContent('Last used: 5 min ago');
  expect(screen.getByLabelText('Codex last used')).toHaveTextContent('Last used: not yet');
  expect(screen.getByLabelText('Cursor last used')).toHaveTextContent('Last used: unknown');
  expect(screen.getByLabelText('ChatGPT last used')).toBeEmptyDOMElement();
});

it('acts through the shared control API with the app id and the mutation token', async () => {
  const fetcher = serve(); render(<MacAppsCard visible />);
  fireEvent.click(await screen.findByRole('button', { name: 'Bring to front Claude' }));
  expect(await screen.findByText('Claude: raised Claude.')).toBeInTheDocument();
  expect(fetcher).toHaveBeenCalledWith('/api/verse/apps/control', expect.objectContaining({ method: 'POST',
    body: JSON.stringify({ app: 'claude', action: 'focus' }), headers: expect.objectContaining({ 'x-ashlr-token': 'a'.repeat(64) }) }));
  await waitFor(() => expect(fetcher.mock.calls.filter(([, init]) => init?.method !== 'POST')).toHaveLength(2));
});

it('posts nothing while controls are locked', async () => {
  const fetcher = serve(); clearMutationToken(); render(<MacAppsCard visible />);
  fireEvent.click(await screen.findByRole('button', { name: 'Open ChatGPT' }));
  expect(screen.getByText('Unlock controls to open apps.')).toBeInTheDocument();
  expect(fetcher.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
});

it('shows the empty state and the none-installed state', async () => {
  serve({ ...fixture, apps: [] }); const { unmount } = render(<MacAppsCard visible />);
  expect(await screen.findByText('No apps to show.')).toBeInTheDocument();
  expect(screen.queryAllByRole('button')).toHaveLength(0);
  unmount(); evictAll();
  serve({ ...fixture, apps: fixture.apps.map(a => ({ ...a, installed: false, running: false, frontmost: false, memoryMb: null, action: null })) });
  render(<MacAppsCard visible />);
  expect(await screen.findByText('None of these apps are installed on this Mac.')).toBeInTheDocument();
  expect(screen.queryAllByRole('button')).toHaveLength(0);
});

it('says why state is unknown when the probe is missing', async () => {
  serve({ ...fixture, probe: 'missing', reason: 'app state can only be read on macOS; this host has no app probe.',
    apps: fixture.apps.map(a => ({ ...a, installed: null, running: null, frontmost: null, memoryMb: null, action: null })) });
  render(<MacAppsCard visible />);
  expect(await screen.findByText(/Some state is unknown: app state can only be read on macOS/)).toBeInTheDocument();
  expect(screen.getAllByText('Unknown')).toHaveLength(5);
});

it('rejects malformed responses and does not fetch while hidden', async () => {
  serve({ apps: {} }); const { unmount } = render(<MacAppsCard visible />);
  expect(await screen.findByText('App state is unavailable.')).toBeInTheDocument();
  unmount(); evictAll();
  const fetcher = serve(); render(<MacAppsCard visible={false} />);
  expect(fetcher).not.toHaveBeenCalled();
});

const setWidth = (width: number) => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  window.dispatchEvent(new Event('resize'));
};
const KNOWN = [['phantom', 'Phantom'], ['claude', 'Claude'], ['codex', 'Codex'], ['chatgpt', 'ChatGPT'], ['cursor', 'Cursor'], ['grok', 'Grok'], ['devin', 'Devin'], ['safari', 'Safari']] as const;

describe.each([['desktop', 1280], ['phone', 390]])('Apps card at %s width (%i px)', (_name, width) => {
  beforeEach(() => setWidth(width));
  afterEach(() => setWidth(1024));

  it('draws one row per app, each with a name, a plain state and at most one button', async () => {
    serve({ ...fixture, apps: KNOWN.map(([id, name], i) => row(id, name, id === 'phantom' ? { frontmost: true, action: null }
      : i % 2 ? { running: false, memoryMb: null, pid: null, action: 'open' } : {})) });
    render(<MacAppsCard visible />);
    const rows = await screen.findAllByRole('listitem');
    expect(rows.map(r => r.firstElementChild?.textContent)).toEqual(KNOWN.map(([, name]) => name));
    for (const [i, item] of rows.entries()) {
      expect(item.children[1]?.textContent).toMatch(/^(In front|Running|Not running)/);
      expect(within(item).queryAllByRole('button')).toHaveLength(i === 0 ? 0 : 1);
    }
    expect(within(rows[6]!).getByRole('button', { name: 'Bring to front Devin' })).toHaveTextContent('Bring to front');
    expect(within(rows[7]!).getByRole('button', { name: 'Open Safari' })).toHaveTextContent('Open');
  });
});

it('fits a 390 px column: rows wrap, state text shrinks, nothing has a fixed width', () => {
  // jsdom has no layout engine: assert the rules the 390 px layout depends on.
  const css = readFileSync(resolve(process.cwd(), 'src/web-ui/routes/verse/fleet-host/fleet-host.module.css'), 'utf8');
  const rules = [...css.matchAll(/^\.app\w+[^{]*\{[^}]*\}/gm)].map(m => m[0]).join('\n');
  expect(rules).toMatch(/\.appRow \{[^}]*flex-wrap: wrap/);
  expect(rules).toMatch(/\.appState \{[^}]*min-width: 0[^}]*overflow-wrap: anywhere/);
  expect(rules).not.toMatch(/(?:^|[^-])width:\s*\d+px|min-width:\s*\d{3,}px/);
});

it('says the last thing Phantom did to an app in plain words, and nothing when there is no record', () => {
  const at = '2026-11-18T10:00:00.000Z';
  const say = (lastAction: unknown) => macAppLastAction(row('claude', 'Claude', { lastAction }) as never);
  expect(say({ action: 'open', outcome: 'done', at })).toMatch(/^Opened at \d/);
  expect(say({ action: 'restart', outcome: 'done', at })).toMatch(/^Restarted at \d/);
  expect(say({ action: 'focus', outcome: 'failed', at })).toMatch(/^Bring to front did not finish at \d/);
  expect(say(null)).toBe('');
  expect(say(undefined)).toBe('');
});
