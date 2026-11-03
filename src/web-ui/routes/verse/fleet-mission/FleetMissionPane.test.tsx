import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { FleetMissionPane } from './FleetMissionPane.js';

const briefing = {
  schema: 'fleet.mission.v1',
  generatedAt: '2026-11-02T04:30:00.000Z',
  overview: {
    health: 'attention',
    headline: 'Something needs a look.',
    shipped: '2 pulls merged this hour.',
    attention: null,
    items: [
      { id: 'main:ashlrai/phantom', text: 'ashlrai/phantom main is red. 1 fix job is open.' },
      { id: 'resource:claude', text: 'Claude is out of time.' },
    ],
  },
  jobs: [
    { resource: 'codex-personal', label: 'Personal Codex', model: 'gpt-5.4', running: 1, queued: 0 },
    { resource: 'codex-personal', label: 'Personal Codex', model: null, running: 0, queued: 3 },
  ],
  decisions: [{ at: '2026-11-02T04:05:00Z', resource: 'codex-personal', label: 'Personal Codex', model: 'gpt-5.4', job: 'RQ-9', why: 'the weekly window still has room' }],
  resources: [{ id: 'codex-personal', label: 'Personal Codex', leftPct: 18, creditsLeft: null, resetAt: '2026-11-03T06:00:00Z' }],
  merges: [{ repo: 'ashlrai/phantom', perHour: 1, pulls: [{ repo: 'ashlrai/phantom', number: 42, url: 'https://github.com/ashlrai/phantom/pull/42' }] }],
  mains: [{ repo: 'ashlrai/phantom', health: 'red', fixJobs: ['RQ-PHX-9'], note: 'Main failed typecheck.' }],
  incidents: [{ id: 'incident-1', title: 'phantom main went red', status: 'open', what: 'Typecheck failed after a merge.', applied: 'opened RQ-PHX-9' }],
  memory: { freePct: 41, pressure: 'calm', stale: false, stopped: 0, note: 'Memory is fine.' },
  plan: { title: 'This week', points: ['Keep every main green'] },
};

beforeEach(() => { evictAll(); });
afterEach(() => { vi.unstubAllGlobals(); });

it('shows the briefing first', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(briefing)));
  render(<FleetMissionPane visible />);
  expect(await screen.findByText('Something needs a look.', { selector: 'h2' })).toBeVisible();
  expect(screen.getByText('2 pulls merged this hour.')).toBeInTheDocument();
  expect(screen.getByText('Claude is out of time.')).toBeInTheDocument();
  const link = screen.getByText('ashlrai/phantom #42', { selector: 'a' });
  expect(link).toBeVisible();
  expect(link).toHaveAttribute('href', 'https://github.com/ashlrai/phantom/pull/42');
});

it('opens one detail at a time', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(briefing)));
  render(<FleetMissionPane visible />);
  await screen.findByRole('button', { name: 'The plan' });
  expect(screen.queryByText('Keep every main green')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'The plan' }));
  expect(screen.getByRole('heading', { name: 'This week' })).toBeInTheDocument();
  expect(screen.getByText('Keep every main green')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'What is running' }));
  expect(screen.queryByText('Keep every main green')).toBeNull();
  expect(screen.getByText('Personal Codex · gpt-5.4 · 1 running')).toBeInTheDocument();
  expect(screen.getByText('Personal Codex · not chosen yet · 3 waiting')).toBeInTheDocument();
});

it.each([
  ['Recent choices', ['the weekly window still has room']],
  ['Time left', ['18% left · resets 2026-11-03 06:00 UTC']],
  ['Main branches', ['ashlrai/phantom · red · RQ-PHX-9']],
  ['What went wrong', ['What they did: opened RQ-PHX-9']],
  ['Memory', ['Memory is fine.', '41% free']],
])('opens the %s detail', async (name, readings) => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(briefing)));
  render(<FleetMissionPane visible />);
  fireEvent.click(await screen.findByRole('button', { name }));
  for (const reading of readings) expect(screen.getByText(reading)).toBeInTheDocument();
});

it('says a missing slice has not reported, and survives a missing route', async () => {
  const empty = {
    ...briefing,
    overview: { health: 'unknown', headline: 'The fleet has not reported yet.', shipped: 'Merges have not reported.', attention: 'There is nothing to read yet.', items: [] },
    jobs: [], decisions: [], resources: [], merges: [], mains: [], incidents: [],
    plan: { title: null, points: [] },
  };
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(empty)));
  const view = render(<FleetMissionPane visible />);
  expect(await screen.findByText('There is nothing to read yet.')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'The plan' }));
  expect(screen.getByText('unknown')).toBeInTheDocument();
  view.unmount();
  evictAll();
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({}, { status: 404 })));
  render(<FleetMissionPane visible />);
  expect(await screen.findByText('This view is not in this build yet.')).toBeInTheDocument();
});

it('renders unknown costs and updates through a visible stream without polling', async () => {
  const listeners = new Map<string, () => void>();
  const close = vi.fn();
  vi.stubGlobal('EventSource', class {
    addEventListener(name: string, listener: () => void) { listeners.set(name, listener); }
    close = close;
  });
  const fetch = vi.fn(async () => Response.json(briefing));
  vi.stubGlobal('fetch', fetch);
  const view = render(<FleetMissionPane visible />);
  await screen.findByRole('heading', { name: 'Something needs a look.' });
  fireEvent.click(screen.getByRole('button', { name: 'Merge timeline' }));
  expect(screen.getByText('Cost per merged PR: unknown')).toBeInTheDocument();
  listeners.get('mission')!();
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  view.unmount();
  expect(close).toHaveBeenCalledOnce();
});
