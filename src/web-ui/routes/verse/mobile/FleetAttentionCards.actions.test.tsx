import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import type { FleetRuns } from '../ops/ops-runs-model.js';
import { FleetAttentionCards } from './FleetAttentionCards.js';
import { renderMobile, stubFetch } from './mobile.test-support.js';
import { MobileToasts, resetMobileToastsForTest } from './mobile-toast.js';

const now = Date.parse('2026-10-31T12:00:00Z');
const command = '~/.ashlr-runs/bin/fix-claude-lane.sh';
const snapshot: FleetRuns = {
  v: 1, generatedAt: new Date(now).toISOString(),
  sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
  lastTick: new Date(now).toISOString(), paused: false, memFreePct: 50, diskFreeGb: 80,
  claudeLane: 'down token rejected', switches: [],
  lanes: [{ lane: 'example', running: 0, target: 1, queued: 2, held: true, heldReason: 'operator hold', tokensLastHour: null, merged24h: null, mergeRate24h: null }],
  workers: [], leaders: [{ label: 'leader', ageSeconds: 30 }], orchestratorAgents: 1,
  publishesLastHour: [], mergesLastHour: { count: 1, items: [] }, events: [], codexPersonal: null, inbox: [], drop: null,
};

afterEach(() => { evictAll(); resetMobileToastsForTest(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('Fleet attention actions', () => {
  it('copies the visible command and opens runs for the held lane', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    stubFetch({ 'GET /api/verse/fleet/runs': snapshot });
    const { context } = renderMobile(<><FleetAttentionCards nowMs={now} /><MobileToasts /></>);
    fireEvent.click(await screen.findByRole('button', { name: 'Copy command' }));
    expect(screen.getByText(command).tagName).toBe('CODE');
    expect(writeText).toHaveBeenCalledWith(command);
    expect(await screen.findByText('Copied. Run it in a terminal on your Mac.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open runs' }));
    expect(context.navigate).toHaveBeenCalledWith({ screen: 'runs' });
  });
  it('reports clipboard failures while leaving the command readable', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: vi.fn().mockRejectedValue(new Error('unavailable')) } });
    stubFetch({ 'GET /api/verse/fleet/runs': snapshot });
    renderMobile(<><FleetAttentionCards nowMs={now} /><MobileToasts /></>);
    fireEvent.click(await screen.findByRole('button', { name: 'Copy command' }));
    await waitFor(() => expect(screen.getByText('Copy failed')).toBeInTheDocument());
    expect(screen.getByText(command)).toBeInTheDocument();
  });
  it('reports an unavailable clipboard', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined });
    stubFetch({ 'GET /api/verse/fleet/runs': snapshot });
    renderMobile(<><FleetAttentionCards nowMs={now} /><MobileToasts /></>);
    fireEvent.click(await screen.findByRole('button', { name: 'Copy command' }));
    expect(await screen.findByText('Copy failed')).toBeInTheDocument();
  });
});
