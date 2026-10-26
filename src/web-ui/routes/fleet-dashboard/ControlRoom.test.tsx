import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AgentCard } from '../../../core/verse/agents/types.js';
import { ControlRoom, ControlRoomRoster, mergeCostLabel, type PostHogMergeCost } from './ControlRoom.js';
import { evictAll } from '../../data/cache.js';

const metric: PostHogMergeCost = { source: 'posthog', spentUsd: 18, mergedPrs: 4, from: '2026-10-01', to: '2026-10-08' };
const card = (id: string, patch: Partial<AgentCard> = {}): AgentCard => ({
  id, agentId: id, sessionId: null, title: id, column: 'working', reason: 'running', reasonText: 'Running',
  seatId: 'codex-personal', engine: 'codex', model: null, repo: 'phantom', branch: null, workspacePath: null,
  status: 'running', unread: false, pinned: false, createdAt: '', updatedAt: '', startedAt: null,
  lastActivity: null, turnCount: 1, spend: { usd: null, capUsd: null, fraction: null, tokens: 0 },
  checks: null, autoFix: false, autoMerge: false, plan: null, ports: null, runScripts: [], scripts: [],
  loopNote: null, heldPrompt: false, archived: false, restorable: false, ...patch,
});
const cards = [card('Fix router'), card('Repair CI', { seatId: 'claude-team', column: 'needs-you', reason: 'ci-failed', status: 'error' })];

describe('control room', () => {
  beforeEach(() => evictAll());
  afterEach(() => vi.unstubAllGlobals());

  it('renders fixture agents, each pool, PostHog cost per merged PR, and blocked state without private payloads', () => {
    const privateCard = { ...cards[0]!, environment: { API_KEY: 'fixture-private-key' }, lastActivity: 'fixture-private-activity', reasonText: 'fixture-private-reason' };
    const privateMetric = { ...metric, token: 'fixture-private-posthog', properties: { secret: 'fixture-private-event' } };
    const { container } = render(<ControlRoomRoster cards={[privateCard, cards[1]!, card('Archived', { archived: true }), card('Done', { column: 'done' })]} metric={privateMetric} />);
    expect(screen.getByText('2 live agents · 1 blocked')).toBeInTheDocument();
    for (const text of ['Fix router', 'Repair CI', 'codex-personal', 'claude-team', '$4.50', 'Blocked · CI failed']) expect(screen.getByText(text)).toBeInTheDocument();
    expect(screen.queryByText('Archived')).not.toBeInTheDocument();
    expect(screen.queryByText('Done')).not.toBeInTheDocument();
    expect(container.innerHTML).not.toContain('fixture-private');
  });

  it.each(['failed', 'plan-ready', 'spend-cap', 'setup-failed', 'merge-blocked'] as const)('marks %s as blocked', (reason) => {
    render(<ControlRoomRoster cards={[card('Held', { reason })]} />);
    expect(screen.getByText('1 live agents · 1 blocked')).toBeInTheDocument();
    expect(screen.getByText(/^Blocked ·/)).toBeInTheDocument();
  });

  it('distinguishes empty agents and missing metrics from free successful work', () => {
    render(<ControlRoomRoster cards={[]} />);
    expect(screen.getByText('No live agents.')).toBeInTheDocument();
    expect(screen.getByText('Unavailable')).toBeInTheDocument();
    expect(mergeCostLabel({ ...metric, spentUsd: 0 })).toBe('$0.00');
  });

  it.each([
    { mergedPrs: 0 }, { mergedPrs: -1 }, { mergedPrs: 1.5 }, { spentUsd: NaN },
    { spentUsd: Infinity }, { spentUsd: -1 }, { from: 'invalid' }, { to: metric.from },
  ])('rejects invalid aggregate %j', (patch) => {
    expect(mergeCostLabel({ ...metric, ...patch })).toBe('Unavailable');
  });

  it('loads the real board query and retains the last roster when a refresh fails', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ cards }), { status: 200 }))
      .mockResolvedValueOnce(new Response('private backend failure', { status: 503 }));
    vi.stubGlobal('fetch', fetch);
    render(<ControlRoom />);
    await screen.findByText('Fix router');
    expect(String(fetch.mock.calls[0]?.[0])).toContain('/api/verse/agents');
    await userEvent.click(screen.getByRole('button', { name: 'Refresh agents' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('showing the last received roster'));
    expect(screen.getByText('Fix router')).toBeInTheDocument();
    expect(screen.queryByText('private backend failure')).not.toBeInTheDocument();
  });

  it('renders a safe initial failure and supports retry', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('private error', { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ cards: [] }), { status: 200 })));
    render(<ControlRoom />);
    await screen.findByRole('alert');
    await userEvent.click(screen.getByRole('button', { name: 'Refresh agents' }));
    await screen.findByText('No live agents.');
  });
});
