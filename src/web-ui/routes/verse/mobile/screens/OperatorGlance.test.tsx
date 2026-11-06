import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { evictAll } from '../../../../data/cache.js';
import { renderMobile, stubFetch } from '../mobile.test-support.js';
import { OperatorGlance } from './OperatorGlance.js';

afterEach(() => {
  evictAll();
  vi.unstubAllGlobals();
});

const glance = {
  v: 1,
  at: '2026-11-02T15:00:00.000Z',
  running: 4,
  target: 6,
  usagePct: 62,
  resetsAt: '2026-11-02T18:00:00.000Z',
  mergesToday: 2,
  main: 'down',
  incidents: ['Ship needs a human'],
};

describe('phone glance', () => {
  it('opens on one short reading and an order box', async () => {
    stubFetch({
      'GET /api/verse/fleet/runs/glance': glance,
      'GET /api/verse/fleet/runs': { v: 1, lastTick: null, claudeLane: null, switches: [], lanes: [], mergesLastHour: { count: 0 }, codexPersonal: null, inbox: [] },
      'GET /api/verse/fleet/runs/inbox': { sourceState: 'healthy', entries: [] },
    });
    renderMobile(<OperatorGlance />);
    expect(await screen.findByText('Running 4 of 6.')).toBeInTheDocument();
    expect(screen.getByText('Usage 62%, resets in 3 h.')).toBeInTheDocument();
    expect(screen.getByText('Merges 2 today.')).toBeInTheDocument();
    expect(screen.getByText('Main needs you.')).toBeInTheDocument();
    expect(screen.getByText('Incidents: Ship needs a human.')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Tell the leaders in plain language.')).toBeInTheDocument();
  });
});
