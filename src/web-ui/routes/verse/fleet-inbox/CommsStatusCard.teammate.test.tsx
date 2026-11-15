import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { CommsStatusCard } from './CommsStatusCard.js';

const teammate = {
  windowHours: 24, targetMinutes: 5, texts: 6, answered: 5, unanswered: 1, medianMinutes: 2, withinTarget: 5,
  oldestUnanswered: { ageMinutes: 14 }, sourceState: 'healthy',
};
function show(extra: Record<string, unknown>, teammateSource = 'healthy') {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({
    version: 1, generatedAt: new Date().toISOString(), drafts: null, emailOutbox: null,
    sources: { drafts: 'degraded', emailOutbox: 'degraded', teammate: teammateSource }, ...extra,
  })));
  render(<CommsStatusCard visible />);
}
beforeEach(() => evictAll());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('shows the Dot reply speed line', async () => {
  show({ teammate });
  expect(await screen.findByText('Dot: 6 texts in 24h, median 2 min, 5 of 6 within 5 min, 1 waiting 14 min')).toBeInTheDocument();
});
it('shows unknown when the teammate source is degraded', async () => {
  show({ teammate: null }, 'degraded');
  expect(await screen.findByText('Dot reply speed unknown (teammate log unreadable)')).toBeInTheDocument();
});
it('shows no Dot line for an older server', async () => {
  show({});
  await screen.findByText('Drafts unavailable');
  expect(screen.queryByText(/Dot/)).not.toBeInTheDocument();
});
