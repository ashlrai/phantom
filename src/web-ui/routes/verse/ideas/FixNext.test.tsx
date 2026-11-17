import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IdeaListReport } from '../../../../core/fleet/bottleneck-ideas.js';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { evidenceText, FixNext } from './FixNext.js';
import { IdeasPane } from './IdeasPane.js';

const reply = (body: object, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const ok = (name: IdeaListReport['signals'][number]['name']) => ({ name, status: 'ok' as const, reason: null });
const report = (ideas: IdeaListReport['ideas'], unknown = false): IdeaListReport => ({
  schema: 'fleet.idea-list.v1', generatedAt: '2026-11-17T12:00:00.000Z', ideas,
  signals: [ok('empty-launches'), ok('guardian-fixups'), unknown ? { name: 'disk-trend', status: 'unknown', reason: 'not enough disk samples to see a trend' } : ok('disk-trend'), ok('idle-lanes'), ok('unspent-usage')],
});
const ideas: IdeaListReport['ideas'] = [
  { id: 'disk-trend:runway', signal: 'disk-trend', title: 'Disk will drop below 150 GB free in about 15 hours', evidence: { freeGb: 180, gbPerHour: 2 },
    payoff: { score: 75, text: 'Lanes keep launching instead of stalling on a full disk' }, task: 'Free disk space.' },
  { id: 'idle-lanes:claude', signal: 'idle-lanes', title: 'claude has 5 jobs waiting but runs 0 of 3', evidence: { queued: 5, running: 0, projectedLeftAtResetPct: null },
    payoff: { score: 66, text: '3 more jobs running at once on claude' }, task: 'Find why lane claude launches nothing.' },
];

beforeEach(() => { evictAll(); setMutationToken('tok'); });
afterEach(() => { clearMutationToken(); vi.unstubAllGlobals(); });

describe('FixNext', () => {
  it('renders the ranked list in order with payoff, evidence and one Queue it each', async () => {
    stubSurfaceFetch({ routes: { '/api/verse/fleet/control/ideas': report(ideas) } });
    render(<FixNext visible />);
    const items = await screen.findAllByRole('listitem');
    expect(items.map(item => within(item).getAllByText(/./)[0]!.textContent)).toEqual([ideas[0]!.title, ideas[1]!.title]);
    expect(screen.getByText('Lanes keep launching instead of stalling on a full disk')).toBeInTheDocument();
    expect(screen.getByText('free gb 180 · gb per hour 2')).toBeInTheDocument();
    expect(screen.getAllByRole('button')).toHaveLength(2);
    expect(screen.getAllByRole('button').every(button => button.textContent === 'Queue it')).toBe(true);
  });

  it('shows the empty state and names signals it could not check', async () => {
    stubSurfaceFetch({ routes: { '/api/verse/fleet/control/ideas': report([], true) } });
    render(<FixNext visible />);
    expect(await screen.findByText('Nothing is stuck right now.')).toBeInTheDocument();
    expect(screen.getByText('Not checked: Disk trend (not enough disk samples to see a trend).')).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('Queue it posts the idea id and shows the job it became', async () => {
    const stub = stubSurfaceFetch({ routes: { '/api/verse/fleet/control/ideas': report(ideas) },
      post: () => reply({ ideaId: 'idle-lanes:claude', jobId: 'IDEA0123456789AB', queued: true, existing: false }) });
    render(<FixNext visible />);
    fireEvent.click(await screen.findByRole('button', { name: `Queue it: ${ideas[1]!.title}` }));
    expect(await screen.findByRole('status')).toHaveTextContent('Queued as RQ-PHX-IDEA0123456789AB');
    expect(stub.posted).toEqual([{ url: '/api/verse/fleet/control/ideas/queue', body: { id: 'idle-lanes:claude' } }]);
    expect(screen.getByRole('button', { name: `Queue it: ${ideas[1]!.title}` })).toBeDisabled();
  });

  it('says so when actions are locked or the server refuses', async () => {
    clearMutationToken();
    stubSurfaceFetch({ routes: { '/api/verse/fleet/control/ideas': report(ideas) } });
    render(<FixNext visible />);
    fireEvent.click((await screen.findAllByRole('button', { name: /^Queue it/ }))[0]!);
    expect(await screen.findByRole('alert')).toHaveTextContent(/Unlock actions/);
  });

  it('treats an unreadable list as unknown, not as nothing stuck', async () => {
    stubSurfaceFetch({ routes: { '/api/verse/fleet/control/ideas': null } });
    render(<FixNext visible />);
    expect(await screen.findByText('Could not read what to fix next.')).toBeInTheDocument();
    expect(screen.queryByText('Nothing is stuck right now.')).toBeNull();
  });

  it('leads the Ideas view', async () => {
    stubSurfaceFetch({ routes: { '/api/verse/fleet/control/ideas': report(ideas), '/api/backlog': [] } });
    render(<IdeasPane />);
    const headings = await screen.findAllByRole('heading');
    expect(headings[0]).toHaveTextContent('Fix next');
  });
});

it('evidence reads in plain words and keeps unknown values unknown', () => {
  expect(evidenceText({ emptyRate: 0.75, projectedLeftAtResetPct: null })).toBe('empty rate 0.75 · projected left at reset pct unknown');
});
