import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SettingsView } from './SettingsView.js';
import { evictAll } from '../../data/cache.js';

const S = { schemaVersion: 1, kind: 'ashlr-settings', autonomy: { level: 'propose', grantActive: false, maxLevel: 'propose' }, repos: { enrolled: [] }, schedules: [], models: { allowedEngines: null, available: ['claude', 'codex'] }, budget: { dailyUsd: 5, perItemMaxTokens: null, maxConcurrent: null }, notifications: { desktop: false, proactive: false, slack: false, discord: false }, constitution: { path: null, versions: [] } };

describe('SettingsView', () => {
  beforeEach(() => evictAll());
  afterEach(() => vi.unstubAllGlobals());
  it('renders every section with empty states and the grant cap', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(S), { status: 200 })));
    render(<MemoryRouter><SettingsView /></MemoryRouter>);
    await waitFor(() => expect(screen.getByRole('radiogroup', { name: 'Autonomy level' })).toBeInTheDocument());
    expect(screen.getByRole('radio', { name: 'autonomous' })).toBeDisabled();
    expect(screen.getByText(/No repos enrolled/)).toBeInTheDocument();
    expect(screen.getByText(/No schedules yet/)).toBeInTheDocument();
    expect(screen.getByText(/No AGENTS.md found/)).toBeInTheDocument();
  });
  it('error state names the fix command', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x', { status: 500 })));
    render(<MemoryRouter><SettingsView /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('ashlr settings --json')).toBeInTheDocument());
  });
});
