import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { evictAll } from '../../data/cache.js';
import { BotsView } from './BotsView.js';

const mocks = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('../../data/mutations.js', () => ({ createBotFromTemplate: mocks.create }));

const TEMPLATES = ['pr-reviewer', 'release-scribe', 'ci-watchdog'].map((id, i) => ({
  id, name: ['PR reviewer', 'Release scribe', 'CI watchdog'][i], blurb: 'blurb', role: 'reviewer',
  avatar: { glyph: 'XX', hue: 10 }, channels: ['bus'], tasks: 2, crons: 1, memorySeed: 3,
}));

function stubFetch(bots: unknown[] = [], seats: unknown[] = [], seatsError = false) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
    ok: !(seatsError && String(url).includes('/seats')), status: seatsError && String(url).includes('/seats') ? 503 : 200, headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => (String(url).includes('/seats') ? { schema: 'phantom-bot-seats.v1', seats } : String(url).includes('/templates') ? { templates: TEMPLATES } : { bots }),
    text: async () => '',
  })));
}
const mount = () => render(<BotsView />);

beforeEach(() => { evictAll(); mocks.create.mockReset(); stubFetch(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('BotsView', () => {
  const seat = () => ({ id: 'devin-seat', kind: 'devin-bot', displayName: 'Devin reviewer', provider: 'devin', state: 'active', acceptsNewWork: true,
    quota: { status: 'measured', usedPct: 42, asOf: '2026-11-18T12:00:00Z', resetAt: null, source: 'test' }, claims: [], inFlight: [], handoffs: [] });
  it('shows measured quota with an accessible meter and evidence time', async () => {
    stubFetch([], [seat()]); mount();
    expect(await screen.findByRole('meter', { name: 'Devin reviewer quota used' })).toHaveAttribute('aria-valuenow', '42');
    expect(screen.getByText('42% used')).toBeInTheDocument();
    expect(screen.getByText('2026-11-18T12:00:00Z')).toHaveAttribute('dateTime', '2026-11-18T12:00:00Z');
    expect(screen.getByText('Accepts new work: yes')).toBeInTheDocument();
  });
  it('shows unknown evidence without an invented zero or meter', async () => {
    stubFetch([], [{ ...seat(), quota: { status: 'unknown', reason: 'stale-or-missing', asOf: null }, acceptsNewWork: false }]); mount();
    expect(await screen.findByText('Quota: unknown — stale-or-missing')).toBeInTheDocument();
    expect(screen.queryByRole('meter')).not.toBeInTheDocument();
    expect(screen.queryByText(/0%/)).not.toBeInTheDocument();
  });
  it('shows draining work and handoff metadata, redacting secret-shaped content', async () => {
    const secret = `sk-${'A'.repeat(32)}`;
    stubFetch([], [{ ...seat(), state: 'draining', acceptsNewWork: false, quota: { ...seat().quota, status: 'exhausted', usedPct: 100 },
      claims: [{ key: 'pr:org/repo#12' }], inFlight: [{ id: 'review-job' }],
      handoffs: [{ handoffId: 'one', work: { ref: 'prior-job' }, done: secret, left: 'Review tests', branch: 'bot-review', pr: 'org/repo#11' }] }]);
    const { container } = mount();
    expect(await screen.findByText('draining')).toBeInTheDocument();
    for (const text of ['pr:org/repo#12', 'review-job', 'prior-job', '100% used — exhausted']) expect(screen.getByText(text)).toBeInTheDocument();
    expect(screen.getByRole('meter')).toHaveAttribute('aria-valuenow', '100');
    expect(screen.getByText(/Branch: bot-review/)).toHaveTextContent('org/repo#11');
    expect(container.textContent).not.toContain(secret);
  });
  it('shows roster configuration guidance and a separate seats error state', async () => {
    const view = mount();
    expect(await screen.findByText('~/.phantom/bots/seats.json')).toBeInTheDocument();
    expect(screen.getByText('phm bots seats --json')).toBeInTheDocument();
    view.unmount(); evictAll(); stubFetch([], [], true); mount();
    expect(await screen.findByRole('alert')).toHaveTextContent('Seats could not be loaded.');
  });
  it('shows the three starter templates', async () => {
    mount();
    for (const n of ['PR reviewer', 'Release scribe', 'CI watchdog']) expect(await screen.findByText(n)).toBeInTheDocument();
    expect(screen.getByText('No bots yet.')).toBeInTheDocument();
  });

  it('creates a bot from a template and reports disabled crons', async () => {
    mocks.create.mockResolvedValue({ bot: { id: 'rev-1', name: 'PR reviewer', automations: ['au_a'] }, profileVersion: 1, files: [] });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Use PR reviewer' }));
    fireEvent.change(screen.getByLabelText('Bot id'), { target: { value: 'rev-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create bot' }));
    await waitFor(() => expect(mocks.create).toHaveBeenCalledWith({ templateId: 'pr-reviewer', id: 'rev-1', name: 'PR reviewer' }));
    expect(await screen.findByRole('status')).toHaveTextContent('1 cron (disabled)');
  });

  it('rejects a bad id locally and surfaces a server refusal', async () => {
    mocks.create.mockRejectedValue(new Error('A bot named rev-1 already exists.'));
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Use CI watchdog' }));
    fireEvent.change(screen.getByLabelText('Bot id'), { target: { value: 'Bad Id' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create bot' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Id must be 2-24 characters');
    expect(mocks.create).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Bot id'), { target: { value: 'rev-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create bot' }));
    expect(await screen.findByText('A bot named rev-1 already exists.')).toBeInTheDocument();
  });
});
