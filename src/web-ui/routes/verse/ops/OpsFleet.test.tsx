/**
 * Component test: the fleet and router view renders fixture lanes, held
 * items, seat decisions and A/B calibration results, and reports UNKNOWN
 * lane state honestly when the router has never ticked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { OpsFleet } from './OpsFleet.js';
import type { OpsFleetV1 } from '../../../../core/verse/ops-types.js';

function fixture(over: Partial<OpsFleetV1> = {}): OpsFleetV1 {
  return {
    v: 1,
    generatedAt: '2026-10-30T10:05:00Z',
    tickAt: '2026-10-30T10:04:00Z',
    lanes: [
      { lane: 'claude-cli', slots: 2, busy: 1, capReason: null },
      { lane: 'codex', slots: 0, busy: 0, capReason: 'Operator is away' },
    ],
    holdProduction: null,
    held: [
      { itemId: 'i1', repo: 'ashlrai/phantom', title: 'Rework the router', holdKind: 'budget', reason: 'Daily cap reached', nextEligibleAt: '2026-10-31T00:00:00Z', at: '2026-10-30T09:50:00Z' },
    ],
    decisions: [
      {
        at: '2026-10-30T09:55:00Z', itemId: 'i2', taskId: 't9', repo: 'ashlrai/phantom', title: 'Fix the gate',
        seatId: 'seat-codex-1', lane: 'codex', dispatched: true, why: 'Codex had the freshest quota.',
        summary: 'Codex seat 1: freshest quota.', candidates: ['seat-codex-1', 'seat-claude-1'], skipReason: null,
      },
    ],
    experiments: [
      {
        id: 'exp-07', hypothesisId: 'hyp-3', arms: { base: 'h-0004', candidate: 'h-0007' }, status: 'done',
        pairs: 40, wins: 24, losses: 12, ties: 4, lift: { mean: 6.2, ciLow: 1.1, ciHigh: 11.3 },
        verdict: 'adopt', reasons: ['Candidate beat the baseline beyond the noise floor.'],
        startedAt: '2026-10-20T00:00:00Z', finishedAt: '2026-10-28T00:00:00Z',
      },
      {
        id: 'exp-08', hypothesisId: 'hyp-5', arms: { base: 'h-0007', candidate: 'h-0009' }, status: 'running',
        pairs: 6, wins: 2, losses: 3, ties: 1, lift: null,
        verdict: null, reasons: [], startedAt: '2026-10-29T00:00:00Z', finishedAt: null,
      },
    ],
    sources: { tick: 'healthy', journal: 'healthy', learning: 'healthy' },
    ...over,
  };
}

function stub(value: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(value)));
}

beforeEach(() => { evictAll(); localStorage.clear(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('OpsFleet', () => {
  it('renders fixture lanes, holds, decisions and A/B results', async () => {
    stub(fixture());
    render(<OpsFleet />);
    await screen.findByText('claude-cli');
    expect(screen.getByText('1 busy · 2 slots')).toBeInTheDocument();
    expect(screen.getByText('Operator is away')).toBeInTheDocument();
    // Held item, with the router's reason.
    expect(screen.getByText('Rework the router')).toBeInTheDocument();
    expect(screen.getByText(/Daily cap reached/)).toBeInTheDocument();
    // The seat decision explains itself.
    expect(screen.getByText('Fix the gate')).toBeInTheDocument();
    expect(screen.getByText(/seat seat-codex-1/)).toBeInTheDocument();
    expect(screen.getByText('Codex seat 1: freshest quota.')).toBeInTheDocument();
    // The A/B arms and the verdict.
    expect(screen.getByText('exp-07')).toBeInTheDocument();
    expect(screen.getByText(/arms h-0004 vs h-0007/)).toBeInTheDocument();
    expect(screen.getByText(/lift \+6\.2 pts/)).toBeInTheDocument();
    expect(screen.getByText('adopt')).toBeInTheDocument();
    expect(screen.getByText(/lift not measured yet/)).toBeInTheDocument();
  });

  it('says lane state is unknown when the router has never ticked', async () => {
    stub(fixture({ tickAt: null, lanes: null, held: [], sources: { tick: 'degraded', journal: 'healthy', learning: 'healthy' } }));
    render(<OpsFleet />);
    await screen.findByText('The router has not ticked yet, so lane state is unknown.');
    expect(screen.getByText('No lane state to show.')).toBeInTheDocument();
  });

  it('shows the unavailable state when the read fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'nope' }, { status: 500 })));
    render(<OpsFleet />);
    await screen.findByText('The fleet projection is unavailable. Refresh to reconnect.');
  });
});
