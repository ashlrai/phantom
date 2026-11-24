/** The phone's Home on fixture `phm fleet pulse`, `phm home`, `phm approvals` and `phm shipped` payloads: empty, normal, red main, approvals, unknown; measured at 390 px. */
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { driftLine, type SelfDriftV1 } from '../../../../../core/release/drift-shape.js';
import type { ShippedReport } from '../../../../../core/release/shipped.js';
import { clearMutationToken, setMutationToken } from '../../../../data/auth-store.js';
import { evictAll } from '../../../../data/cache.js';
import { resetGuard } from '../../shell/guard-store.js';
import { mockViewport } from '../../shell/viewport.test-support.js';
import { APPROVALS_PATH } from '../../home/ApprovalsCard.js';
import { NODES_POOL_PATH } from '../../home/MachinesCard.js';
import { LEADER_REPLIES_PATH } from '../../home/LeaderRepliesCard.js';
import { DRIFT_PATH, PULSE_PATH } from '../../home/PulseCard.js';
import { PULSE_LANES_PATH } from '../../home/PulseStrip.js';
import { SHIPPED_PATH } from '../../home/ShippedCard.js';
import { SUPPLY_PATH } from '../../home/SupplyCard.js';
import { INTERJECT_POST_PATH } from '../../fleet/interject-request.js';
import { approvalsList, homeSummary, pulse, pulseLanes, type HomeFixture } from '../home.test-support.js';
import { checkView } from '../mobile-check.test-support.js';
import { json, permissionsFor, renderMobile, stubFetch, TOKEN } from '../mobile.test-support.js';
import { ui } from '../ui.js';
import { APPROVALS_SHOWN, healthLine, HomeGlance, HOME_PATH } from './HomeGlance.js';

const ANSWER = `POST ${APPROVALS_PATH}/answer`;
const INBOX = { 'GET /api/verse/fleet/runs': { inbox: [] }, 'GET /api/verse/fleet/runs/inbox': { sourceState: 'healthy', entries: [] } };
const shipped = (total: number | null): ShippedReport => ({
  schema: 'shipped.v1', version: 1, generatedAt: '2026-11-17T12:00:00.000Z', since: '2026-11-16T12:00:00.000Z', days: 1,
  source: total === null ? 'unknown' : 'ok', note: total === null ? 'No git history could be read here.' : null, total,
  repo: null, headline: total ? `Today: ${total} user-facing changes across 1 repo; biggest: Add a phone Home.` : 'Nothing merged in the last 1 day.', repos: total === null ? null : 1, biggest: total ? 'Add a phone Home' : null, maintenance: total === null ? null : 0,
  areas: total ? [{ id: 'desktop', label: 'Desktop app', count: total, lines: [{ text: 'Add a phone Home.', number: 12, mergedAt: '2026-11-17T10:00:00.000Z', repo: null, prs: [12] }] }] : [],
});
// `phm self drift --json` for an installed build that is up to date: the Pulse card's last row.
const DRIFT: SelfDriftV1 = {
  schema: 'phantom.self-drift.v1', version: 1, checkedAt: '2026-11-17T12:00:00.000Z', installed: { version: '3.1.0', revision: 'unknown' },
  latestRelease: { tag: 'v3.1.0', at: '2026-11-17T10:00:00.000Z' }, master: { revision: 'unknown', at: 'unknown' }, behindReleases: 0,
  behindCommits: 'unknown', oldestUnshippedMergeAt: 'unknown', liveFeatures: [], missingFeatures: [], unknownFeatures: [], features: [],
  line: driftLine({ behindReleases: 0, missingFeatures: [], unknownFeatures: [] }),
};
const mac = (kind: HomeFixture, more: Record<string, unknown> = {}) => stubFetch({
  // The unknown fixture leaves the drift read unanswered, so the build is unknown there too.
  ...(kind === 'unknown' ? {} : { [`GET ${DRIFT_PATH}`]: DRIFT }),
  [`GET ${HOME_PATH}`]: homeSummary(kind), [`GET ${PULSE_PATH}`]: pulse(kind), [`GET ${PULSE_LANES_PATH}`]: pulseLanes(kind), [`GET ${APPROVALS_PATH}`]: approvalsList(kind),
  [`GET ${SHIPPED_PATH}`]: shipped(kind === 'unknown' ? null : kind === 'quiet' ? 0 : 3), ...INBOX, ...more });
const health = () => screen.findByRole('status', { name: 'Fleet health' });

afterEach(() => { evictAll(); resetGuard(); clearMutationToken(); vi.unstubAllGlobals(); });

describe('phone Home', () => {
  it.each([
    ['empty', 'quiet', '0 merged in the last hour · 0 lanes running · main green', 'ok', 'Nothing merged in the last 24 hours.'],
    ['normal', 'busy', '7 merged in the last hour · 2 lanes running · main green', 'ok', 'Today: 3 user-facing changes across 1 repo; biggest: Add a phone Home.'],
    ['red main', 'red', '7 merged in the last hour · 2 lanes running · main red: phantom', 'red', 'Today: 3 user-facing changes across 1 repo; biggest: Add a phone Home.'],
  ] as const)('%s at 390 px: Today first, then the rest in order, and nothing a phone cannot use', async (_name, kind, line, tone, shippedLine) => {
    const viewport = mockViewport(390);
    const fetches = mac(kind);
    const { container } = renderMobile(<div className={ui.app} style={{ width: 390 }}><HomeGlance /></div>);
    expect(await health()).toHaveTextContent(line);
    expect(await health()).toHaveAttribute('data-tone', tone);
    const today = within(await screen.findByRole('region', { name: 'Shipped today' }));
    expect(today.getByText(shippedLine)).toBeInTheDocument();
    const pulseCard = within(await screen.findByRole('region', { name: 'Pulse' }));
    // The five pulse numbers, then the running build.
    expect(pulseCard.getAllByRole('listitem')).toHaveLength(6);
    expect(within(pulseCard.getByRole('listitem', { name: 'Running build' })).getByText('3.1.0')).toBeInTheDocument();
    expect(pulseCard.queryAllByText('unknown')).toHaveLength(kind === 'quiet' ? 5 : 0);
    // The strip: four big numbers; unknown when the metrics could not be read, 0 never.
    const strip = within(await screen.findByRole('region', { name: 'Pulse strip' }));
    expect(strip.getAllByRole('listitem')).toHaveLength(4);
    expect(strip.queryAllByText('unknown')).toHaveLength(kind === 'quiet' ? 4 : 0);
    // Top to bottom: Today, the four tiles, the strip, the pulse, health, live build, approvals (or their empty note), supply, pools, the message box, what shipped today.
    const parts = [await screen.findByRole('heading', { name: 'Today' }), screen.getByRole('region', { name: 'Fleet at a glance' }), screen.getByRole('region', { name: 'Pulse strip' }), screen.getByRole('region', { name: 'Pulse' }), await health(), await screen.findByLabelText('Live build'), screen.getByText('Nothing needs you'), screen.getByRole('region', { name: 'Supply' }), screen.getByRole('region', { name: 'Pools' }), screen.getByRole('region', { name: 'Yield' }), screen.getByLabelText('Message to the leaders'), screen.getByRole('region', { name: 'Shipped today' })];
    for (let i = 1; i < parts.length; i++) expect(parts[i - 1]!.compareDocumentPosition(parts[i]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect([...container.firstElementChild!.children]).toHaveLength(15); // includes the yield card and admission card and the one-line release status
    expect(checkView('home', 'Home', container).findings).toEqual([]);
    // One read each for pulse, health, approvals, pools, local capacity, machines and shipped (one day); the only other reads are the message box's own inbox.
    expect([...new Set(fetches.calls.map((call) => call.url))].filter((url) => !url.includes('/fleet/runs')).sort()).toEqual([APPROVALS_PATH, NODES_POOL_PATH, SUPPLY_PATH, `${SHIPPED_PATH}?days=1`, '/api/usage/runway', '/api/fleet/lane-yield', '/api/fleet/local-capacity', '/api/fleet/releases', '/api/app/pools', '/api/verse/build-stale-limits', '/api/verse/agent-bus/needs-mason/asks/batch', '/api/verse/fleet/admission', '/api/verse/fleet/yield', '/api/verse/fleet/memory/host-load'].sort());
    viewport.restore();
  });

  it('shows the leader\'s newest reply between the decisions and the message box', async () => {
    const viewport = mockViewport(390);
    const fetches = mac('busy', { [`GET ${LEADER_REPLIES_PATH}`]: { schema: 'leader.replies.v1', version: 1, sourceState: 'healthy', entries: [],
      replies: [{ at: '2026-11-17 10:00', text: 'Main is green.', source: 'plan-log' }] } });
    const { container } = renderMobile(<div className={ui.app} style={{ width: 390 }}><HomeGlance /></div>);
    const card = await screen.findByRole('region', { name: 'From your leader' });
    expect(within(card).getAllByRole('listitem').map(item => item.textContent)).toEqual(['2026-11-17 10:00 ETMain is green.']);
    const parts = [screen.getByRole('region', { name: 'Decisions' }), card, screen.getByLabelText('Message to the leaders')];
    for (let i = 1; i < parts.length; i++) expect(parts[i - 1]!.compareDocumentPosition(parts[i]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(fetches.calls.map(call => call.url)).toContain(`${LEADER_REPLIES_PATH}?limit=1`);
    expect(checkView('home', 'Home', container).findings).toEqual([]);
    viewport.restore();
  });

  it('shows the live build under the health line: unknown without a report, behind with a date when stale', async () => {
    const viewport = mockViewport(390);
    mac('busy');
    const first = renderMobile(<div className={ui.app} style={{ width: 390 }}><HomeGlance /></div>);
    expect(await screen.findByLabelText('Live build')).toHaveTextContent('Live build: unknown');
    first.unmount(); evictAll();
    const supply = { schema: 'doctor.supply.v1', verdict: 'v', ingested: { state: 'known', path: 'p', sources: [] }, rejected: { state: 'known', path: 'p', total24h: 0, byReason: {} },
      selfSupply: { landed24h: 0, lastLanded: null }, hook: {},
      build: { commit: { state: 'known', sha: 'abc1234', source: 'git' }, behind: { state: 'known', count: 644, ref: 'origin/master', since: '2026-11-12T08:00:00.000Z' } } };
    mac('busy', { [`GET ${SUPPLY_PATH}`]: supply });
    renderMobile(<div className={ui.app} style={{ width: 390 }}><HomeGlance /></div>);
    const line = await screen.findByText('Live build: 644 behind (since Nov 12)');
    expect(line).toHaveAttribute('data-tone', 'red');
    viewport.restore();
  });

  it('the message box posts to the same inbox API as the desktop inbox box', async () => {
    setMutationToken(TOKEN);
    const fetches = mac('busy', { [`POST ${INTERJECT_POST_PATH}`]: { ok: true, at: '2026-11-17T12:00:01.000Z' } });
    renderMobile(<HomeGlance />);
    fireEvent.change(await screen.findByLabelText('Message to the leaders'), { target: { value: 'Ship the phone Home.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(fetches.posts()).toHaveLength(1));
    expect(fetches.posts()[0]).toMatchObject({ url: INTERJECT_POST_PATH, body: { text: 'Ship the phone Home.' } });
  });

  it('approvals: listed first with one big button per option, and Yes posts through the approvals path as the phone', async () => {
    setMutationToken(TOKEN);
    const fetches = mac('needs', { [ANSWER]: { schema: 'approvals.answer.v1', status: 'answered', reason: null } });
    const { container } = renderMobile(<HomeGlance />);
    const needs = await screen.findByRole('region', { name: 'Decisions' });
    expect(within(needs).getByLabelText('3 waiting')).toHaveTextContent('3');
    expect((await health()).compareDocumentPosition(needs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(needs).getAllByRole('group')).toHaveLength(APPROVALS_SHOWN);
    expect(within(needs).getByText(/^asked 4 min ago · by unknown/)).toBeInTheDocument();
    expect(within(needs).getByText(/^asked at an unknown time/)).toBeInTheDocument();
    expect(within(needs).getByText('1 more after these.')).toBeInTheDocument();
    const first = within(needs).getAllByRole('group')[0]!;
    expect(within(first).getAllByRole('button').map((button) => button.textContent)).toEqual(['Yes', 'No', 'Later']);
    fireEvent.click(within(first).getByRole('button', { name: 'Yes' }));
    await waitFor(() => expect(fetches.posts()).toHaveLength(1));
    expect(fetches.posts()[0]).toMatchObject({ url: `${APPROVALS_PATH}/answer`, body: { id: 'nm-111111111111', option: 'yes', from: 'phone' } });
    expect(fetches.posts()[0]!.headers['x-ashlr-token']).toBe(TOKEN);
    // The answered ask leaves at once and the next one takes its place.
    expect(await screen.findByText('Pay the fake invoice')).toBeInTheDocument();
    expect(container.textContent).not.toContain('fake 2FA code');
  });

  it('a refused answer stays on screen, and a read-only phone gets no answer buttons', async () => {
    setMutationToken(TOKEN);
    mac('needs', { [ANSWER]: json({ schema: 'approvals.answer.v1', status: 'unverified', reason: 'Only Mason can answer.' }, 403) });
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

  it('unknown is shown as unknown, never as zero or green', async () => {
    mac('unknown');
    renderMobile(<HomeGlance />);
    expect(await health()).toHaveTextContent('merges unknown · lanes unknown · main unknown');
    expect(await health()).toHaveAttribute('data-tone', 'unknown');
    expect(await screen.findByText('Unknown: the needs-you ledger could not be read.')).toBeInTheDocument();
    expect(await screen.findByText('Unknown: No git history could be read here.')).toBeInTheDocument();
    expect(screen.queryByText(/\b0\b/)).not.toBeInTheDocument();
    expect(await screen.findByText('Unknown: the running build could not be read.')).toBeInTheDocument();
    // A main nobody could read is not green, and a lane with no target still counts as running.
    const partly = { ...homeSummary('busy'), main: { state: 'ok' as const, value: [{ repo: 'locus', state: 'unknown' as const }] }, running: { state: 'ok' as const, value: [{ lane: 'grok', running: 2, target: null }] } };
    expect(healthLine(partly)).toEqual({ text: '7 merged in the last hour · 1 lane running · main unknown', tone: 'unknown' });
  });

  it('a Mac that cannot serve Home says so and offers a retry', async () => {
    stubFetch({ [`GET ${HOME_PATH}`]: json({ error: 'not found' }, 404), [`GET ${APPROVALS_PATH}`]: approvalsList('quiet'), ...INBOX });
    renderMobile(<HomeGlance />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/^Fleet health is unknown\./);
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    evictAll();
    // An older Mac build answers home.v1 without needsYou: say to update rather than draw half a screen.
    const { needsYou: _dropped, ...older } = homeSummary('busy');
    stubFetch({ [`GET ${HOME_PATH}`]: older, [`GET ${APPROVALS_PATH}`]: approvalsList('quiet'), ...INBOX });
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText(/Update Phantom on your Mac\./)).toBeInTheDocument();
  });

});
