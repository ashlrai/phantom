import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { AgentCard } from '../../../../core/verse/agents/types.js';
import { AgentRoster, agentInitials } from './AgentRoster.js';

function card(over: Partial<AgentCard> = {}): AgentCard {
  return {
    id: 'ag_aaaaaaaaaaaaaaaa',
    agentId: 'ag_aaaaaaaaaaaaaaaa',
    sessionId: 'vs_a',
    title: 'Fix login',
    column: 'working',
    reason: 'running',
    reasonText: 'Working',
    seatId: 'claude',
    engine: 'claude',
    model: 'claude-sonnet-5',
    repo: 'app',
    branch: 'verse/fix-login',
    workspacePath: '~/.ashlr-worktrees/app/fix-login',
    status: 'running',
    unread: false,
    pinned: false,
    createdAt: '2026-09-27T11:00:00Z',
    updatedAt: '2026-09-27T11:59:00Z',
    startedAt: '2026-09-27T11:58:00Z',
    lastActivity: 'Running npm test',
    turnCount: 1,
    spend: { usd: 1.24, capUsd: 5, fraction: 0.248, tokens: 100_000 },
    checks: null,
    autoFix: false,
    autoMerge: false,
    plan: null,
    ports: { base: 41000, count: 10 },
    runScripts: ['Dev'],
    scripts: [],
    loopNote: null,
    heldPrompt: false,
    archived: false,
    restorable: false,
    ...over,
  };
}

describe('AgentRoster', () => {
  it('shows one engine-coloured avatar per agent and marks working agents', () => {
    render(<AgentRoster cards={[
      card(),
      card({ id: 'ag_2', title: 'Fix login again' }),
      card({ id: 'ag_3', agentId: 'ag_bbbbbbbbbbbbbbbb', title: 'Ship docs', engine: 'grok', column: 'review' }),
      card({ id: 'ag_4', agentId: null, title: 'Plain chat' }),
    ]} />);
    const roster = screen.getByRole('list', { name: 'Agent roster' });
    const avatars = within(roster).getAllByRole('img');
    expect(avatars).toHaveLength(2);
    expect(avatars[0]).toHaveTextContent('FL');
    expect(avatars[0]).toHaveAttribute('data-engine', 'claude');
    expect(avatars[0]).toHaveAccessibleName('Fix login, working');
    expect(avatars[1]).toHaveAccessibleName('Ship docs');
    expect(avatars[1]).not.toHaveAttribute('data-working');
  });

  it('caps the roster and renders nothing without agents', () => {
    const many = Array.from({ length: 10 }, (_, n) => card({ id: `ag_${n}`, agentId: `ag_${n}`, title: `Agent ${n}` }));
    const { rerender } = render(<AgentRoster cards={many} />);
    expect(screen.getByLabelText('2 more agents')).toHaveTextContent('+2');
    rerender(<AgentRoster cards={[]} />);
    expect(screen.queryByRole('list', { name: 'Agent roster' })).toBeNull();
    expect(agentInitials('  ')).toBe('?');
  });
});
