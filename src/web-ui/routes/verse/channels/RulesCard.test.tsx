/** Render tests for the Rules card: one row per update type from phantom.notify.rules.v1, editable, desktop and 390 px. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { NOTIFY_RULES_PATH, NOTIFY_RULES_SCHEMA, type NotifyRulesView } from '../../../../core/comms/notify-rules-schema.js';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { RulesCard } from './RulesCard.js';

const fixture: NotifyRulesView = {
  schema: NOTIFY_RULES_SCHEMA, version: 1, source: 'defaults', problem: null, mirror: 'desktop',
  channels: [{ id: 'imessage', label: 'iMessage' }, { id: 'email', label: 'Email' }, { id: 'desktop', label: 'Desktop app' }],
  rules: [
    { type: 'decision', label: 'Decisions and approvals', channel: 'imessage', isDefault: true, note: 'Now. Reply YES or NO.' },
    { type: 'incident', label: 'Incidents', channel: 'imessage', isDefault: true, note: 'Now.' },
    { type: 'texts-digest', label: 'Daily texts digest', channel: 'imessage', isDefault: true, note: 'Once a day.' },
    { type: 'digest', label: 'Email and LinkedIn digests', channel: 'email', isDefault: true, note: 'When the digest is ready.' },
    { type: 'shipped', label: 'Shipped work', channel: 'email', isDefault: true, note: 'In the next digest.' },
    { type: 'fyi', label: 'FYI', channel: 'desktop', isDefault: true, note: 'Now.' },
  ],
};
const posts: unknown[] = [];
const serve = (view: unknown, postStatus = 200) => vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
  if (!url.includes(NOTIFY_RULES_PATH)) return Response.json({}, { status: 404 });
  if (init?.method !== 'POST') return Response.json(view);
  const body = JSON.parse(String(init.body)) as { type: string; channel: string };
  posts.push(body);
  return Response.json({ ...fixture, source: 'file', rules: fixture.rules.map(row => row.type === body.type ? { ...row, channel: body.channel, isDefault: false } : row) }, { status: postStatus });
}));
const setWidth = (width: number) => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  window.dispatchEvent(new Event('resize'));
};
const picker = (label: string) => screen.findByRole('combobox', { name: `Channel for ${label}` }) as Promise<HTMLSelectElement>;

beforeEach(() => { evictAll(); posts.length = 0; });
afterEach(() => { cleanup(); clearMutationToken(); vi.restoreAllMocks(); vi.unstubAllGlobals(); setWidth(1024); });

describe.each([['desktop', 1280], ['phone', 390]])('Rules card at %s width (%i px)', (_name, width) => {
  beforeEach(() => setWidth(width));

  it('shows each update type with its channel and saves a change through the same API', async () => {
    serve(fixture);
    setMutationToken('t0ken');
    render(<RulesCard visible />);
    const card = within(await screen.findByRole('region', { name: 'Rules' }));
    expect((await card.findAllByRole('combobox')).map(el => [el.getAttribute('aria-label'), (el as HTMLSelectElement).value])).toEqual(
      fixture.rules.map(row => [`Channel for ${row.label}`, row.channel]));
    expect(card.getByText('Now. Reply YES or NO.')).toBeInTheDocument();
    expect(card.getByText(/Everything is also shown in the desktop app/)).toBeInTheDocument();
    expect(within(await picker('FYI')).getAllByRole('option').map(o => o.textContent)).toEqual(['iMessage', 'Email', 'Desktop app']);

    fireEvent.change(await picker('Shipped work'), { target: { value: 'imessage' } });
    expect(await card.findByText('Saved.')).toBeInTheDocument();
    expect(posts).toEqual([{ type: 'shipped', channel: 'imessage' }]);
    expect((await picker('Shipped work')).value).toBe('imessage');
  });
});

it('without an unlock nothing is posted and the rule stays put', async () => {
  serve(fixture);
  render(<RulesCard visible />);
  fireEvent.change(await picker('FYI'), { target: { value: 'email' } });
  expect(await screen.findByText('Unlock to change a rule.')).toBeInTheDocument();
  expect(posts).toEqual([]);
  expect((await picker('FYI')).value).toBe('desktop');
});

it('a failed save, a rules problem and a drifted payload are all said plainly', async () => {
  serve({ ...fixture, problem: 'The rules file could not be used, so the defaults apply.' }, 500);
  setMutationToken('t0ken');
  render(<RulesCard visible />);
  expect(await screen.findByRole('alert')).toHaveTextContent('defaults apply');
  fireEvent.change(await picker('FYI'), { target: { value: 'email' } });
  expect(await screen.findByText('Could not save. The rule is unchanged.')).toBeInTheDocument();
  expect((await picker('FYI')).value).toBe('desktop');
  cleanup(); evictAll();
  serve({ ...fixture, schema: 'phantom.notify.rules.v0' });
  render(<RulesCard visible />);
  expect(await screen.findByText('Rules are unavailable.')).toBeInTheDocument();
});

it('fits 390 px: rows wrap and the picker never outgrows the card', () => {
  // jsdom has no layout engine: assert the stylesheet the 390 px layout depends on.
  const css = readFileSync(resolve(process.cwd(), 'src/web-ui/routes/verse/channels/channels.module.css'), 'utf8');
  expect(css).toMatch(/\.rule \{[^}]*flex-wrap: wrap[^}]*min-width: 0/);
  expect(css).toMatch(/\.select \{[^}]*max-width: 100%/);
});
