import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { SectionVisibilityProvider } from '../shell/section-visibility.js';
import { CodexBurnCard } from './CodexBurnCard.js';
import { recordReading, resetReadings } from './codex-burn-model.js';

const now = Date.parse('2026-01-01T12:00:00Z');
const reading = (usedPct: number, at: number) => ({ usedPct, asOf: new Date(at).toISOString(), resetsAt: new Date(now + 24 * 3_600_000).toISOString(), sourceState: 'healthy' as const });
async function mount(at = now) {
  const sample = reading(64, at);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ sources: { codex: 'healthy' }, codexPersonal: sample }), { status: 200 })));
  render(<SectionVisibilityProvider visible><CodexBurnCard now={now} /></SectionVisibilityProvider>);
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}
beforeEach(() => { resetReadings(); vi.useFakeTimers(); vi.setSystemTime(now); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('shows the projected runway from two readings', async () => {
  recordReading(reading(60, now - 3_600_000), now);
  await mount();
  expect(screen.getByText(/~9h 0m · about/)).toBeInTheDocument();
});
it('shows no pace for one reading', async () => {
  await mount();
  expect(screen.getByText('no pace yet')).toBeInTheDocument();
});
it('shows the reading age', async () => {
  await mount(now - 3 * 60_000);
  expect(screen.getByText('as of 3 min ago')).toBeInTheDocument();
});
it('warns when the reading is stale', async () => {
  await mount(now - 3 * 3_600_000);
  expect(screen.getByText('reading is 3h old')).toHaveStyle({ color: 'var(--status-warning-fg)' });
});
