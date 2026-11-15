import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { LeaderReplies } from './LeaderReplies.js';

afterEach(() => { cleanup(); evictAll(); vi.unstubAllGlobals(); });

describe('LeaderReplies', () => {
  it('renders a leader reply and a Mason line, with the answers mark', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      inbox: [{ at: '2026-11-04T12:50:00Z', source: 'Phantom mobile', text: 'Fake order text' }],
      outbox: [{ at: '2026-11-04T12:55:00Z', text: 'Fake leader reply' }],
    })));
    render(<LeaderReplies />);
    const card = await screen.findByRole('region', { name: 'Leader replies' });
    expect(await screen.findByText('Fake leader reply')).toBeInTheDocument();
    expect(screen.getByText('Fake order text')).toBeInTheDocument();
    expect(card).toHaveTextContent(/Leader · .*answers “Fake order text”/);
    expect(card).toHaveTextContent(/You · /);
  });

  it('shows two outbox and two plan replies in chronological order', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ inbox: [], outbox: [
      { at: '2026-11-09T01:00:00Z', text: 'Outbox one' },
      { at: '2026-11-09T02:00:00Z', text: 'Plan one' },
      { at: '2026-11-09T03:00:00Z', text: 'Outbox two' },
      { at: '2026-11-09T04:00:00Z', text: 'Plan two' },
    ] })));
    render(<LeaderReplies />);
    const card = await screen.findByRole('region', { name: 'Leader replies' });
    await screen.findByText('Plan two');
    expect(card.textContent).toMatch(/Outbox one.*Plan one.*Outbox two.*Plan two/);
  });

  it('shows the empty line when there is no leader reply', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ inbox: [] })));
    render(<LeaderReplies />);
    expect(await screen.findByText('No reply from the Leader yet')).toBeInTheDocument();
  });

  it('shows one muted line on a read error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'fake failure' }, { status: 500 })));
    render(<LeaderReplies />);
    expect(await screen.findByText('Leader replies could not be read.')).toBeInTheDocument();
    expect(screen.queryByText('No reply from the Leader yet')).not.toBeInTheDocument();
  });
});
