import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { TeamDirectory, TeamPerson } from '../../../../shared/team-directory.js';
import * as auth from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { getPane } from '../panes/pane-registry.js';
import { mockViewport, type ViewportMock } from '../shell/viewport.test-support.js';
import { TeamPane } from './TeamPane.js';
import './team.pane.js';

const person = (state: 'verified' | 'pending' | 'unknown'): TeamPerson => ({ id: `person:${state}`, displayName: `${state} person`, role: state === 'verified' ? 'founder' : 'engineer',
  identities: [{ kind: 'email', value: `${state}@example.test`, state }], lanes: ['claude'], seats: ['seat-example'], status: state === 'pending' ? 'pending' : 'member' });
const payload = (people: TeamPerson[]): TeamDirectory => ({ version: 1, team: 'default', people, orgState: 'available' });
const fetcher = vi.fn(); let viewport: ViewportMock | null = null;
beforeEach(() => { evictAll(); fetcher.mockReset(); vi.stubGlobal('fetch', fetcher); vi.spyOn(auth, 'getMutationToken').mockReturnValue('test-only'); vi.spyOn(auth, 'touchMutationHold').mockImplementation(() => {}); });
afterEach(() => { cleanup(); viewport?.restore(); viewport = null; vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe.each([1440, 390])('Team at %i px', width => {
  it('renders empty, verified founder, pending and unknown fixtures', async () => {
    viewport = mockViewport(width); fetcher.mockResolvedValue(Response.json(payload([])));
    const empty = render(<TeamPane visible />); expect(await screen.findByText(/No teammates yet/)).toBeInTheDocument(); empty.unmount(); evictAll();
    fetcher.mockResolvedValue(Response.json(payload([person('verified'), person('pending'), person('unknown')])));
    const { container } = render(<TeamPane visible />); const rows = await screen.findAllByRole('listitem');
    expect(rows).toHaveLength(3); expect(rows[0]).toHaveTextContent('founder');
    for (const [index, state] of ['verified', 'pending', 'unknown'].entries()) {
      expect(within(rows[index]!).getByText(state)).toBeInTheDocument(); expect(rows[index]).toHaveTextContent('Declared lanes: claude'); expect(rows[index]).toHaveTextContent('Agent seats: seat-example');
    }
    expect(container.querySelector('table')).toBeNull();
  });
  it('adds a pending teammate through the shared API and shows one next step', async () => {
    viewport = mockViewport(width); fetcher.mockImplementation(async (_path, init) => Response.json(init?.method === 'POST'
      ? { version: 1, person: person('pending'), next: 'Verify the email with the team owner.' } : payload([])));
    render(<TeamPane visible />); await screen.findByText(/No teammates yet/); fireEvent.click(screen.getByRole('button', { name: 'Add teammate' }));
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Avery' } }); fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'avery@example.test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add teammate' })); expect(await screen.findByText('Verify the email with the team owner.')).toBeInTheDocument();
    const posts = fetcher.mock.calls.filter(([, init]) => init?.method === 'POST'); expect(posts).toHaveLength(1);
    expect(posts[0]![0]).toBe('/api/verse/team/people'); expect(JSON.parse(posts[0]![1].body)).toEqual({ team: 'default', person: { displayName: 'Avery', role: 'viewer', email: 'avery@example.test', lanes: [], seats: [] } });
  });
});
it('shows malformed reads and failed writes without inventing an empty team', async () => {
  fetcher.mockResolvedValue(Response.json({})); render(<TeamPane visible />); expect(await screen.findByText('Team is unavailable. Try again later.')).toBeInTheDocument();
  expect(screen.queryByText(/No teammates yet/)).toBeNull(); fireEvent.click(screen.getByRole('button', { name: 'Add teammate' }));
  fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Avery' } }); fetcher.mockResolvedValue(new Response('{}', { status: 400 }));
  fireEvent.click(screen.getByRole('button', { name: 'Add teammate' })); expect(await screen.findByText(/Could not add this teammate/)).toBeInTheDocument();
});
it('registers Team and keeps cards and form contained at 390 px', () => {
  expect(getPane('fleet-team')).toMatchObject({ title: 'Team', needsSession: false });
  const css = readFileSync('src/web-ui/routes/verse/fleet-team/team.module.css', 'utf8');
  expect(css).toMatch(/\.root \{[^}]*min-width: 0[^}]*overflow-wrap: anywhere/); expect(css).toMatch(/\.header \{[^}]*flex-wrap: wrap/);
  expect(css).toMatch(/\.form input[^}]*box-sizing: border-box[^}]*width: 100%[^}]*min-width: 0/);
});
