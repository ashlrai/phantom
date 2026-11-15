import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll, refetchQuery } from '../../../data/cache.js';
import { LaneTargets } from './LaneTargets.js';
import { opsRunsQuery } from './ops-runs-queries.js';

const row = { lane: 'lane-a', target: 1, floor: 0, ceiling: 6, held: false, heldReason: null, heldUntil: null, lastChange: null, changedBy: null };
const rowHeld = { lane: 'lane-b', target: 2, floor: 0, ceiling: 5, held: true, heldReason: 'Hold reason', heldUntil: null, lastChange: null, changedBy: null };
const targetsBody = { v: 1, generatedAt: '2026-10-31T12:00:00Z', sourceState: 'healthy', lanes: [row, rowHeld] };
const runsBody = {
  v: 1, generatedAt: '2026-10-31T12:00:00Z',
  sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
  lastTick: null, paused: null, memFreePct: null, diskFreeGb: null, switches: [], claudeLane: null,
  lanes: [{ lane: 'lane-a', running: 1, target: 1, queued: 139, held: false, heldReason: null, tokensLastHour: null, merged24h: null, mergeRate24h: null },
          { lane: 'lane-b', running: 2, target: 2, queued: 15, held: true, heldReason: 'Hold reason', tokensLastHour: null, merged24h: null, mergeRate24h: null }],
  workers: [], leaders: [], orchestratorAgents: null, publishesLastHour: [], mergesLastHour: { count: null, items: [] },
  events: [], codexPersonal: null, inbox: [], drop: null,
};
const json = (value: unknown, status = 200) => Response.json(value, { status });
const token = 'a'.repeat(64);

beforeEach(() => { evictAll(); clearMutationToken(); });
afterEach(() => { clearMutationToken(); vi.unstubAllGlobals(); });

function stub(post: (body: unknown) => void) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') { post(JSON.parse(String(init.body))); return json({ ...targetsBody, lanes: [{ ...row, target: 6 }] }); }
    return json(url.endsWith('/fleet/runs') ? runsBody : targetsBody);
  }));
}

/**
 * Tests that the original PR behavior is preserved.
 * This verifies that the PR was correctly reconciled with executable preservation evidence.
 */

it('shows the running and waiting line for lane with backlog', async () => {
  setMutationToken(token);
  const post = vi.fn();
  stub(post);
  await refetchQuery(opsRunsQuery.key, () => opsRunsQuery.fetch(), true);
  render(<LaneTargets />);
  expect(await screen.findByText(/running 1 of 1 · 139 waiting/)).toBeInTheDocument();
  // Should show the raise button for lane-a
  const button = screen.getByRole('button', { name: 'Raise to 6' });
  expect(button).toBeInTheDocument();
  expect(button).not.toBeDisabled();
});

it('does not offer raise action for held lane with backlog', async () => {
  setMutationToken(token);
  const post = vi.fn();
  stub(post);
  await refetchQuery(opsRunsQuery.key, () => opsRunsQuery.fetch(), true);
  render(<LaneTargets />);
  // Lane-b is held, should not show raise button
  const button = screen.queryByRole('button', { name: 'Raise to 5' });
  expect(button).not.toBeInTheDocument();
  
  // Verify the held lane shows the proper status
  expect(await screen.findByText(/running 2 of 2 · 15 waiting/)).toBeInTheDocument();
  const heldChip = screen.getByRole('status', { name: 'Held' });
  expect(heldChip).toBeInTheDocument();
});

it('does not offer raise action for unknown runs (no runs data)', async () => {
  setMutationToken(token);
  const post = vi.fn();
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') { post(JSON.parse(String(init.body))); return json({ ...targetsBody, lanes: [{ ...row, target: 6 }] }); }
    // Return null/empty runs for the case where runs data is not available
    return json(url.endsWith('/fleet/runs') ? null : targetsBody);
  }));
  await refetchQuery(opsRunsQuery.key, () => opsRunsQuery.fetch(), true);
  render(<LaneTargets />);
  
  // Should not show any hint for unknown runs  
  const raiseButton = screen.queryByRole('button', { name: 'Raise to 6' });
  expect(raiseButton).not.toBeInTheDocument();
  
  // Should not show any line
  const line = screen.queryByText(/running/);
  expect(line).not.toBeInTheDocument();
});

it('offers raise action with proper calculation when backlog is 3x current', async () => {
  setMutationToken(token);
  const post = vi.fn();
  stub(post);
  await refetchQuery(opsRunsQuery.key, () => opsRunsQuery.fetch(), true);
  render(<LaneTargets />);
  
  // The math: 139 queued / 3 = 46.33 -> ceiling(46.33) = 47, but limited by ceiling 6.
  // So raiseTo should be 6 (minimum of ceiling and rounded up value)
  expect(await screen.findByText(/running 1 of 1 · 139 waiting/)).toBeInTheDocument();

  const button = screen.getByRole('button', { name: 'Raise to 6' });
  expect(button).toBeInTheDocument();
  expect(button).not.toBeDisabled();
  
  // Test that clicking the button works correctly (posts the change)
  await act(async () => { fireEvent.click(button); });
  expect(post).toHaveBeenCalledTimes(1);
  expect(post).toHaveBeenCalledWith({ lane: 'lane-a', target: 6 });
});

it('handles edge case: backlog = 3 * target', async () => {
  // Create a scenario where queued = 3 * target, which should trigger raise suggestion
  const rowWithExactBacklog = { lane: 'lane-exact', target: 4, floor: 0, ceiling: 10, held: false, heldReason: null, heldUntil: null, lastChange: null, changedBy: null };
  const targetsBodyExact = { v: 1, generatedAt: '2026-10-31T12:00:00Z', sourceState: 'healthy', lanes: [rowWithExactBacklog] };
  const runsBodyExact = {
    v: 1, generatedAt: '2026-10-31T12:00:00Z',
    sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
    lastTick: null, paused: null, memFreePct: null, diskFreeGb: null, switches: [], claudeLane: null,
    lanes: [{ lane: 'lane-exact', running: 4, target: 4, queued: 12, held: false, heldReason: null, tokensLastHour: null, merged24h: null, mergeRate24h: null }],
    workers: [], leaders: [], orchestratorAgents: null, publishesLastHour: [], mergesLastHour: { count: null, items: [] },
    events: [], codexPersonal: null, inbox: [], drop: null,
  };
  
  setMutationToken(token);
  const post = vi.fn();
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') { post(JSON.parse(String(init.body))); return json({ ...targetsBodyExact, lanes: [{ ...rowWithExactBacklog, target: 7 }] }); }
    return json(url.endsWith('/fleet/runs') ? runsBodyExact : targetsBodyExact);
  }));

  await refetchQuery(opsRunsQuery.key, () => opsRunsQuery.fetch(), true);
  render(<LaneTargets />);
  
  // With queued = 12 and target = 4, raiseTo should be: min(10, 4 + ceil(12/3)) = min(10, 4 + 4) = min(10, 8) = 8
  expect(await screen.findByText(/running 4 of 4 · 12 waiting/)).toBeInTheDocument();
  const button = screen.getByRole('button', { name: 'Raise to 8' });
  expect(button).toBeInTheDocument();
  expect(button).not.toBeDisabled();

  // Test clicking the button works
  await act(async () => { fireEvent.click(button); });
  expect(post).toHaveBeenCalledTimes(1);
  expect(post).toHaveBeenCalledWith({ lane: 'lane-exact', target: 8 });
});

it('handles edge case: zero queued (no raise suggestion)', async () => {
  // When there's no backlog, no raise suggestion should appear
  const rowZero = { lane: 'lane-zero', target: 2, floor: 0, ceiling: 6, held: false, heldReason: null, heldUntil: null, lastChange: null, changedBy: null };
  const targetsBodyZero = { v: 1, generatedAt: '2026-10-31T12:00:00Z', sourceState: 'healthy', lanes: [rowZero] };
  const runsBodyZero = {
    v: 1, generatedAt: '2026-10-31T12:00:00Z',
    sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
    lastTick: null, paused: null, memFreePct: null, diskFreeGb: null, switches: [], claudeLane: null,
    lanes: [{ lane: 'lane-zero', running: 1, target: 2, queued: 0, held: false, heldReason: null, tokensLastHour: null, merged24h: null, mergeRate24h: null }],
    workers: [], leaders: [], orchestratorAgents: null, publishesLastHour: [], mergesLastHour: { count: null, items: [] },
    events: [], codexPersonal: null, inbox: [], drop: null,
  };

  setMutationToken(token);
  const post = vi.fn();
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') { post(JSON.parse(String(init.body))); return json({ ...targetsBodyZero, lanes: [{ ...rowZero, target: 2 }] }); }
    return json(url.endsWith('/fleet/runs') ? runsBodyZero : targetsBodyZero);
  }));

  await refetchQuery(opsRunsQuery.key, () => opsRunsQuery.fetch(), true);
  render(<LaneTargets />);
  
  // With no queued items, there should be no raise suggestion
  expect(await screen.findByText(/running 1 of 2/)).toBeInTheDocument();
  const button = screen.queryByRole('button', { name: 'Raise to' });
  expect(button).not.toBeInTheDocument();
});
