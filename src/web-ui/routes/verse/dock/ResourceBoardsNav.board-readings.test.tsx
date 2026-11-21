/**
 * dock/ResourceBoardsNav.board-readings.test.tsx — the readings beside Router, Models, Capacity and Supply, which
 * make every name on the row able to say where to look: counted by each board's own model from the read that board
 * draws from, absent when there is nothing worth a word or the read failed, and never asked for a board the row
 * does not list.
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelCheckReport, ModelCheckRow } from '../../../../core/fleet/model-check.js';
import type { ModelRegistryRow } from '../../../../core/fleet/model-verify.js';
import type { RunsHistory } from '../../../../core/fleet/runs-history.js';
import type { SeatDecision } from '../../../../core/routing/types.js';
import { evictAll } from '../../../data/cache.js';
import { ROUTER_DIFFICULTIES, ROUTER_TASKS, type BudgetRoute } from '../fleet-router/router-model.js';
import type { FleetRuns } from '../ops/ops-runs-model.js';
import { registerPane, resetPaneRegistry } from '../panes/pane-registry.js';
import { ResourceBoardsNav } from './ResourceBoardsNav.js';
import { TasksGlyph } from './dock-icons.js';
import { capacityReading, modelsReading, routerReading, supplyReading } from './resource-board-readings.js';

const NOW = Date.parse('2026-11-17T12:00:00.000Z');
const at = (hours: number) => new Date(NOW + hours * 3_600_000).toISOString();

// Router: the answer for one kind of work, as GET /api/verse/budget/preview gives it.
const decision = (seatId: string | null): SeatDecision => ({
  seatId, candidates: seatId === null ? [] : [seatId, 'codex-cmp'], mode: 'balanced', why: '', summary: '', exclusions: [],
} as unknown as SeatDecision);
const table = (cell: (task: string, difficulty: string) => SeatDecision | null = () => decision('claude')): { routes: BudgetRoute[] } => ({
  routes: ROUTER_TASKS.flatMap(task => ROUTER_DIFFICULTIES.flatMap((difficulty): BudgetRoute[] => {
    const answer = cell(task.value, difficulty.value);
    return answer ? [{ task: task.value, difficulty: difficulty.value, decision: answer }] : [];
  })),
});
const NO_HIGH = (_task: string, difficulty: string) => decision(difficulty === 'high' && _task !== 'code' && _task !== 'review' && _task !== 'plan' ? null : 'claude');

// Models: the registry (`phm models`) and the check (`phm models check`).
const DOCS = 'https://docs.example.test/models';
const entry = (id: string, extra: Partial<ModelRegistryRow> = {}): ModelRegistryRow => ({
  id, provider: 'openai', lanes: [], verified: true, status: 'verified', source_url: DOCS, verified_on: '2026-11-05', unverified: false, stale: false, reason: null, ...extra,
});
const REFUSED = { verified: false, unverified: true, source_url: null, verified_on: null } as const;
const STALE_ENTRY = entry('a-stale', { stale: true });
const UNVERIFIED_ENTRY = entry('b-unknown', { ...REFUSED, status: 'unverified' });
const RETIRED_ENTRY = entry('z-retired', { ...REFUSED, status: 'retired' });
const checked = (id: string, extra: Partial<ModelCheckRow> = {}): ModelCheckRow => ({
  id, provider: 'openai', lanes: [], source_url: DOCS, confirmed_on: '2026-11-17', state: 'confirmed', routable: true, docs: 'unknown', replacement: null, reason: null, ...extra,
});
const report = (models: ModelCheckRow[]): ModelCheckReport => ({
  schema: 'models.check.v1', version: 1, summary: '1 model is not routable.', ok: false, registry: 'ok', router_choices: 'ok', docs: 'unknown', docs_as_of: null, stale_after_days: 14,
  counts: { confirmed: 0, stale: 0, unconfirmed: 0 }, models, missing: [], diff: null, error: null,
});
const STALE_CHECK = checked('a-stale', { state: 'stale' });
const UNROUTABLE_CHECK = checked('b-unknown', { state: 'unconfirmed', routable: false });
const registryBody = (...rows: ModelRegistryRow[]) => ({ schema: 'models.registry.v1', entries: rows });

// Capacity: GET /api/verse/runs-history samples.
const sample = (hours: number, ...lanes: Array<[string, number, number]>) => ({
  at: at(hours), workers: null, leaders: null, paused: null,
  lanes: lanes.map(([lane, running, target]) => ({ lane, running, target, queued: 0, held: false })),
});
const history = (...samples: RunsHistory['samples']): RunsHistory => ({ v: 1, generatedAt: at(0), from: at(-24), to: at(0), sourceState: 'healthy', dropped: 0, samples });
const DAY = history(sample(-2, ['claude', 3, 4], ['codex', 2, 2]), sample(-1, ['claude', 3, 4], ['codex', 2, 2]));

// Supply: the GET /api/verse/fleet/runs snapshot, with and without a readable drop folder.
const lane = (name: string, running: number, target: number, held = false): FleetRuns['lanes'][number] =>
  ({ lane: name, running, target, queued: 0, held, heldReason: held ? 'quota' : null, tokensLastHour: null, merged24h: null, mergeRate24h: null });
const runs = (drop: FleetRuns['drop'], ...lanes: FleetRuns['lanes']): FleetRuns => ({
  v: 1, generatedAt: at(0), sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
  lastTick: at(0), paused: false, memFreePct: null, diskFreeGb: null, switches: [], claudeLane: null, lanes,
  workers: [], leaders: [], orchestratorAgents: null, publishesLastHour: [], mergesLastHour: { count: null, items: [] }, events: [],
  codexPersonal: null, inbox: [], drop,
});
const EMPTY_DROP = { pending: [], done: 0 };

const BOARDS = ['fleet-pools:Pools', 'fleet-usage:Usage', 'fleet-router:Router', 'models:Models', 'fleet-lanes:Lanes', 'fleet-capacity:Capacity', 'fleet-supply:Supply'] as const;
let disposers: Array<() => void> = [];
function register(...entries: readonly string[]) {
  disposers.push(...entries.map((item) => {
    const [id, title] = item.split(':') as [string, string];
    return registerPane({ id, title, icon: TasksGlyph, component: () => null, needsSession: false });
  }));
}

type Routes = { preview?: (task: string, difficulty: string) => SeatDecision | null; registry?: unknown; check?: unknown; history?: unknown; runs?: unknown };
/** Answers only the routes given; everything else is a server that is down. */
function serve(routes: Routes) {
  const down = () => Response.json({ error: 'down' }, { status: 500 });
  const fetchMock = vi.fn(async (input: string) => {
    const url = String(input);
    if (url.includes('/api/verse/budget/preview') && routes.preview) {
      const query = new URL(url, 'http://localhost').searchParams;
      const answer = routes.preview(query.get('task') ?? '', query.get('difficulty') ?? '');
      return answer ? Response.json(answer) : down();
    }
    if (url.includes('/api/verse/fleet/control/models/check')) return routes.check === undefined ? down() : Response.json(routes.check);
    if (url.includes('/api/verse/fleet/control/models')) return routes.registry === undefined ? down() : Response.json(routes.registry);
    if (url.includes('/api/verse/runs-history')) return routes.history === undefined ? down() : Response.json(routes.history);
    if (url.includes('/api/verse/fleet/runs')) return routes.runs === undefined ? down() : Response.json(routes.runs);
    return down();
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
const asked = (fetchMock: { mock: { calls: unknown[][] } }, part: string): string[] => fetchMock.mock.calls.map(([url]) => String(url)).filter(url => url.includes(part));
const button = (name: string | RegExp) => within(screen.getByRole('navigation', { name: 'Resource boards' })).getByRole('button', { name });

beforeEach(() => {
  evictAll();
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  resetPaneRegistry();
  disposers = [];
});
afterEach(() => {
  cleanup();
  for (const dispose of disposers) dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Router, Models, Capacity and Supply readings', () => {
  it('counts kinds of work no seat can take, else kinds the router did not answer', () => {
    expect(routerReading(table(NO_HIGH))).toEqual({ text: '2 no seat', tone: 'attention', detail: '2 of 15 kinds of fleet work have no seat that can take them right now.' });
    // A cell with no answer is unknown, and is not counted as work without a seat.
    expect(routerReading(table((task, difficulty) => task === 'bulk' && difficulty === 'low' ? null : decision('claude'))))
      .toEqual({ text: '1 unknown', tone: 'quiet', detail: '1 of 15 kinds of work got no answer from the router.' });
    expect(routerReading(table())).toBeNull();
  });

  it('counts models the router refuses, else models to review, and leaves retired ones out', () => {
    const both = { registry: [STALE_ENTRY, UNVERIFIED_ENTRY, entry('fresh'), RETIRED_ENTRY], check: report([STALE_CHECK, UNROUTABLE_CHECK, checked('fresh')]) };
    expect(modelsReading(both)).toEqual({ text: '1 not routable', tone: 'attention', detail: '1 model is not routable.' });
    expect(modelsReading({ registry: [STALE_ENTRY, entry('fresh')], check: report([STALE_CHECK, checked('fresh')]) })?.text).toBe('1 to review');
    expect(modelsReading({ registry: [entry('fresh'), RETIRED_ENTRY], check: report([checked('fresh')]) })).toBeNull();
  });

  it('reads the registry alone when the check is missing, and says nothing when neither answered', () => {
    expect(modelsReading({ registry: [STALE_ENTRY, UNVERIFIED_ENTRY, RETIRED_ENTRY], check: null }))
      .toEqual({ text: '1 not routable', tone: 'attention', detail: '3 models in the registry.' });
    expect(modelsReading({ registry: [STALE_ENTRY, entry('fresh')], check: null })).toEqual({ text: '1 to review', tone: 'quiet', detail: '2 models in the registry.' });
    expect(modelsReading({ registry: null, check: null })).toBeNull();
  });

  it('gives the share of target slots filled, and nothing for a window nobody sampled', () => {
    expect(capacityReading(DAY, NOW)).toEqual({ text: '83.3% filled', tone: 'quiet', detail: 'Lanes filled 83.3% of their target slots.' });
    expect(capacityReading(history(), NOW)).toBeNull();
    // Lanes with no target have no share to state: not 0%.
    expect(capacityReading(history(sample(-1, ['claude', 0, 0])), NOW)).toBeNull();
  });

  it('counts opening slots with no job waiting, as an upper bound when the drop folder is unread', () => {
    expect(supplyReading(runs(EMPTY_DROP, lane('claude', 3, 4), lane('codex', 2, 2))))
      .toEqual({ text: '1 short', tone: 'attention', detail: 'Write 1 more job files · Shortfall 1 slots.' });
    expect(supplyReading(runs(null, lane('claude', 3, 4))))
      .toEqual({ text: 'up to 1 short', tone: 'attention', detail: 'Write up to 1 more job files · Shortfall up to 1 slots.' });
    expect(supplyReading(runs({ pending: [{ lane: 'claude', file: 'job.md' }], done: 0 }, lane('claude', 3, 4)))).toBeNull();
    // A held lane's open slots are not a shortfall.
    expect(supplyReading(runs(EMPTY_DROP, lane('claude', 0, 4, true)))).toBeNull();
  });

  it('draws a reading beside every name whose board has one, from the reads the boards use', async () => {
    register(...BOARDS);
    const fetchMock = serve({
      preview: NO_HIGH, registry: registryBody(STALE_ENTRY, UNVERIFIED_ENTRY), check: report([STALE_CHECK, UNROUTABLE_CHECK]),
      history: DAY, runs: runs(EMPTY_DROP, lane('claude', 3, 4), lane('codex', 2, 2)),
    });
    render(<ResourceBoardsNav current="fleet-pools" visible primary />);
    const router = await waitFor(() => button('Router 2 no seat'));
    expect(within(router).getByText('2 no seat')).toHaveAttribute('data-tone', 'attention');
    expect(router.title).toMatch(/^2 of 15 kinds of fleet work have no seat that can take them right now\. Where work is sent/);
    expect(within(await waitFor(() => button('Models 1 not routable'))).getByText('1 not routable')).toHaveAttribute('data-tone', 'attention');
    expect(within(await waitFor(() => button('Capacity 83.3% filled'))).getByText('83.3% filled')).toHaveAttribute('data-tone', 'quiet');
    expect(button('Supply 1 short').title).toMatch(/^Write 1 more job files · Shortfall 1 slots\. How the lanes are running/);
    // Lanes and Supply are two readings of one snapshot: it is read once.
    expect(button('Lanes 5/6')).toBeInTheDocument();
    expect(asked(fetchMock, '/api/verse/fleet/runs')).toHaveLength(1);
    // The route table is the fleet's, one preview per kind of work.
    const previews = asked(fetchMock, '/api/verse/budget/preview');
    expect(previews).toHaveLength(15);
    expect(previews.every(url => url.includes('autonomous=true'))).toBe(true);
  });

  it('keeps a plain name for a board with nothing to flag and for a board whose read failed', async () => {
    register(...BOARDS);
    const fetchMock = serve({ preview: () => decision('claude'), history: DAY });
    render(<ResourceBoardsNav current="fleet-pools" visible primary />);
    await waitFor(() => button('Capacity 83.3% filled'));
    await waitFor(() => expect(asked(fetchMock, '/api/verse/budget/preview')).toHaveLength(15));
    await waitFor(() => expect(asked(fetchMock, '/api/verse/fleet/control/models')).toHaveLength(2));
    await Promise.resolve();
    for (const name of ['Router', 'Models', 'Supply', 'Lanes']) expect(button(new RegExp(`^${name}`))).toHaveTextContent(new RegExp(`^${name}$`));
  });

  it('asks only for the boards the row lists', async () => {
    register('fleet-pools:Pools', 'fleet-capacity:Capacity');
    const fetchMock = serve({ history: DAY });
    render(<ResourceBoardsNav current="fleet-pools" visible primary />);
    await waitFor(() => button('Capacity 83.3% filled'));
    for (const part of ['/budget/preview', '/fleet/control/models', '/api/verse/fleet/runs', '/api/verse/accounts']) expect(asked(fetchMock, part)).toHaveLength(0);
  });

  it('asks for nothing while the board is behind another tab', async () => {
    register(...BOARDS);
    const fetchMock = serve({ preview: NO_HIGH, history: DAY });
    render(<ResourceBoardsNav current="fleet-pools" visible={false} primary={false} />);
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(button(/^Router/)).toHaveTextContent(/^Router$/);
  });
});
