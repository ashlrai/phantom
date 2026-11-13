/**
 * DevinResource.fleetmodel.test.tsx — the fleet-model row on the Devin card
 * (RQ-PHX-DEVINFLEETMODEL89): "Fleet model: <id> · free promo / not free /
 * free status unknown", one warning per paid models.json key, the free-promo
 * caveat beside the dollar estimate, and nothing new on an older server that
 * omits the field.
 */
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { DevinResource } from './DevinResource.js';
import { resetGuard } from '../shell/guarded-action.js';

let overview: Record<string, unknown>;

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
}

function status(over: Record<string, unknown> = {}) {
  return {
    enabled: true, connected: true, state: 'ready', reason: 'Connected.',
    orgId: 'org-x', principal: 'service_user', principalName: 'Ashlr Verse', keyStore: 'keychain',
    chatLine: 'Chat: n/a', fleetLine: 'Fleet: Ready', fleetReady: true,
    chat: { ready: false, tone: 'off', word: 'n/a', detail: 'Devin works in sessions, not chat turns.', fix: null },
    fleet: { ready: true, tone: 'ok', word: 'Ready', detail: 'The fleet may launch Devin sessions.', fix: null, roles: ['producer'], reservePercent: null },
    ...over,
  };
}

function budget(over: Record<string, unknown> = {}) {
  return {
    acuBudgetTotal: 50, acuUsed: 12, acuRemaining: 38, acuToday: 12, acuInFlight: 4, estimatedUsdUsed: 4.5, sessionsToday: 2, running: 1, paused: false,
    reportedAcuUsed: 2, unconfirmedAcuExposure: 10,
    canLaunch: { ok: true, reason: null }, canFleetLaunch: { ok: true, reason: null },
    estimateNote: 'ACUs come from Devin\'s own session readings; dollars are an estimate at $2.25 per ACU.',
    usageUrl: 'https://app.devin.ai/settings/usage',
    budget: { v: 1, acuBudgetTotal: 50, acuSpentAdjustment: 0, usdPerAcu: 2.25, maxAcuPerSession: 10, maxAcuPerDay: 30, reserveAcu: 10, pauseAtFraction: 0.9, maxConcurrent: 2, maxSessionsPerDay: 10, updatedAt: '2026-09-27T00:00:00.000Z' },
    ...over,
  };
}

function fleetModel(over: Record<string, unknown> = {}) {
  return { configured: 'swe-2-flash-max', source: 'config', promo: 'free', laneModels: [], ...over };
}

beforeEach(() => {
  evictAll();
  resetGuard();
  overview = { generatedAt: 'x', status: status(), budget: budget(), tasks: [] };
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) =>
    String(input) === '/api/verse/devin' ? json(overview) : json({ error: 'not found' })));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const mount = () => render(<ul><DevinResource /></ul>);

describe('DevinResource fleet model', () => {
  it('names the resolved fleet model and marks a free promo, caveating the dollar estimate', async () => {
    overview['fleetModel'] = fleetModel();
    mount();
    const row = await screen.findByText('Fleet model: swe-2-flash-max · free promo');
    expect(row.getAttribute('data-devin-fleet-model')).toBe('free');
    expect(screen.getByText(/about \$4\.5 for recorded usage \(fleet model is a free promo; estimate may not apply\)/)).toBeTruthy();
    expect(screen.queryByText(/is a paid model/)).toBeNull();
  });

  it.each([
    ['not-free', '· not free'],
    ['unknown', '· free status unknown'],
  ])('promo %s renders without claiming free or touching the estimate', async (promo, suffix) => {
    overview['fleetModel'] = fleetModel({ promo });
    mount();
    const row = await screen.findByText(`Fleet model: swe-2-flash-max ${suffix}`);
    expect(row.getAttribute('data-devin-fleet-model')).toBe(promo);
    expect(screen.getByText(/about \$4\.5 for recorded usage/)).toBeTruthy();
    expect(screen.queryByText(/estimate may not apply/)).toBeNull();
  });

  it('warns on each paid models.json key, naming the key and its model', async () => {
    overview['fleetModel'] = fleetModel({
      promo: 'unknown',
      laneModels: [
        { key: 'devin', model: 'swe-2-high', paid: false },
        { key: 'devin.fast', model: 'swe-2-max-lightning', paid: true },
        { key: 'devin-flash', model: 'swe-2-turbo-lightning', paid: true },
      ],
    });
    mount();
    expect(await screen.findByText('models.json devin.fast = swe-2-max-lightning is a paid model; fleet runs fall back to swe-2-flash-max.')).toBeTruthy();
    expect(screen.getByText('models.json devin-flash = swe-2-turbo-lightning is a paid model; fleet runs fall back to swe-2-flash-max.')).toBeTruthy();
    expect(screen.queryByText(/models\.json devin = swe-2-high/)).toBeNull();
  });

  it('renders nothing new on an older server without the field, or on a malformed one', async () => {
    const first = mount();
    expect(await screen.findByText(/about \$4\.5 for recorded usage/)).toBeTruthy();
    expect(screen.queryByText(/^Fleet model:/)).toBeNull();
    first.unmount();
    evictAll();

    overview['fleetModel'] = { configured: 42, promo: 'super-free' };
    mount();
    expect(await screen.findByText(/about \$4\.5 for recorded usage/)).toBeTruthy();
    expect(screen.queryByText(/^Fleet model:/)).toBeNull();
  });
});
