import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { SectionVisibilityProvider } from '../shell/section-visibility.js';
import { UsageSection } from '../sections/UsageSection.js';
import { evictAll } from '../../../data/cache.js';
import { CodexBurnCard } from './CodexBurnCard.js';
import { resetReadings } from './codex-burn-model.js';

const start = Date.parse('2026-01-01T00:00:00Z');
const fixture = (usedPct = 64, at = start, state = 'healthy') => ({ sources: { codex: state }, codexPersonal: { usedPct, resetsAt: new Date(start + 4 * 3_600_000).toISOString(), asOf: new Date(at).toISOString() } });
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const mount = (now = start) => render(<SectionVisibilityProvider visible><CodexBurnCard now={now} /></SectionVisibilityProvider>);
beforeEach(() => { resetReadings(); evictAll(); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe('CodexBurnCard', () => {
  it('shows the reading, source state, tiles and source note', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(fixture(64, start, 'degraded'))));
    mount();
    await screen.findByText('64% used');
    expect(screen.getByRole('meter')).toHaveAttribute('aria-valuetext', '64% used');
    expect(screen.getByText('reading degraded')).toBeInTheDocument();
    expect(screen.getByText('Resets in')).toBeInTheDocument();
    expect(screen.getByText('Pace')).toBeInTheDocument();
    expect(screen.getByText('Needed')).toBeInTheDocument();
    expect(screen.getByText('9.0 pts/h')).toBeInTheDocument();
    expect(screen.getByText("From this Mac's personal Codex session logs; the CMP account is not read.")).toBeInTheDocument();
  });
  it('computes pace after two polls with distinct observations', async () => {
    vi.useFakeTimers();
    let current = fixture();
    vi.spyOn(Date, 'now').mockImplementation(() => Date.parse(current.codexPersonal.asOf));
    vi.stubGlobal('fetch', vi.fn(async () => json(current)));
    const view = mount();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(screen.getByText('64% used')).toBeInTheDocument();
    current = fixture(67.2, start + 3_600_000);
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    vi.useRealTimers();
    view.rerender(<SectionVisibilityProvider visible><CodexBurnCard now={start + 3_600_000} /></SectionVisibilityProvider>);
    expect(await screen.findByText('3.2 pts/h')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Personal Codex usage history' })).toBeInTheDocument();
  }, 40_000);
  it('suppresses 404 retries until the section is reopened', async () => {
    const fetcher = vi.fn(async () => new Response('not found', { status: 404 }));
    vi.stubGlobal('fetch', fetcher);
    const view = mount();
    expect(await screen.findByText('Personal Codex reading is not in this build yet.')).toBeInTheDocument();
    vi.useFakeTimers();
    view.rerender(<SectionVisibilityProvider visible><CodexBurnCard now={start + 1} /></SectionVisibilityProvider>);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(fetcher).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
    view.rerender(<SectionVisibilityProvider visible={false}><CodexBurnCard now={start} /></SectionVisibilityProvider>);
    view.rerender(<SectionVisibilityProvider visible><CodexBurnCard now={start} /></SectionVisibilityProvider>);
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  });
  it('mounts the card first in the Usage body', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/verse/fleet/runs') return json(fixture());
      if (url === '/api/usage') return json({ generatedAt: null, engines: [] });
      return new Response('not found', { status: 404 });
    }));
    render(<SectionVisibilityProvider visible><UsageSection /></SectionVisibilityProvider>);
    const heading = await screen.findByRole('heading', { name: 'Personal Codex burn' });
    const section = screen.getByRole('region', { name: 'Usage' });
    expect(within(section).getAllByRole('heading')[1]).toBe(heading);
  });
});
