import { fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildAskBatch } from '../../../../core/fleet/asks-batch.js';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { AsksCard } from './AsksCard.js';
import { json, renderMobile, stubFetch, TOKEN } from './mobile.test-support.js';

const BATCH = '/api/verse/agent-bus/needs-mason/asks/batch';
const ANSWER = 'POST /api/verse/agent-bus/needs-mason/asks/answer';
const batch = buildAskBatch([
  { id: 'nm-a', question: 'May I spend the gifted API credit?', kind: 'yes-no', askedAt: '2026-11-13T00:00:00.000Z', hardLimit: 'money' },
  { id: 'nm-b', question: 'What is your current usage percent?', kind: 'short-value', numeric: true, askedAt: null, hardLimit: null },
]);

beforeEach(() => { vi.stubGlobal('innerWidth', 390); setMutationToken(TOKEN); });
afterEach(() => { evictAll(); clearMutationToken(); vi.unstubAllGlobals(); });

describe('AsksCard at phone width', () => {
  it('shows "Asks (2)", a row per ask, big choices, and a text box only for the short-value ask', async () => {
    stubFetch({ [`GET ${BATCH}`]: batch });
    renderMobile(<AsksCard />);
    expect(await screen.findByText('Asks (2)')).toBeInTheDocument();
    expect(screen.getByText('1. May I spend the gifted API credit?')).toBeInTheDocument();
    expect(screen.getByText(/The fleet may spend it\./)).toBeInTheDocument();
    expect(screen.getByText(/asked \(time unknown\)/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Yes: May I spend/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^No: May I spend/ })).toBeInTheDocument();
    expect(screen.getAllByRole('spinbutton')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  it('shows the result in place after one tap', async () => {
    const stub = stubFetch({
      [`GET ${BATCH}`]: batch,
      [ANSWER]: (body: Record<string, unknown> | null) => json({ schema: 'asks.answer.v1', status: 'answered', answer: body?.answer }),
    });
    renderMobile(<AsksCard />);
    fireEvent.click(await screen.findByRole('button', { name: /^Yes: May I spend/ }));
    expect(await screen.findByText('Recorded: yes.')).toBeInTheDocument();
    expect(stub.posts().map((c) => c.body)).toEqual([{ id: 'nm-a', answer: 'yes' }]);
    expect(screen.queryByRole('button', { name: /^Yes: May I spend/ })).toBeNull();
  });

  it('says why when the answer is refused', async () => {
    stubFetch({ [`GET ${BATCH}`]: batch, [ANSWER]: () => json({ error: 'Already answered; that stays.' }, 409) });
    renderMobile(<AsksCard />);
    fireEvent.click(await screen.findByRole('button', { name: /^No: May I spend/ }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('says "Nothing needs you." when there are no asks', async () => {
    stubFetch({ [`GET ${BATCH}`]: buildAskBatch([]) });
    renderMobile(<AsksCard />);
    expect(await screen.findByText('Nothing needs you.')).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('takes one number for a usage ask, rejects 101, and records the number', async () => {
    const stub = stubFetch({
      [`GET ${BATCH}`]: batch,
      [ANSWER]: (body: Record<string, unknown> | null) => json({ schema: 'asks.answer.v1', status: 'answered', answer: body?.answer }),
    });
    renderMobile(<AsksCard />);
    const field = await screen.findByLabelText(/^Percent \(0 to 100\): What is your current usage/);
    expect(field).toHaveAttribute('type', 'number');
    const send = screen.getByRole('button', { name: 'Send' });
    fireEvent.change(field, { target: { value: '101' } });
    expect(send).toBeDisabled();
    fireEvent.change(field, { target: { value: '63' } });
    expect(send).toBeEnabled();
    fireEvent.click(send);
    expect(await screen.findByText('Recorded: 63.')).toBeInTheDocument();
    expect(stub.posts().map((c) => c.body)).toEqual([{ id: 'nm-b', answer: '63' }]);
  });

  it('disables every answer with a plain reason when the session is not unlocked', async () => {
    clearMutationToken();
    const stub = stubFetch({ [`GET ${BATCH}`]: batch });
    renderMobile(<AsksCard />);
    expect(await screen.findByText('Asks (2)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Yes: May I spend/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^No: May I spend/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(screen.getAllByText(/Unlock actions to answer/)).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: /^Yes: May I spend/ }));
    expect(stub.posts()).toHaveLength(0);
  });

  it('says unknown when the ledger cannot be read', async () => {
    stubFetch({ [`GET ${BATCH}`]: { ...buildAskBatch([], 'unavailable') } });
    renderMobile(<AsksCard />);
    expect(await screen.findByText(/Asks unknown/)).toBeInTheDocument();
  });
});

describe('AsksCard expiry', () => {
  it('lists the soonest expiry first and says when the expiry is unknown', async () => {
    const soon = new Date(Date.now() + 2 * 86400_000).toISOString();
    const later = new Date(Date.now() + 5 * 86400_000).toISOString();
    stubFetch({ [`GET ${BATCH}`]: buildAskBatch([
      { id: 'nm-n', question: 'No expiry here?', kind: 'yes-no', askedAt: '2026-11-13T00:00:00.000Z', hardLimit: null },
      { id: 'nm-l', question: 'Later one?', kind: 'yes-no', askedAt: '2026-11-14T00:00:00.000Z', expires: later, hardLimit: null },
      { id: 'nm-s', question: 'Sooner one?', kind: 'yes-no', askedAt: '2026-11-15T00:00:00.000Z', expires: soon, hardLimit: null },
    ]) });
    renderMobile(<AsksCard />);
    expect(await screen.findByText('1. Sooner one?')).toBeInTheDocument();
    expect(screen.getByText('2. Later one?')).toBeInTheDocument();
    expect(screen.getByText('3. No expiry here?')).toBeInTheDocument();
    expect(screen.getByText(/expires in 2d/)).toBeInTheDocument();
    expect(screen.getByText(/expiry unknown/)).toBeInTheDocument();
  });
});
