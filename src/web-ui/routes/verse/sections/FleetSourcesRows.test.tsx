import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { FleetSourcesRows } from './FleetSourcesRows.js';

beforeEach(() => { evictAll(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('FleetSourcesRows', () => {
  it('shows live sources and snapshot age', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
      generatedAt: new Date(Date.now() - 4000).toISOString(), claudeLane: 'claude-cli',
    })));
    render(<FleetSourcesRows />);
    expect(await screen.findAllByText('Live')).toHaveLength(5);
    expect(screen.getByText('Snapshot 4 s old')).toBeInTheDocument();
    expect(screen.getByText('Claude lane: claude-cli')).toBeInTheDocument();
  });
  it('shows stale snapshots and source remedies', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ generatedAt: new Date(Date.now() - 45000).toISOString(),
      sources: { merges: 'degraded', codex: 'missing', inbox: 'not-landed' } })));
    render(<FleetSourcesRows />);
    expect(await screen.findByText('Snapshot stale')).toBeInTheDocument();
    expect(screen.getByText('Not part of this build.')).toBeInTheDocument();
    expect(screen.getByText('No personal Codex session logs found.')).toBeInTheDocument();
    expect(screen.getByText('GitHub CLI not available or not signed in; merges in the last hour cannot be counted.')).toBeInTheDocument();
  });
  it('renders one row for a 404', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({}, { status: 404 })));
    render(<FleetSourcesRows />);
    expect(await screen.findByText('Live runs not in this build')).toBeInTheDocument();
    expect(screen.queryByText('Runs directory')).not.toBeInTheDocument();
  });
  it('renders unknown sources after a thrown fetch error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('private /Users/example'); }));
    render(<FleetSourcesRows />);
    await screen.findByText('Runs directory');
    await vi.waitFor(() => expect(screen.getAllByText('—')).toHaveLength(6));
    expect(screen.queryByText(/private/)).not.toBeInTheDocument();
  });
});
