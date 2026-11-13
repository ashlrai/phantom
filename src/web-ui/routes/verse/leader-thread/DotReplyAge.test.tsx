import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { DotReplyAge, DOT_REPLY_AGE_PATH } from './DotReplyAge.js';

const now = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
const read = (extra: Record<string, unknown> = {}) => ({
  schema: 'comms.teammate-reply-age.v1', source: 'healthy', lastInboundAt: null, lastOutboundAt: null, answered: null, ...extra,
});

beforeEach(() => { evictAll(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function mount(body: unknown) {
  stubSurfaceFetch({ routes: { [DOT_REPLY_AGE_PATH]: body } });
  return render(<DotReplyAge />);
}

describe('DotReplyAge', () => {
  it('shows "answered" with the age of the last text', async () => {
    mount(read({ lastInboundAt: iso(now - 4 * 60_000), lastOutboundAt: iso(now - 1 * 60_000), answered: true }));
    const chip = await screen.findByRole('status');
    expect(chip).toHaveTextContent('Dot: last text 4 min ago, answered');
    expect(chip).toHaveAttribute('data-dot-reply', 'answered');
  });

  it('shows "NOT answered" under ten minutes without urgency', async () => {
    mount(read({ lastInboundAt: iso(now - 3 * 60_000), answered: false }));
    const chip = await screen.findByRole('status');
    expect(chip).toHaveTextContent('Dot: last text 3 min ago, NOT answered');
    expect(chip).toHaveAttribute('data-dot-reply', 'ok');
  });

  it('marks an unanswered text late at ten minutes or more', async () => {
    mount(read({ lastInboundAt: iso(now - 23 * 60_000), answered: false }));
    const chip = await screen.findByRole('status');
    expect(chip).toHaveTextContent('Dot: last text 23 min ago, NOT answered');
    expect(chip).toHaveAttribute('data-dot-reply', 'late');
  });

  it('says there is no record when the source is missing', async () => {
    mount(read({ source: 'missing' }));
    const chip = await screen.findByRole('status');
    expect(chip).toHaveTextContent('Dot: no iMessage record yet');
    expect(chip).toHaveAttribute('data-dot-reply', 'unknown');
  });

  it('says unknown, never a faked time, when the route is not landed', async () => {
    mount(null);
    const chip = await screen.findByRole('status');
    expect(chip).toHaveTextContent('Dot: reply status unknown');
    expect(chip).toHaveAttribute('data-dot-reply', 'unknown');
  });
});
