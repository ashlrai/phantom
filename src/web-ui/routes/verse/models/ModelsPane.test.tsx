import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelRegistryRow } from '../../../../core/fleet/model-verify.js';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { getPane } from '../panes/pane-registry.js';
import { REGISTERED_DOCK_PANE_GROUPS } from '../shell/dock-pane-catalog.js';
import { ModelsPane } from './ModelsPane.js';
import './models.pane.js';

const PATH = '/api/verse/fleet/control/models';
const DOCS = 'https://docs.example.test/models';
const reply = (body: object, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const row = (id: string, extra: Partial<ModelRegistryRow> = {}): ModelRegistryRow => ({
  id, provider: 'openai', lanes: [], verified: true, status: 'verified', source_url: DOCS, verified_on: '2026-11-05', unverified: false, stale: false, reason: null, ...extra,
});
const blocked = { verified: false, unverified: true, source_url: null, verified_on: null } as const;
const rows = [
  row('a-stale', { stale: true, verified_on: '2026-10-01' }),
  row('b-unknown', { ...blocked, status: 'unverified' }),
  row('fresh', { lanes: ['codex-cmp', 'codex-personal'] }),
  row('z-retired', { ...blocked, status: 'retired', source_url: DOCS, verified_on: '2026-09-01' }),
];
const list = (entries: ModelRegistryRow[]) => ({ schema: 'models.registry.v1', entries });
const cells = (id: string) => within(screen.getByRole('rowheader', { name: id }).closest('tr')!).getAllByRole('cell').map(cell => cell.textContent);

beforeEach(() => { evictAll(); setMutationToken('tok'); });
afterEach(() => { clearMutationToken(); vi.unstubAllGlobals(); });

describe('ModelsPane', () => {
  it('registers as a Fleet pane that needs no session', () => {
    expect(getPane('models')).toMatchObject({ title: 'Models', needsSession: false });
    expect(REGISTERED_DOCK_PANE_GROUPS.models).toBe('fleet');
  });

  it('shows the empty state with the one command that adds a model', async () => {
    stubSurfaceFetch({ routes: { [PATH]: list([]) } });
    render(<ModelsPane />);
    expect(await screen.findByText(/No models are registered yet\. Add one with: phm models verify <id> --provider <name> --source/)).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('says the state is unknown when the registry cannot be read or has another shape', async () => {
    stubSurfaceFetch({ routes: { [PATH]: { entries: [] } } });
    render(<ModelsPane />);
    expect(await screen.findByText('Could not read the model registry, so its state is unknown.')).toBeInTheDocument();
  });

  it('renders one table with every field, unknown as Unknown, and one action per row', async () => {
    stubSurfaceFetch({ routes: { [PATH]: list(rows) } });
    render(<ModelsPane />);
    await screen.findByRole('table');
    expect(screen.getAllByRole('columnheader').map(th => th.textContent)).toEqual(['Model', 'Provider', 'Lanes', 'Status', 'Verified on', 'Source', 'Action']);
    expect(cells('a-stale')).toEqual(['openai', 'Unknown', 'Stale (verified over 30 days ago)', '2026-10-01', 'docs.example.test', 'Check again']);
    expect(cells('fresh').slice(0, 4)).toEqual(['openai', 'codex-cmp, codex-personal', 'Verified', '2026-11-05']);
    expect(cells('b-unknown').slice(0, 4)).toEqual(['openai', 'Unknown', 'Unverified', 'Unknown']);
    expect(cells('z-retired')).toEqual(['openai', 'Unknown', 'Retired', '2026-09-01', 'docs.example.test', '']);
    expect(screen.getAllByRole('button').map(button => button.getAttribute('aria-label'))).toEqual(['Check again: a-stale', 'Verify: b-unknown', 'Check again: fresh']);
    expect(screen.getByRole('button', { name: 'Verify: b-unknown' })).toBeDisabled();
    expect(screen.getAllByRole('link', { name: 'docs.example.test' })[0]).toHaveAttribute('href', DOCS);
  });

  it('Verify posts the id and the typed doc URL, then confirms', async () => {
    const stub = stubSurfaceFetch({ routes: { [PATH]: list(rows) }, post: () => reply(row('b-unknown')) });
    render(<ModelsPane />);
    fireEvent.change(await screen.findByLabelText('Official doc URL for b-unknown'), { target: { value: ` ${DOCS} ` } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify: b-unknown' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Confirmed by the docs today.');
    expect(stub.posted).toEqual([{ url: `${PATH}/verify`, body: { id: 'b-unknown', source: DOCS } }]);
  });

  it('Check again reuses the recorded source in one click and shows the server refusal as written', async () => {
    const refusal = `${DOCS} does not mention a-stale, so it stays as it was.`;
    const stub = stubSurfaceFetch({ routes: { [PATH]: list(rows) }, post: () => reply({ error: refusal }, 422) });
    render(<ModelsPane />);
    fireEvent.click(await screen.findByRole('button', { name: 'Check again: a-stale' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(refusal);
    expect(stub.posted).toEqual([{ url: `${PATH}/verify`, body: { id: 'a-stale', source: DOCS } }]);
  });

  it('says actions are locked without the mutation token', async () => {
    clearMutationToken();
    stubSurfaceFetch({ routes: { [PATH]: list(rows) } });
    render(<ModelsPane />);
    fireEvent.click(await screen.findByRole('button', { name: 'Check again: fresh' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Unlock actions/);
  });
});
