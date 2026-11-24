import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch, type RouteAnswer } from '../command/fetch-stub.test-support.js';
import { fleetRunsFixture } from '../fleet/fleet-runs-fixtures.test-support.js';
import { msg } from '../leader/thread-fixtures.test-support.js';
import type { LaneTargetsV1 } from '../ops/lane-targets-model.js';
import { LeaderThreadPane } from './LeaderThreadPane.js';

const RUNS_API = '/api/verse/fleet/runs';
const LANES_API = '/api/verse/fleet/control/lanes';

const laneRow = (lane: string, running: number, target: number, held = false, heldReason: string | null = null) =>
  ({ lane, running, target, queued: 0, held, heldReason, tokensLastHour: null, merged24h: null, mergeRate24h: null });
const liveRuns = () => fleetRunsFixture({
  lanes: [laneRow('claude', 1, 4), laneRow('glm', 0, 2, true, 'provider outage')],
  workers: [{ job: 'RQ-LANEJOB', repo: 'ashlrai/phantom', lane: 'claude', tier: 'mid', ageSeconds: 720 }],
});
const target = (lane: string, held: boolean) => ({ lane, target: 4, floor: 0, ceiling: 6, held, heldReason: held ? 'provider outage' : null, heldUntil: null, lastChange: null, changedBy: null });
const lanes: LaneTargetsV1 = { v: 1, generatedAt: '2026-11-20T12:00:00Z', sourceState: 'healthy', lanes: [target('claude', false), target('glm', true)] };

beforeEach(() => { evictAll(); window.localStorage.clear(); clearMutationToken(); });
afterEach(() => { vi.unstubAllGlobals(); });

async function setup(routes: Record<string, RouteAnswer | null> = {}) {
  const net = stubSurfaceFetch({ routes: {
    '/api/verse/leader/thread': { messages: [msg({ id: 'one', text: 'Hello from the Leader.' })] },
    '/api/verse/leader/directives': { directives: [] },
    [LANES_API]: lanes,
    [RUNS_API]: liveRuns(),
    ...routes,
  } });
  render(<LeaderThreadPane visible />);
  await screen.findByText('Hello from the Leader.');
  const input = screen.getByRole('textbox', { name: 'Reply to the Leader' }) as HTMLTextAreaElement;
  const type = (value: string) => fireEvent.change(input, { target: { value, selectionStart: value.length, selectionEnd: value.length } });
  const result = () => document.querySelector('[data-composer-result]');
  return { net, input, type, result };
}

const names = (list: HTMLElement) => within(list).getAllByRole('option').map(option => option.querySelector('strong')!.textContent);

describe('lane commands in the Leader reply box', () => {
  it('/lanes answers in the conversation without a token and writes nothing', async () => {
    const { net, input, type, result } = await setup();
    type('/lanes');
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(result()).toHaveTextContent('Lanes: 1 of 6 slots running, 1 lane held. glm held (provider outage), 0 running · claude 1 of 4.'));
    expect(result()).toHaveTextContent('/lane <lane> names its jobs');
    expect(input).toHaveValue('');
    expect(net.posted).toEqual([]);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('/lane picks the lane from a list, and the job it names opens that conversation', async () => {
    const { net, input, type, result } = await setup();
    type('/lane ');
    const list = await screen.findByRole('listbox', { name: 'Lanes' });
    expect(names(list)).toEqual(['claude', 'glm']);
    expect(within(list).getAllByRole('option')[1]).toHaveTextContent('held');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(input).toHaveValue('/lane claude');

    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(result()).toHaveTextContent(/^claude: 1 of 4 running, 3 open\. Target 4, from 0 to 6\. Running: RQ-LANEJOB \(phantom, mid, 12 min\)\./));
    expect(within(result() as HTMLElement).getByRole('button', { name: 'Open the conversation with RQ-LANEJOB' })).toBeInTheDocument();
    expect(net.posted).toEqual([]);
  });

  it('says the lanes are unknown when the server does not serve the read, never that none is running', async () => {
    const { input, type, result } = await setup({ [RUNS_API]: null });
    type('/lanes');
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(result()).toHaveTextContent('Lanes are unknown: this server does not serve the live runs read.'));
  });

  it('/hold offers lengths of hold with the time each ends once the lane is in, and Enter writes the first', async () => {
    const { net, input, type } = await setup();
    type('/hold ');
    await screen.findByRole('listbox', { name: 'Lanes' });
    fireEvent.keyDown(input, { key: 'Tab' });
    expect(input).toHaveValue('/hold claude ');

    const list = await screen.findByRole('listbox', { name: 'Minutes to hold' });
    expect(names(list)).toEqual(['15 min', '30 min', '1 h', '2 h', '4 h', '24 h']);
    expect(within(list).getAllByRole('option')[0]).toHaveTextContent(/until \d{1,2}:\d{2}/);
    expect(within(list).getAllByRole('option')[5]).toHaveTextContent(/tomorrow$/);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(input).toHaveValue('/hold claude 30');
    // Choosing a length only writes it: the hold is not asked for until the command is sent.
    expect(net.posted).toEqual([]);
  });

  it('shows a typed length with its own end time, and the command’s sentence for one it would refuse', async () => {
    const { type } = await setup();
    type('/hold claude 45');
    expect(names(await screen.findByRole('listbox', { name: 'Minutes to hold' }))).toEqual(['45 min']);
    type('/hold claude 2000');
    expect(await screen.findByText('Minutes must be a whole number from 1 to 1440.')).toBeInTheDocument();
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});
