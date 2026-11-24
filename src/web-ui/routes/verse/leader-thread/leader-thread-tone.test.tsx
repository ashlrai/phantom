/**
 * Status colour in the Leader thread carries meaning, and comes from design
 * tokens through data attributes rather than inline styles.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { LeaderThreadPane } from './LeaderThreadPane.js';
import { OwnerChannelsStrip } from './OwnerChannelsStrip.js';
import { ReplyGapChip } from './ReplyGapChip.js';

const read = (name: string) => readFileSync(join(process.cwd(), 'src/web-ui/routes/verse/leader-thread', name), 'utf8');

afterEach(cleanup);

describe('owner channel chips', () => {
  it('marks live and off channels so the dot can say it before the word', () => {
    render(<OwnerChannelsStrip paused={false} channels={[
      { id: 'desktop', enabled: true, reason: '', nextStep: '' },
      { id: 'slack', enabled: false, reason: 'not configured', nextStep: 'Add a Slack token' },
    ]} />);
    const strip = screen.getByRole('list', { name: 'Owner channels' });
    expect(within(strip).getByText('Desktop live')).toHaveAttribute('data-state', 'live');
    expect(within(strip).getByText('Slack off')).toHaveAttribute('data-state', 'off');
    expect(strip).not.toHaveAttribute('style');
  });

  it('marks a paused strip as paused, not as live', () => {
    render(<OwnerChannelsStrip paused channels={[]} />);
    expect(screen.getByText('Channels paused')).toHaveAttribute('data-state', 'paused');
  });

  it('colours a late reply from the stylesheet, not from an inline fallback hex', () => {
    render(<ReplyGapChip gap={{ teammate: 'Dot', state: 'late', unansweredCount: 2, oldestUnansweredMs: 15 * 60_000 }} />);
    const chip = screen.getByRole('listitem');
    expect(chip).toHaveAttribute('data-state', 'late');
    expect(chip).not.toHaveAttribute('style');
    const css = read('./leader-thread.module.css');
    expect(css).toMatch(/\[data-state='late'\][^{]*\{[^}]*--status-warning-fg/);
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css).not.toMatch(/font-size:\s*\d/);
  });
});

describe('Leader overview', () => {
  beforeEach(() => evictAll());
  afterEach(() => vi.unstubAllGlobals());

  it('shows an unknown bottleneck in the unknown tone, never as a warning', async () => {
    stubSurfaceFetch({ routes: {
      '/api/verse/ops/leader-journal': null,
      '/api/verse/leader': null,
      '/api/verse/fleet/live': null,
      '/api/verse/fleet/runs': { inbox: [] },
    } });
    render(<LeaderThreadPane visible />);
    await screen.findByText('Lane health unavailable.');
    const line = screen.getByText(/Current bottleneck:/).closest('p')!;
    expect(line).toHaveTextContent('Current bottleneck: Unknown');
    expect(line).toHaveAttribute('data-tone', 'unknown');
    // The thread readings sit in the toolbar instead of taking a row each.
    const toolbar = screen.getByRole('button', { name: 'Status now' }).closest('header')!;
    expect(within(toolbar).getByText(/bus replies$/)).toBeInTheDocument();
  });

  it('flags a named bottleneck as the one line that asks for attention', async () => {
    stubSurfaceFetch({ routes: {
      '/api/verse/leader/thread': { messages: [] },
      '/api/verse/leader/directives': { directives: [] },
      '/api/verse/fleet/runs': { inbox: [] },
    } });
    render(<LeaderThreadPane visible />);
    const line = (await screen.findByText(/Current bottleneck:/)).closest('p')!;
    await vi.waitFor(() => expect(line).toHaveAttribute('data-tone', 'warning'));
    expect(line).not.toHaveTextContent('Current bottleneck: Unknown');
  });
});
