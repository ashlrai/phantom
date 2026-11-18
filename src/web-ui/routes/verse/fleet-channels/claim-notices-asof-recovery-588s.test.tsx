import { afterEach, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { narrowClaimNotices } from './claim-notices-model.js';
import { ClaimNoticesBody } from './ClaimNoticesCard.js';

afterEach(cleanup);

it('qualifies old-server pending rows and displays explicitly observed rows as waiting', () => {
  const generatedAt = '2026-11-18T11:58:00.000Z';
  const raw = { v: 1, source: 'ok', generatedAt, bindings: 1,
    sent: { total: 0, recent: [] },
    pending: [{ state: 'ASSIGNED', threadKey: 'fake-thread', text: 'fake pending notice' }] };
  const oldView = narrowClaimNotices(raw);
  expect(oldView).not.toBeNull();
  const old = render(<ClaimNoticesBody view={oldView!} nowMs={Date.parse('2026-11-18T12:00:00Z')} />);
  expect(screen.getByText(/pending unknown \(not-reported\)/)).toBeInTheDocument();
  expect(old.container.textContent).not.toMatch(/\d+ waiting|would post|fake pending notice/);
  expect(old.container.querySelector(`time[datetime="${generatedAt}"]`)?.textContent).toBe('2m ago');
  cleanup();
  const knownView = narrowClaimNotices({ ...raw, pendingObservation: { state: 'known' } });
  expect(knownView).not.toBeNull();
  const known = render(<ClaimNoticesBody view={knownView!} nowMs={Date.parse('2026-11-18T12:00:00Z')} />);
  expect(screen.getByText(/1 waiting/)).toBeInTheDocument();
  expect(screen.getByText('fake pending notice')).toBeInTheDocument();
  expect(screen.getByText('would post')).toBeInTheDocument();
  expect(known.container.querySelector(`time[datetime="${generatedAt}"]`)?.textContent).toBe('2m ago');
});
