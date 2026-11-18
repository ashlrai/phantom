/** The phone's Home on fixture `phm home` payloads: quiet, busy, red main, needs-you, unknown; 390 px and 768 px. */
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearMutationToken, setMutationToken } from '../../../../data/auth-store.js';
import { evictAll } from '../../../../data/cache.js';
import { resetGuard } from '../../shell/guard-store.js';
import { homeSummary, type HomeFixture } from '../home.test-support.js';
import { json, permissionsFor, renderMobile, stubFetch, TOKEN } from '../mobile.test-support.js';
import { HomeGlance, HOME_PATH, mainTile, NEEDS_SHOWN, runningTile } from './HomeGlance.js';

const ANSWER = 'POST /api/verse/agent-bus/needs-mason/asks/answer';
const INBOX = { 'GET /api/verse/fleet/runs': { inbox: [] }, 'GET /api/verse/fleet/runs/inbox': { sourceState: 'healthy', entries: [] } };
const mac = (kind: HomeFixture, more: Record<string, unknown> = {}) => stubFetch({ [`GET ${HOME_PATH}`]: homeSummary(kind), ...INBOX, ...more });
const tile = (label: string) => screen.getByRole('button', { name: new RegExp(label) });

afterEach(() => { evictAll(); resetGuard(); clearMutationToken(); vi.unstubAllGlobals(); });

describe('phone Home', () => {
  it('quiet fleet: plain zeros, every main green, nothing needs you, and a box for the leader', async () => {
    const fetches = mac('quiet');
    renderMobile(<HomeGlance />);
    expect(await screen.findByText('Nothing needs you.')).toBeInTheDocument();
    expect(tile('Running now')).toHaveTextContent('0Running nowof 8 wanted');
    expect(tile('Merged, last hour')).toHaveTextContent(/^0Merged/);
    expect(tile('Merged, 24 hours')).toHaveTextContent(/^0Merged/);
    expect(tile('Mains green')).toHaveTextContent('2 of 2Mains greenEvery main is green');
    expect(screen.queryByRole('region', { name: 'Needs you' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Message to the leaders')).toBeInTheDocument();
    // One read feeds the numbers; the only other read is the message box's own inbox.
    expect([...new Set(fetches.calls.map((call) => call.url.split('?')[0]))].filter((url) => !url!.includes('/inbox') && url !== '/api/verse/fleet/runs')).toEqual([HOME_PATH]);
  });

  it('busy fleet: big numbers that open the existing Sessions, Goals and PR views', async () => {
    mac('busy');
    const { context } = renderMobile(<HomeGlance />);
    expect(await screen.findByText('27')).toBeInTheDocument();
    expect(tile('Running now')).toHaveTextContent('of 28 wanted');
    expect(tile('Merged, last hour')).toHaveTextContent(/^7/);
    expect(tile('Merged, 24 hours')).toHaveTextContent(/^143/);
    for (const name of [/Running now/, /Mains green/, /Merged, last hour/, 'Sessions', 'Goals', 'PRs']) fireEvent.click(screen.getByRole('button', { name }));
    expect(vi.mocked(context.navigate).mock.calls.map(([route]) => route.screen)).toEqual(['runs', 'fleet', 'feed', 'agents', 'goals', 'feed']);
  });

  it('red main: says how many are green and names the red one', async () => {
    mac('red');
    renderMobile(<HomeGlance />);
    expect(await screen.findByText('Red: phantom')).toBeInTheDocument();
    expect(within(tile('Mains green')).getByText('1 of 2')).toHaveAttribute('data-tone', 'alert');
  });

  it('needs you: listed first with one-word answers, and Yes posts through the asks path', async () => {
    setMutationToken(TOKEN);
    const fetches = mac('needs', { [ANSWER]: { schema: 'asks.answer.v1', status: 'answered', reason: null } });
    const { container } = renderMobile(<HomeGlance />);
    const needs = await screen.findByRole('region', { name: 'Needs you' });
    expect(within(needs).getByRole('heading', { name: 'Needs you · 3' })).toBeInTheDocument();
    expect(needs.compareDocumentPosition(tile('Running now')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(needs).getAllByRole('group')).toHaveLength(NEEDS_SHOWN);
    expect(within(needs).getByText('asked 4 min ago')).toBeInTheDocument();
    expect(within(needs).getByText('asked at an unknown time')).toBeInTheDocument();
    expect(within(needs).getByText('1 more after these.')).toBeInTheDocument();
    const first = within(needs).getAllByRole('group')[0]!;
    expect(within(first).getAllByRole('button').map((button) => button.textContent)).toEqual(['Yes', 'No', 'Done']);
    fireEvent.click(within(first).getByRole('button', { name: 'Yes' }));
    await waitFor(() => expect(fetches.posts()).toHaveLength(1));
    expect(fetches.posts()[0]).toMatchObject({ url: '/api/verse/agent-bus/needs-mason/asks/answer', body: { id: 'nm-111111111111', answer: 'yes' } });
    expect(fetches.posts()[0]!.headers['x-ashlr-token']).toBe(TOKEN);
    // The answered ask leaves at once and the next one takes its place.
    expect(await screen.findByText('Pay the fake invoice')).toBeInTheDocument();
    expect(container.textContent).not.toContain('fake 2FA code');
  });

  it('a refused answer stays on screen, and a read-only phone gets no answer buttons', async () => {
    setMutationToken(TOKEN);
    mac('needs', { [ANSWER]: { schema: 'asks.answer.v1', status: 'refused', reason: 'the fleet decides this itself' } });
    const view = renderMobile(<HomeGlance />);
    fireEvent.click((await screen.findAllByRole('button', { name: 'No' }))[0]!);
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(screen.getByText(/fake 2FA code/)).toBeInTheDocument();
    view.unmount();
    renderMobile(<HomeGlance />, { permissions: permissionsFor('unavailable') });
    expect(await screen.findByText(/fake 2FA code/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Yes' })).not.toBeInTheDocument();
  });

  it('unknown is shown as unknown with the reason, never as zero', async () => {
    mac('unknown');
    renderMobile(<HomeGlance />);
    expect(await screen.findByText('Needs you: unknown. The needs-you ledger could not be read.')).toBeInTheDocument();
    expect(tile('Running now')).toHaveTextContent('UnknownRunning nowNo fleet status has been written yet.');
    expect(tile('Mains green')).toHaveTextContent('The main guardian status could not be read.');
    expect(screen.getAllByText('Unknown')).toHaveLength(4);
    expect(screen.queryByText('0')).not.toBeInTheDocument();
    expect(runningTile({ state: 'ok', value: [{ lane: 'grok', running: 2, target: null }] })).toEqual({ value: '2', hint: undefined });
    expect(mainTile({ state: 'ok', value: [{ repo: 'locus', state: 'unknown' }] })).toEqual({ value: '0 of 1', hint: 'Not known: locus', tone: 'unknown' });
  });

  it('a Mac that cannot serve Home says so and offers a retry', async () => {
    stubFetch({ [`GET ${HOME_PATH}`]: json({ error: 'not found' }, 404), ...INBOX });
    renderMobile(<HomeGlance />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/^Home is unknown\./);
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    evictAll();
    // An older Mac build answers home.v1 without needsYou: say to update rather than draw half a screen.
    const { needsYou: _dropped, ...older } = homeSummary('busy');
    stubFetch({ [`GET ${HOME_PATH}`]: older, ...INBOX });
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText(/Update Phantom on your Mac\./)).toBeInTheDocument();
  });

  it.each([390, 768])('renders at %i px with nothing that can scroll sideways', async (width) => {
    vi.stubGlobal('innerWidth', width);
    mac('needs');
    const { container } = renderMobile(<div style={{ width }}><HomeGlance /></div>);
    await screen.findByRole('region', { name: 'Needs you' });
    // jsdom has no layout, so check what causes sideways scroll: fixed widths, forced single lines, scroll containers.
    // (mobile-overflow.test.ts holds the stylesheet to the same rules.)
    for (const el of container.querySelectorAll<HTMLElement>('*')) {
      for (const size of [el.style.width, el.style.minWidth]) if (size.endsWith('px')) expect(Number.parseFloat(size)).toBeLessThanOrEqual(width);
      expect(el.style.whiteSpace).not.toBe('nowrap');
      expect(['auto', 'scroll']).not.toContain(el.style.overflowX);
      expect(el.tagName).not.toMatch(/^(TABLE|PRE)$/);
    }
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    expect(screen.getAllByRole('button').length).toBeGreaterThanOrEqual(4 + NEEDS_SHOWN * 3 + 3);
  });
});
