import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { SectionVisibilityProvider } from '../shell/section-visibility.js';
import { RunsLanesCard } from './RunsLanesCard.js';

const snapshot = {
  v: 1, generatedAt: '2026-10-31T12:00:00Z', lastTick: '2026-10-31T12:00:00Z', paused: false,
  switches: [], sources: { runsDir: 'healthy' }, lanes: [],
  leaders: [{ label: 'leader', ageSeconds: 240 }],
  codexPersonal: { usedPct: 92, resetsAt: '2026-11-05T04:00:00Z', asOf: '2026-10-31T12:00:00Z' },
};
function stub(value: unknown) {
  vi.stubGlobal('fetch', vi.fn(async (_url: RequestInfo | URL) => Response.json(value)));
}
beforeEach(() => { evictAll(); vi.useFakeTimers(); vi.setSystemTime(new Date(snapshot.generatedAt)); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it('renders leader and personal usage details in the header', async () => {
  stub(snapshot); render(<SectionVisibilityProvider visible><RunsLanesCard /></SectionVisibilityProvider>);
  await act(async () => {});
  expect(screen.getByTestId('lanes-header-extras')).toHaveTextContent('next leader pass in ~11 min · personal Codex 92%, resets Nov 4');
});
it('omits the extras element when neither detail is available', async () => {
  const { leaders: _leaders, codexPersonal: _codexPersonal, ...withoutExtras } = snapshot;
  stub(withoutExtras); render(<SectionVisibilityProvider visible><RunsLanesCard /></SectionVisibilityProvider>);
  await act(async () => {});
  expect(screen.getByText('No lanes reported on this Mac.')).toBeInTheDocument();
  expect(screen.queryByTestId('lanes-header-extras')).not.toBeInTheDocument();
});
