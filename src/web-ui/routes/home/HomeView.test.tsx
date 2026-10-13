import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { HomeView } from './HomeView.js';
import { evictAll } from '../../data/cache.js';

const EMPTY = { schemaVersion: 1, kind: 'ashlr-home', generatedAt: new Date().toISOString(), windowHours: 24, shipped: { mergedPrs: 0, byRepo: {}, prs: [] }, spend: { costUsd: 0, tokens: 0, agentSeconds: 0, runs: 0 }, value: { mergesPerDollar: null, mergesPerMillionTokens: null, secondsPerMerge: null, medianOpenToMergeSeconds: null }, runningNow: [], needsYou: [], empty: true, warnings: [] };

describe('HomeView', () => {
  beforeEach(() => evictAll());
  afterEach(() => vi.unstubAllGlobals());
  it('empty day points at ecosystem setup', async () => {
    vi.stubGlobal('fetch', vi.fn(async (u: string) => new Response(JSON.stringify(String(u).includes('welcome') ? { complete: true, steps: [], next: null } : EMPTY), { status: 200 })));
    render(<MemoryRouter><HomeView /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText(/Nothing shipped yet/)).toBeInTheDocument());
    expect(screen.getByRole('link', { name: /Set up ecosystem autonomy/ })).toBeInTheDocument();
  });
  it('error names the fix command', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x', { status: 500 })));
    render(<MemoryRouter><HomeView /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('ashlr home --json')).toBeInTheDocument());
  });
});
