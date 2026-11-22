import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { familyYield, unknownFamilyYield } from '../../../../core/fleet/family-yield.js';
import { evictAll, refetchQuery } from '../../../data/cache.js';
import { renderMobile, stubFetch } from '../mobile/mobile.test-support.js';
import { checkView } from '../mobile/mobile-check.test-support.js';
import { FamilyYieldCard, familyYieldQuery } from './FamilyYieldCard.js';

afterEach(() => { evictAll(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const path = '/api/verse/fleet/yield';
it('shows the worst five typed family sentences at phone width and rejects a failed refresh', async () => {
  const now = Date.now();
  const names = ['SCRIPTSLAND', 'DOCSLAND', 'CONSOLELAND', 'RECUT', 'TESTS', 'BRIDGE', 'CORE'];
  const report = familyYield(names.flatMap(name => [
    JSON.stringify({ event: 'launch', job: `RQ-PHX-${name}793B`, ts: new Date(now - 1000).toISOString() }),
    JSON.stringify({ event: 'finish', job: `RQ-PHX-${name}793B`, empty: true, tokens_total: 1500000, summary: 'No eligible PR' }),
  ]), now, 24);
  stubFetch({ [`GET ${path}`]: report });
  const { container } = renderMobile(<div style={{ width: 390 }}><FamilyYieldCard /></div>);
  const card = within(screen.getByRole('region', { name: 'Launch yield' }));
  await waitFor(() => expect(card.getAllByRole('listitem')).toHaveLength(5));
  expect(card.getAllByRole('listitem').map(n => n.textContent)).toEqual(report.launch_families.slice(0, 5).map(r => r.sentence));
  expect(card.getAllByRole('listitem')[0]).toHaveTextContent("1 of 1 empty, mostly 'no eligible source PR (or source PR already merged)'");
  expect(checkView('yield', 'Launch yield', container).findings).toEqual([]);
  stubFetch({});
  await refetchQuery(familyYieldQuery.key, () => familyYieldQuery.fetch(), true).catch(() => undefined);
  await waitFor(() => expect(card.getByText('Launch yield unknown: could not refresh.')).toHaveTextContent('could not refresh'));
  expect(card.queryAllByRole('listitem')).toHaveLength(0);
});
it.each([true, false])('distinguishes no launches from unreadable metrics (%s)', async known => {
  stubFetch({ [`GET ${path}`]: known ? familyYield([], Date.now(), 24) : unknownFamilyYield(24) });
  renderMobile(<FamilyYieldCard />);
  expect(await screen.findByText(known ? 'No launches in the last 24 hours.' : 'Launch yield unknown.')).toBeInTheDocument();
});
