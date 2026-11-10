import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { evictAll } from '../../data/cache.js';
import { installFetch, json } from './context/context-fixtures.test-support.js';
import { COMMS_STATUS_PATH } from './fleet-inbox/comms-status-model.js';
import { resetVerseUi } from './verse-ui-store.js';
import { SidebarResources } from './SidebarResources.js';

function commsStatus(over: { lastAckAt: string | null; teammate: unknown }) {
  return {
    version: 1, generatedAt: new Date().toISOString(), drafts: null, emailOutbox: null,
    imessage: { configuration: { state: 'configured', reason: '' }, chatDb: { state: 'readable', reason: '' }, cursor: { state: 'present', reason: '' },
      ackSource: 'healthy', lastAckAt: over.lastAckAt, acks24h: 1, nextStep: null },
    teammate: over.teammate,
    sources: { drafts: 'healthy', emailOutbox: 'healthy', imessage: 'healthy', teammate: 'healthy' },
  };
}

beforeEach(() => { evictAll(); resetVerseUi(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('Dot row in the Resources sidebar', () => {
  it('shows label, model, last reply and waiting count, with median and source on hover', async () => {
    const lastAckAt = new Date(Date.now() - 12 * 60_000).toISOString();
    const teammate = { windowHours: 24, targetMinutes: 5, texts: 4, answered: 3, unanswered: 2, ignorable: 0, medianMinutes: 7.5, p90Minutes: 9, maxMinutes: 9, withinTarget: 2, oldestUnanswered: { ageMinutes: 20 }, sourceState: 'healthy' };
    installFetch(({ path }) => path === COMMS_STATUS_PATH ? json(commsStatus({ lastAckAt, teammate })) : json({}, 404));
    render(<SidebarResources />);
    const last = await screen.findByText(/Last reply 12m ago · 2 waiting/);
    expect(screen.getByText('Dot (Ashlr.)')).toBeVisible();
    expect(screen.getByText('Astra 6 · own usage')).toBeVisible();
    expect(last.closest('[data-state]')).toHaveAttribute('data-state', 'active');
    expect(last.closest('[title]')?.getAttribute('title')).toMatch(/Median reply time: 7\.5 min\. Comms status/);
  });

  it('reads "No reading yet" when the read fails, with no numbers', async () => {
    installFetch(() => json({ error: 'unavailable' }, 503));
    render(<SidebarResources />);
    const row = (await screen.findByText('Dot (Ashlr.)')).closest('[data-state]')!;
    expect(row).toHaveAttribute('data-state', 'unknown');
    expect(row).toHaveTextContent('No reading yet');
    expect(row).not.toHaveTextContent(/waiting|ago/);
    expect(row.getAttribute('title')).toContain('Median reply time: No reading yet');
  });
});
