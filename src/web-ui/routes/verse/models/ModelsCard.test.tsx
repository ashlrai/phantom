/** Render tests for the Models card: counts and the list from models.check.v1, at desktop width and 390 px. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelCheckReport, ModelCheckRow } from '../../../../core/fleet/model-check.js';
import { evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { mockViewport, type ViewportMock } from '../shell/viewport.test-support.js';
import { ModelsCard } from './ModelsCard.js';
import { ModelsPane } from './ModelsPane.js';

const PATH = '/api/verse/fleet/control/models';
const DOCS = 'https://docs.example.test/models';
const row = (id: string, extra: Partial<ModelCheckRow> = {}): ModelCheckRow => ({
  id, provider: 'openai', lanes: [], source_url: DOCS, confirmed_on: '2026-11-17', state: 'confirmed', routable: true, docs: 'unknown', replacement: null, reason: null, ...extra,
});
const report = (models: ModelCheckRow[], extra: Partial<ModelCheckReport> = {}): ModelCheckReport => ({
  schema: 'models.check.v1', version: 1, summary: 'Provider docs are unknown.', ok: false, registry: 'ok', router_choices: 'ok', docs: 'unknown', docs_as_of: null, stale_after_days: 14,
  counts: { confirmed: models.filter(m => m.state === 'confirmed').length, stale: models.filter(m => m.state === 'stale').length, unconfirmed: models.filter(m => m.state === 'unconfirmed').length },
  models, missing: [], diff: null, error: null, ...extra,
});
const mixed = [
  row('a-fresh', { lanes: ['codex-cmp', 'codex-personal'] }),
  row('b-fresh'),
  row('c-stale', { state: 'stale', confirmed_on: '2026-11-01' }),
  row('d-ghost', { provider: null, lanes: ['claude'], source_url: null, confirmed_on: null, state: 'unconfirmed', routable: false }),
];
const counts = () => within(screen.getByLabelText('Model counts')).getAllByRole('definition').map(dd => `${dd.textContent} ${dd.nextSibling?.textContent}`);
const items = () => within(screen.getByRole('list', { name: 'Models the router can pick' })).getAllByRole('listitem').map(li => li.textContent);

let viewport: ViewportMock | null = null;
beforeEach(() => evictAll());
afterEach(() => { cleanup(); viewport?.restore(); viewport = null; vi.unstubAllGlobals(); });

describe.each([['desktop width', 1440], ['390 px', 390]])('Models card at %s', (_name, width) => {
  const show = (body: unknown) => { viewport = mockViewport(width); stubSurfaceFetch({ routes: { [`${PATH}/check`]: body } }); render(<ModelsCard />); };

  it('shows the three counts with the list underneath, what needs attention first', async () => {
    show(report(mixed));
    await screen.findByRole('list', { name: 'Models the router can pick' });
    expect(counts()).toEqual(['2 Confirmed', '1 Stale', '1 Unconfirmed']);
    expect(items()).toEqual([
      'd-ghostUnconfirmed · not routableUnknown provider · Lanes: claude · Confirmed: never · Source: none',
      'c-staleStaleopenai · Lanes: unknown · Confirmed: 2026-11-01 · Source: docs.example.test',
      'a-freshConfirmedopenai · Lanes: codex-cmp, codex-personal · Confirmed: 2026-11-17 · Source: docs.example.test',
      'b-freshConfirmedopenai · Lanes: unknown · Confirmed: 2026-11-17 · Source: docs.example.test',
    ]);
    expect(screen.getAllByRole('link', { name: 'docs.example.test' })[0]).toHaveAttribute('href', DOCS);
  });
  it('shows the top line, what provider docs say about each model, and the models missing from the registry', async () => {
    show(report([
      row('a-fresh', { docs: 'confirmed' }),
      row('b-aging', { docs: 'deprecated', replacement: 'a-fresh' }),
      row('c-gone', { docs: 'retired', replacement: 'a-fresh', routable: false }),
      row('d-ghost', { docs: 'unconfirmed', routable: false }),
    ], { docs: 'ok', summary: "1 model we route to is not in any provider's docs; 1 new model shipped and is missing.",
      missing: [{ provider: 'openai', id: 'e-new', status: 'current', replacement: null, source_url: DOCS, seen_at: '2026-11-17T08:00:00Z' }] }));
    expect(await screen.findByText("1 model we route to is not in any provider's docs; 1 new model shipped and is missing.")).toBeInTheDocument();
    expect(items().map(text => text!.replace(/openai.*Source: docs\.example\.test/, ''))).toEqual([
      'c-goneRetired in docs · not routable · Use: a-fresh',
      'd-ghostNot in docs · not routable',
      'b-agingDeprecated in docs · Use: a-fresh',
      'a-freshConfirmed',
    ]);
    expect(within(screen.getByRole('list', { name: 'Models missing from the registry' })).getAllByRole('listitem').map(li => li.textContent))
      .toEqual(['e-newMissing from the registryopenai · Seen: 2026-11-17 · Source: docs.example.test']);
  });
  it('shows an all-confirmed registry and an empty one', async () => {
    show(report([row('a-fresh')], { ok: true }));
    await screen.findByRole('list', { name: 'Models the router can pick' });
    expect(counts()).toEqual(['1 Confirmed', '0 Stale', '0 Unconfirmed']);
    cleanup(); evictAll();
    show(report([]));
    expect(await screen.findByText('No models are registered yet.')).toBeInTheDocument();
    expect(screen.getByText('Provider docs are unknown.')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Models missing from the registry' })).toBeNull();
  });
  it('says unknown, never zero, when the registry is missing or the answer has another shape', async () => {
    const error = 'The model registry could not be read, so every model is unknown and none is routable.';
    show(report([], { registry: 'unknown', error }));
    expect(await screen.findByText(`Model check is unknown. ${error}`)).toBeInTheDocument();
    expect(screen.queryByLabelText('Model counts')).toBeNull();
    cleanup(); evictAll();
    show({ schema: 'models.check.v2', models: [] });
    expect(await screen.findByText('Model check is unknown: it could not be loaded.')).toBeInTheDocument();
  });
});

it('sits above the registry table in the Models pane', async () => {
  stubSurfaceFetch({ routes: { [`${PATH}/check`]: report(mixed), [PATH]: { schema: 'models.registry.v1', entries: [] } } });
  render(<ModelsPane />);
  expect(await screen.findByLabelText('Model counts')).toBeInTheDocument();
  expect(screen.getAllByRole('heading', { level: 3 }).map(h => h.textContent)).toEqual(['Model check', 'Models']);
});

it('lays out without sideways scroll at 390 px: wrapping counts, a stacked list, no fixed widths', () => {
  // jsdom has no layout engine: assert the rules the 390 px layout depends on.
  const css = readFileSync(resolve(process.cwd(), 'src/web-ui/routes/verse/models/models.module.css'), 'utf8');
  const card = css.slice(css.indexOf('/* Models card'));
  expect(card).toMatch(/\.counts \{[^}]*flex-wrap: wrap/);
  expect(card).toMatch(/\.checkList li \{[^}]*flex-direction: column[^}]*min-width: 0[^}]*overflow-wrap: anywhere/);
  expect(card).not.toMatch(/(?:^|[^-])(?:min-)?width:\s*\d+(?:px|rem)/);
});
