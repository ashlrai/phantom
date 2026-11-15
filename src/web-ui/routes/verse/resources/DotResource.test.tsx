import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { installFetch, json } from '../context/context-fixtures.test-support.js';
import { COMMS_STATUS_PATH } from '../fleet-inbox/comms-status-model.js';
import { DotResource } from './DotResource.js';

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

function commsStatus(over: {
  configuration?: string; lastAckAt?: string | null; latestTextAt?: string | null;
  unanswered?: number; oldestUnanswered?: { ageMinutes: number } | null; sourceState?: string;
} = {}) {
  return {
    version: 1, generatedAt: new Date().toISOString(), drafts: null, emailOutbox: null,
    imessage: {
      configuration: { state: over.configuration ?? 'configured', reason: '' },
      chatDb: { state: 'readable', reason: '' }, cursor: { state: 'present', reason: '' },
      ackSource: 'ok', lastAckAt: over.lastAckAt === undefined ? minutesAgo(1) : over.lastAckAt,
      acks24h: 3, nextStep: null,
    },
    teammate: {
      windowHours: 24, targetMinutes: 5, texts: 3, answered: 2, unanswered: over.unanswered ?? 0,
      ignorable: 0, medianMinutes: 3, p90Minutes: 4, maxMinutes: 5, withinTarget: 2,
      oldestUnanswered: over.oldestUnanswered ?? null, sourceState: over.sourceState ?? 'healthy',
      latestTextAt: over.latestTextAt === undefined ? minutesAgo(4) : over.latestTextAt,
    },
    sources: { drafts: 'healthy', emailOutbox: 'healthy', imessage: 'healthy', teammate: 'healthy' },
  };
}

beforeEach(() => { evictAll(); });
afterEach(() => { vi.unstubAllGlobals(); });

const card = () => document.querySelector('[data-resource="dot"]')!;

describe('DotResource card in the Resources drawer', () => {
  it('renders live state, both ages, the pending chip and the own-allowance note', async () => {
    installFetch(({ path }) => path === COMMS_STATUS_PATH
      ? json(commsStatus({ unanswered: 2, oldestUnanswered: { ageMinutes: 4 } })) : json({}, 404));
    render(<ul><DotResource /></ul>);
    expect(await screen.findByText('Live')).toBeVisible();
    expect(screen.getByText('last from Dot 4m ago · last reply 1m ago')).toBeVisible();
    expect(screen.getByText('2 waiting')).toBeVisible();
    expect(screen.getByText('Usage: own allowance, not read by Phantom')).toBeVisible();
    expect(screen.getByText('Dot (Ashlr.)')).toBeVisible();
    expect(card()).toHaveAttribute('data-state', 'live');
    expect(card()).not.toHaveTextContent(/MARKER|handle|chat_id|\+1\d{6,}/);
  });

  it('reads waiting-on-the-fleet when the newest inbound went unanswered past the grace', async () => {
    installFetch(({ path }) => path === COMMS_STATUS_PATH
      ? json(commsStatus({ lastAckAt: minutesAgo(30), latestTextAt: minutesAgo(10), unanswered: 1, oldestUnanswered: { ageMinutes: 10 } }))
      : json({}, 404));
    render(<ul><DotResource /></ul>);
    expect(await screen.findByText('Waiting on the fleet')).toBeVisible();
    expect(screen.getByText('1 waiting')).toBeVisible();
    expect(card()).toHaveAttribute('data-state', 'waiting-on-fleet');
  });

  it('renders "Not configured" with no error when the transport is absent', async () => {
    installFetch(({ path }) => path === COMMS_STATUS_PATH ? json(commsStatus({ configuration: 'disabled' })) : json({}, 404));
    render(<ul><DotResource /></ul>);
    expect(await screen.findByText('Not configured')).toBeVisible();
    expect(card()).toHaveAttribute('data-state', 'not-configured');
    expect(card()).not.toHaveTextContent(/waiting/);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('reads "No reading yet" when the status read fails, with no invented numbers', async () => {
    installFetch(() => json({ error: 'unavailable' }, 503));
    render(<ul><DotResource /></ul>);
    expect(await screen.findByText('No reading yet')).toBeVisible();
    expect(card()).toHaveAttribute('data-state', 'unknown');
    expect(card()).toHaveTextContent('No contact on record');
    expect(card()).not.toHaveTextContent(/\d+ (waiting|ago)/);
  });
});
