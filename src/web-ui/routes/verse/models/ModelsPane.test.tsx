/** Render tests for the Models board: provider groups, each model's facts from the three reads, the filter, and the verify action. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelCheckReport, ModelCheckRow } from '../../../../core/fleet/model-check.js';
import type { ModelRegistryRow } from '../../../../core/fleet/model-verify.js';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { getPane } from '../panes/pane-registry.js';
import { REGISTERED_DOCK_PANE_GROUPS } from '../shell/dock-pane-catalog.js';
import { mockViewport, type ViewportMock } from '../shell/viewport.test-support.js';
import { ModelsPane } from './ModelsPane.js';
import './models.pane.js';

const PATH = '/api/verse/fleet/control/models';
const CHECK = `${PATH}/check`;
const LANES = '/api/verse/fleet/runs/lane-models';
const DOCS = 'https://docs.example.test/models';
const NOW = Date.parse('2026-11-18T12:00:00Z');
const reply = (body: object, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const entry = (id: string, extra: Partial<ModelRegistryRow> = {}): ModelRegistryRow => ({
  id, provider: 'openai', lanes: [], verified: true, status: 'verified', source_url: DOCS, verified_on: '2026-11-05', unverified: false, stale: false, reason: null, ...extra,
});
const blocked = { verified: false, unverified: true, source_url: null, verified_on: null } as const;
const entries = [
  entry('a-stale', { stale: true, verified_on: '2026-10-01', reason: 'Verified over 30 days ago. Check the docs again.' }),
  entry('b-unknown', { ...blocked, status: 'unverified', reason: 'Not confirmed by official docs. The router will not use it.' }),
  entry('fresh', { lanes: ['codex-cmp', 'codex-personal'] }),
  entry('opus', { provider: 'anthropic', lanes: ['claude'] }),
  entry('z-retired', { ...blocked, status: 'retired', source_url: DOCS, verified_on: '2026-09-01' }),
];
const list = (rows: ModelRegistryRow[]) => ({ schema: 'models.registry.v1', entries: rows });
const checked = (id: string, extra: Partial<ModelCheckRow> = {}): ModelCheckRow => ({
  id, provider: 'openai', lanes: [], source_url: DOCS, confirmed_on: '2026-11-17', state: 'confirmed', routable: true, docs: 'unknown', replacement: null, reason: null, ...extra,
});
const report = (models: ModelCheckRow[], extra: Partial<ModelCheckReport> = {}): ModelCheckReport => ({
  schema: 'models.check.v1', version: 1, summary: 'Provider docs are unknown.', ok: false, registry: 'ok', router_choices: 'ok', docs: 'unknown', docs_as_of: null, stale_after_days: 14,
  counts: { confirmed: models.filter(m => m.state === 'confirmed').length, stale: models.filter(m => m.state === 'stale').length, unconfirmed: models.filter(m => m.state === 'unconfirmed').length },
  models, missing: [], diff: null, error: null, ...extra,
});
const checks = [
  checked('a-stale', { state: 'stale', confirmed_on: '2026-10-01', reason: 'Confirmed over 14 days ago. Check the docs again.' }),
  checked('b-unknown', { state: 'unconfirmed', routable: false, source_url: null, confirmed_on: null, reason: 'Not confirmed by official docs. The router will not use it.' }),
  checked('fresh', { lanes: ['codex-cmp', 'codex-personal'] }),
  checked('opus', { provider: 'anthropic', lanes: ['claude'] }),
  checked('d-ghost', { provider: null, lanes: ['grok'], state: 'unconfirmed', routable: false, source_url: null, confirmed_on: null, reason: 'Not in the registry. The router will not use it.' }),
];
const laneTable = {
  v: 1, generatedAt: '2026-11-18T12:00:00Z', source: 'ok', reason: null, launches: 12,
  lanes: [
    { lane: 'claude', family: 'claude', mismatch: false, tiers: [{ tier: 'high', model: 'opus', via: null }, { tier: 'medium', model: 'opus', via: null }], lastLaunch: { lane: 'claude', tier: 'high', model: 'opus', at: '2026-11-18T11:56:00Z' } },
    { lane: 'codex-cmp', family: 'codex', mismatch: false, tiers: [{ tier: 'high', model: 'fresh', via: null }], lastLaunch: null },
  ],
};
/** Everything live: registry, check and lane table. */
const full = { [PATH]: list(entries), [CHECK]: report(checks), [LANES]: laneTable };
/** The registry alone: the check has another shape and the lane table is not in this build. */
const registryOnly = (rows: ModelRegistryRow[]) => ({ [PATH]: list(rows), [CHECK]: { schema: 'models.check.v2' }, [LANES]: null });

const group = (name: string) => screen.getByRole('region', { name: `${name} models` });
const ids = (name: string) => within(group(name)).getAllByRole('listitem').map(li => li.getAttribute('aria-label'));
const model = (id: string) => screen.getByRole('listitem', { name: `${id} model` });
const facts = (id: string) => Object.fromEntries(within(model(id)).getAllByRole('term').map(dt => [dt.textContent, dt.nextElementSibling?.textContent]));

let viewport: ViewportMock | null = null;
beforeEach(() => { evictAll(); setMutationToken('tok'); vi.useFakeTimers({ toFake: ['Date'], now: NOW }); });
afterEach(() => { cleanup(); clearMutationToken(); viewport?.restore(); viewport = null; vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('ModelsPane', () => {
  it('registers as a Fleet pane that needs no session', () => {
    expect(getPane('models')).toMatchObject({ title: 'Models', needsSession: false });
    expect(REGISTERED_DOCK_PANE_GROUPS.models).toBe('fleet');
  });

  it('shows the empty state with the one command that adds a model', async () => {
    stubSurfaceFetch({ routes: { ...full, [PATH]: list([]), [CHECK]: report([]) } });
    render(<ModelsPane />);
    expect(await screen.findByText(/No models are registered yet\. Add one with: phm models verify <id> --provider <name> --source/)).toBeInTheDocument();
    expect(screen.getByText('Provider docs are unknown.')).toBeInTheDocument();
    expect(screen.queryByRole('radiogroup')).toBeNull();
    expect(screen.queryByRole('region', { name: 'Models missing from the registry' })).toBeNull();
  });

  it('says the state is unknown, never zero, when no read can be loaded', async () => {
    stubSurfaceFetch({ routes: { [PATH]: { entries: [] }, [LANES]: null } });
    render(<ModelsPane />);
    expect(await screen.findByText('Could not read the model registry, so its state is unknown.')).toBeInTheDocument();
    expect(await screen.findByText('Model check is unknown: it could not be loaded.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Model counts')).toBeNull();
    expect(screen.queryByText(/No models are registered/)).toBeNull();
  });
});

describe.each([['desktop width', 1440], ['390 px', 390]])('Models board at %s', (_name, width) => {
  const show = (routes: Record<string, unknown>) => { viewport = mockViewport(width); const stub = stubSurfaceFetch({ routes }); render(<ModelsPane />); return stub; };

  it('groups every model under its provider mark, what needs attention first', async () => {
    show(full);
    await screen.findByRole('region', { name: 'OpenAI models' });
    expect(screen.getByText('Provider docs are unknown.')).toBeInTheDocument();
    expect(within(screen.getByLabelText('Model counts')).getAllByRole('definition').map(dd => `${dd.textContent} ${dd.nextSibling?.textContent}`)).toEqual(['2 Confirmed', '1 Stale', '2 Unconfirmed']);
    expect(screen.getAllByRole('heading', { level: 3 }).map(h => h.textContent)).toEqual(['Anthropic', 'OpenAI', 'Unknown provider']);
    expect(ids('Anthropic')).toEqual(['opus model']);
    expect(ids('OpenAI')).toEqual(['b-unknown model', 'a-stale model', 'fresh model', 'z-retired model']);
    expect(ids('Unknown provider')).toEqual(['d-ghost model']);
    expect(group('Anthropic').querySelector('svg[data-provider="claude"]')).not.toBeNull();
    expect(group('OpenAI').querySelector('svg[data-provider="codex"]')).not.toBeNull();
    expect(group('Unknown provider').querySelector('svg[data-provider="unknown"]')).not.toBeNull();
    expect(within(group('OpenAI')).getByText('4 models, 2 routable')).toBeInTheDocument();
  });

  it('gives each model its state, the reason, its lanes with tiers, last launch, confirmation and source', async () => {
    show(full);
    await screen.findByRole('region', { name: 'OpenAI models' });
    expect(model('opus')).toHaveAttribute('data-tone', 'ok');
    expect(within(model('opus')).getByText('Confirmed', { selector: 'span' })).toBeInTheDocument();
    expect(facts('opus')).toEqual({ Lanes: 'claude (high, medium)', 'Last launch': 'claude high, 4m ago', Confirmed: '2026-11-17', Source: 'docs.example.test' });
    expect(facts('fresh')).toEqual({ Lanes: 'codex-cmp (high), codex-personal', 'Last launch': 'not the latest on any lane', Confirmed: '2026-11-17', Source: 'docs.example.test' });
    expect(model('b-unknown')).toHaveAttribute('data-tone', 'bad');
    expect(within(model('b-unknown')).getByText('Unconfirmed · not routable')).toBeInTheDocument();
    expect(within(model('b-unknown')).getByText('Not confirmed by official docs. The router will not use it.')).toBeInTheDocument();
    expect(facts('b-unknown')).toMatchObject({ Lanes: 'unknown', Confirmed: 'never', Source: 'none' });
    expect(model('a-stale')).toHaveAttribute('data-tone', 'warn');
    expect(within(model('z-retired')).getByText('Retired')).toBeInTheDocument();
    expect(facts('d-ghost')).toMatchObject({ Lanes: 'grok', Confirmed: 'never', Source: 'none' });
    expect(within(model('opus')).getByRole('link', { name: 'docs.example.test' })).toHaveAttribute('href', DOCS);
    expect(screen.getAllByRole('button').map(button => button.getAttribute('aria-label'))).toEqual(['Check again: opus', 'Verify: b-unknown', 'Check again: a-stale', 'Check again: fresh']);
    expect(screen.getByRole('button', { name: 'Verify: b-unknown' })).toBeDisabled();
  });

  it('shows what provider docs say about each model and the models missing from the registry', async () => {
    show({ ...full, [PATH]: list([entry('a-fresh'), entry('b-aging'), entry('c-gone'), entry('d-ghost')]), [CHECK]: report([
      checked('a-fresh', { docs: 'confirmed' }),
      checked('b-aging', { docs: 'deprecated', replacement: 'a-fresh' }),
      checked('c-gone', { docs: 'retired', replacement: 'a-fresh', routable: false }),
      checked('d-ghost', { docs: 'unconfirmed', routable: false }),
    ], { docs: 'ok', docs_as_of: '2026-11-17T08:00:00Z', summary: "1 model we route to is not in any provider's docs; 1 new model shipped and is missing.",
      missing: [{ provider: 'openai', id: 'e-new', status: 'current', replacement: null, source_url: DOCS, seen_at: '2026-11-17T08:00:00Z' }] }) });
    expect(await screen.findByText("1 model we route to is not in any provider's docs; 1 new model shipped and is missing.")).toBeInTheDocument();
    expect(screen.getByText(/Provider docs list as of 2026-11-17\./)).toBeInTheDocument();
    expect(ids('OpenAI')).toEqual(['c-gone model', 'd-ghost model', 'b-aging model', 'a-fresh model']);
    expect(within(model('c-gone')).getByText('Retired in docs · not routable')).toBeInTheDocument();
    expect(within(model('d-ghost')).getByText('Not in docs · not routable')).toBeInTheDocument();
    expect(within(model('b-aging')).getByText('Deprecated in docs')).toBeInTheDocument();
    expect(facts('b-aging')['Use instead']).toBe('a-fresh');
    expect(facts('a-fresh')['Use instead']).toBeUndefined();
    const missing = screen.getByRole('region', { name: 'Models missing from the registry' });
    expect(within(missing).getAllByRole('listitem').map(li => li.textContent)).toEqual(['e-newOpenAI · Seen: 2026-11-17 · Source: docs.example.test']);
  });

  it('narrows to what needs attention or what is routable, and says so when a filter is empty', async () => {
    show(full);
    const options = () => within(screen.getByRole('radiogroup', { name: 'Show models' })).getAllByRole('radio').map(radio => radio.textContent);
    await screen.findByRole('region', { name: 'OpenAI models' });
    expect(options()).toEqual(['All 6', 'Needs attention 3', 'Routable 3']);
    fireEvent.click(screen.getByRole('radio', { name: 'Needs attention 3' }));
    expect(screen.queryByRole('region', { name: 'Anthropic models' })).toBeNull();
    expect(ids('OpenAI')).toEqual(['b-unknown model', 'a-stale model']);
    expect(ids('Unknown provider')).toEqual(['d-ghost model']);
    fireEvent.click(screen.getByRole('radio', { name: 'Routable 3' }));
    expect(ids('OpenAI')).toEqual(['a-stale model', 'fresh model']);
    cleanup(); evictAll();
    show({ ...full, [PATH]: list([entry('fresh')]), [CHECK]: report([checked('fresh')]) });
    fireEvent.click(await screen.findByRole('radio', { name: 'Needs attention 0' }));
    expect(screen.getByText('No model needs attention.')).toBeInTheDocument();
  });

  it('keeps the registry on screen with routing unknown when the check or the lane table cannot be read', async () => {
    show(registryOnly(entries));
    await screen.findByRole('region', { name: 'OpenAI models' });
    expect(screen.getByText('Model check is unknown: it could not be loaded.')).toBeInTheDocument();
    expect(screen.getByText('5 models in the registry.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Model counts')).toBeNull();
    expect(within(model('fresh')).getByText('Verified · routing unknown')).toBeInTheDocument();
    expect(model('fresh')).toHaveAttribute('data-tone', 'unknown');
    expect(within(group('OpenAI')).getByText('4 models, routing unknown')).toBeInTheDocument();
    expect(facts('fresh')).toEqual({ Lanes: 'codex-cmp, codex-personal', 'Last launch': 'unknown', Confirmed: '2026-11-05', Source: 'docs.example.test' });
    expect(within(model('a-stale')).getByText('Stale (verified over 30 days ago) · routing unknown')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Routable 0' })).toBeInTheDocument();
    cleanup(); evictAll();
    const error = 'The model registry could not be read, so every model is unknown and none is routable.';
    show({ ...full, [CHECK]: report([], { registry: 'unknown', error }), [LANES]: { ...laneTable, source: 'unavailable', reason: 'Lane model table unavailable', lanes: [] } });
    expect(await screen.findByText(`Model check is unknown. ${error}`)).toBeInTheDocument();
    expect(screen.getByText('Lane model table unavailable, so which tier picks each model is unknown.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Model counts')).toBeNull();
  });
});

describe('Models board actions', () => {
  it('Verify posts the id and the trimmed doc URL', async () => {
    const stub = stubSurfaceFetch({ routes: full, post: () => reply(entry('b-unknown')) });
    render(<ModelsPane />);
    fireEvent.change(await screen.findByLabelText('Official doc URL for b-unknown'), { target: { value: ` ${DOCS} ` } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify: b-unknown' }));
    expect(await within(model('b-unknown')).findByRole('status')).toHaveTextContent('Confirmed by the docs today.');
    expect(stub.posted).toEqual([{ url: `${PATH}/verify`, body: { id: 'b-unknown', source: DOCS } }]);
  });

  it('Check again reuses the recorded source in one click and shows the server refusal as written', async () => {
    const refusal = `${DOCS} does not mention a-stale, so it stays as it was.`;
    const stub = stubSurfaceFetch({ routes: full, post: () => reply({ error: refusal }, 422) });
    render(<ModelsPane />);
    fireEvent.click(await screen.findByRole('button', { name: 'Check again: a-stale' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(refusal);
    expect(stub.posted).toEqual([{ url: `${PATH}/verify`, body: { id: 'a-stale', source: DOCS } }]);
  });

  it('says actions are locked without the mutation token', async () => {
    clearMutationToken();
    stubSurfaceFetch({ routes: full });
    render(<ModelsPane />);
    fireEvent.click(await screen.findByRole('button', { name: 'Check again: fresh' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Unlock actions/);
  });

  it('offers no action for a retired model or one the registry lacks', async () => {
    stubSurfaceFetch({ routes: full });
    render(<ModelsPane />);
    await screen.findByRole('region', { name: 'OpenAI models' });
    expect(within(model('z-retired')).queryByRole('button')).toBeNull();
    expect(within(model('d-ghost')).queryByRole('button')).toBeNull();
    expect(within(model('d-ghost')).queryByRole('textbox')).toBeNull();
  });
});

it('lays out without sideways scroll at 390 px: wrapping heads and counts, auto-fit facts, no fixed widths', () => {
  // jsdom has no layout engine: assert the rules the 390 px layout depends on.
  const css = readFileSync(resolve(process.cwd(), 'src/web-ui/routes/verse/models/models.module.css'), 'utf8');
  expect(css).toMatch(/\.root \{[^}]*min-width: 0[^}]*overflow-wrap: anywhere/);
  expect(css).toMatch(/\.counts \{[^}]*flex-wrap: wrap/);
  expect(css).toMatch(/\.head \{[^}]*flex-wrap: wrap/);
  expect(css).toMatch(/\.verify \{[^}]*flex-wrap: wrap/);
  expect(css).toMatch(/\.facts \{[^}]*repeat\(auto-fit, minmax\(8rem, 1fr\)\)/);
  expect(css).not.toMatch(/(?:^|[^-])min-width:\s*\d+(?:px|rem)/m);
  expect(css).not.toMatch(/[;{]\s*width:\s*\d+(?:px|rem)/);
});
