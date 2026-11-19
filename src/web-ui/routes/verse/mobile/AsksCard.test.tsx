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
  { id: 'nm-b', question: 'What is your current usage percent?', kind: 'short-value', askedAt: null, hardLimit: null },
]);

beforeEach(() => { vi.stubGlobal('innerWidth', 390); setMutationToken(TOKEN); });
afterEach(() => { evictAll(); clearMutationToken(); vi.unstubAllGlobals(); });

describe('AsksCard at phone width', () => {
  it('shows "Needs you (2)", a row per ask, big choices, and a text box only for the short-value ask', async () => {
    stubFetch({ [`GET ${BATCH}`]: batch });
    renderMobile(<AsksCard />);
    expect(await screen.findByText('Needs you (2)')).toBeInTheDocument();
    expect(screen.getByText('1. May I spend the gifted API credit?')).toBeInTheDocument();
    expect(screen.getByText(/The fleet may spend it\./)).toBeInTheDocument();
    expect(screen.getByText(/asked \(time unknown\)/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Yes: May I spend/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^No: May I spend/ })).toBeInTheDocument();
    expect(screen.getAllByRole('textbox')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  it('shows the result in place after one tap', async () => {
    const stub = stubFetch({
      [`GET ${BATCH}`]: batch,
      [ANSWER]: (body: Record<string, unknown> | null) => json({ schema: 'asks.answer.v1', status: 'answered', answer: body?.answer }),
    });
    renderMobile(<AsksCard />);
    fireEvent.click(await screen.findByRole('button', { name: /^Yes: May I spend/ }));
    expect(await screen.findByText('Got it: yes.')).toBeInTheDocument();
    expect(stub.posts().map((c) => c.body)).toEqual([{ id: 'nm-a', answer: 'yes' }]);
    expect(screen.queryByRole('button', { name: /^Yes: May I spend/ })).toBeNull();
  });

  it('says why when the answer is refused', async () => {
    stubFetch({ [`GET ${BATCH}`]: batch, [ANSWER]: () => json({ error: 'Already answered; that stays.' }, 409) });
    renderMobile(<AsksCard />);
    fireEvent.click(await screen.findByRole('button', { name: /^No: May I spend/ }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('is gone when there are no asks', async () => {
    const stub = stubFetch({ [`GET ${BATCH}`]: buildAskBatch([]) });
    const { container } = renderMobile(<AsksCard />);
    await vi.waitFor(() => expect(stub.calls).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(container).toBeEmptyDOMElement();
  });

  it('says unknown when the ledger cannot be read', async () => {
    stubFetch({ [`GET ${BATCH}`]: { ...buildAskBatch([], 'unavailable') } });
    renderMobile(<AsksCard />);
    expect(await screen.findByText(/Asks unknown/)).toBeInTheDocument();
  });
});
