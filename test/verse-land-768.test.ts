// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AccountCard } from '../src/web-ui/routes/verse/usage/AccountCard.js';
import { AccountDetail } from '../src/web-ui/routes/verse/usage/AccountDetail.js';
import type { AccountCardModel } from '../src/web-ui/routes/verse/usage/accounts-model.js';

afterEach(cleanup);

it('keeps account navigation and accessible names while identifying the actual engine', () => {
  // A display label can mention another provider; the engine owns the mark.
  const card: AccountCardModel = {
    id: 'sample-account', label: 'Codex migration account', engine: 'claude',
    color: 'var(--engine-claude)', plan: 'max',
    verdict: { state: 'tight', headline: 'Running tight', detail: 'Weekly allowance', code: null },
    allWindows: [], binding: null, others: [], credits: null,
    evidence: { state: 'observed', authentication: 'signed-in', health: null,
      reasonCode: null, observedAt: null, notes: [], unsupported: null },
    reconnectCommand: null, observedAt: null, rank: 2, hasDetail: true, sourceNote: null,
  };
  const onOpen = vi.fn();
  const onClose = vi.fn();
  const view = render(createElement(AccountCard, { card, onOpen }));
  const article = screen.getByRole('article', { name: `${card.label} usage` });
  const mark = article.querySelector('svg[data-provider="claude"]');
  expect(mark).toHaveAttribute('data-inline', 'true');
  expect(mark).toHaveAttribute('aria-hidden', 'true');
  expect(article.querySelector('svg[data-provider="codex"]')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: `${card.label} Running tight` }));
  expect(onOpen).toHaveBeenCalledOnce();

  view.rerender(createElement(AccountDetail, { card, onClose, headingId: 'account-detail' }));
  const heading = screen.getByRole('heading', { name: card.label });
  expect(heading).toHaveFocus();
  expect(heading.querySelector('svg[data-provider="claude"]')).toHaveAttribute('aria-hidden', 'true');
  expect(screen.queryByRole('img')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /close/i }));
  expect(onClose).toHaveBeenCalledOnce();
});
