/**
 * CoordAnswerStrip.test.tsx — RQ-PHX-COORDANSWERSTRIP322. The strip on the
 * Fleet Board pane: the three existing reads fanned out from one mount, the
 * REACHABLE / BLOCKED chip and one plain-words missing reason. Fake ids only.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { CoordAnswerStrip } from './CoordAnswerStrip.js';

const RUNTIME_PATH = '/api/verse/fleet/runtime-identity';
const COMMS_PATH = '/api/verse/fleet/comms-status';
const BOARD_PATH = '/api/verse/fleet/work-board';
const NOW = Date.now();
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

const RUNTIME = {
  v: 1,
  generatedAt: ago(30_000),
  identity: {
    host: 'fake-host-a', installedVersion: '1.2.3',
    fleetState: { ageSeconds: 120, stale: false },
  },
};

const COMMS = {
  channelHealth: {
    asOf: ago(30_000),
    channels: [{ channel: 'slack', state: 'LIVE', lastReplyAt: ago(4 * 60_000) }],
  },
};

const BOARD = {
  items: [{
    id: 'wi-fake-0001', channelRef: 'fake-team/fake-chan/111.2', receivedAt: ago(2 * 60_000),
    state: 'RUNNING', owner: 'devin', claimReceipt: 'bus-claim:wi-fake-0001:7:x',
  }],
  inbox: 'ok',
  asOf: ago(5_000),
};

function stubFetch(handler: (url: string) => Response) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => handler(String(input)));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => { cleanup(); evictAll(); vi.unstubAllGlobals(); });

it('shows REACHABLE with the runtime, claims and bridge rows when all three reads answer', async () => {
  const fetchMock = stubFetch((url) => {
    if (url === RUNTIME_PATH) return json(RUNTIME);
    if (url === COMMS_PATH) return json(COMMS);
    if (url.startsWith(BOARD_PATH)) return json(BOARD);
    return json({}, 404);
  });
  render(<CoordAnswerStrip visible={true} />);

  await waitFor(() => expect(screen.getByText('REACHABLE')).toBeInTheDocument());
  expect(screen.getByText('Coordination answer')).toBeInTheDocument();
  expect(screen.getByText(/fake-host-a · 1\.2\.3 · fleet state/)).toBeInTheDocument();
  expect(screen.getByText(/inbox ok · as of/)).toBeInTheDocument();
  expect(screen.getByText(/LIVE · last reply 4m ago/)).toBeInTheDocument();
  expect(screen.getByText(/wi-fake-0001 · RUNNING · owner devin/)).toBeInTheDocument();
  expect(fetchMock.mock.calls.map((c) => String(c[0]))).toEqual(
    expect.arrayContaining([RUNTIME_PATH, COMMS_PATH, `${BOARD_PATH}?limit=20`]),
  );
});

it('shows BLOCKED and the missing reason when the work board is not on this build', async () => {
  stubFetch((url) => {
    if (url === RUNTIME_PATH) return json(RUNTIME);
    if (url === COMMS_PATH) return json(COMMS);
    return json({}, 404);
  });
  render(<CoordAnswerStrip visible={true} />);

  await waitFor(() => expect(screen.getByText('BLOCKED')).toBeInTheDocument());
  expect(screen.getByText('work board not available on this Phantom build')).toBeInTheDocument();
});
