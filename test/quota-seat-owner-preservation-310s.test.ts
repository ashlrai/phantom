import { describe, expect, it } from 'vitest';
import { quotaLines } from '../src/core/comms/status-quota-lines.js';
import { emailFleetStatus } from '../src/core/comms/email-fleet-status.js';
import { telegramFleetStatus } from '../src/core/comms/telegram-fleet-status.js';

type CapacitySnapshot = NonNullable<Parameters<typeof quotaLines>[0]>;
type SeatCapacity = CapacitySnapshot['seats'][number];
type CapacityWindow = SeatCapacity['windows'][number];
type EmailReaders = NonNullable<Parameters<typeof emailFleetStatus>[2]>;
type TelegramDeps = NonNullable<Parameters<typeof telegramFleetStatus>[0]>;
type RunsState = Awaited<ReturnType<NonNullable<EmailReaders['runs']>>>;
type WorkersSnapshot = Awaited<ReturnType<NonNullable<EmailReaders['workers']>>>;
type SupplySnapshot = Awaited<ReturnType<NonNullable<EmailReaders['supply']>>>;

const NOW = Date.parse('2026-11-13T12:00:00.000Z');
const iso = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();

const weekly = (usedPercent: number | null = 42): CapacityWindow => ({
  id: 'weekly', usedPercent, resetsAt: null, resetDescription: 'next week', limitReached: false,
});

const seat = (
  label: string,
  observedAt: string | null,
  overrides: Partial<SeatCapacity> = {},
): SeatCapacity => ({
  seatId: label,
  label,
  engine: 'codex',
  free: false,
  windows: [weekly()],
  signedOut: false,
  reachable: true,
  contextWindow: null,
  observedAt,
  spentTodayUsd: null,
  ...overrides,
});

const snapshot = (seats: SeatCapacity[]): CapacitySnapshot => ({ v: 1, publishedAt: iso(-1), seats });

const RUNS: RunsState = {
  v: 1,
  generatedAt: new Date(NOW).toISOString(),
  runsDirPresent: true,
  sourceState: 'healthy',
  sources: {
    status: 'healthy', claimed: 'healthy', events: 'healthy', metrics: 'healthy',
    claudeLane: 'healthy', switches: 'healthy', drop: 'healthy',
  },
  lastTick: iso(-1),
  paused: false,
  memFreePct: 50,
  diskFreeGb: 100,
  lanes: [],
  switches: [],
  claudeLane: null,
  publishesLastHour: [],
  events: [],
  claimed: [],
  drop: { pending: [], done: 0 },
};

const WORKERS: WorkersSnapshot = {
  v: 1,
  generatedAt: new Date(NOW).toISOString(),
  sourceState: 'healthy',
  workers: [],
  leaders: [],
  orchestratorAgents: 0,
};

const SUPPLY: SupplySnapshot = {
  v: 1,
  sourceState: 'healthy',
  lanes: [],
  planner: { status: 'unknown', lastGoodPassAt: null, reason: 'unavailable' },
};

async function replies(capacity: CapacitySnapshot): Promise<{ email: string; telegram: string }> {
  const readQuota = () => quotaLines(capacity, NOW);
  const [email, telegram] = await Promise.all([
    emailFleetStatus(undefined, () => new Date(NOW), {
      runs: async () => RUNS,
      workers: async () => WORKERS,
      supply: async () => SUPPLY,
      readQuota,
    }),
    telegramFleetStatus({
      now: () => new Date(NOW),
      readRuns: async () => RUNS,
      readWorkers: async () => WORKERS,
      readSupply: async () => SUPPLY,
      readQuota,
    } satisfies TelegramDeps),
  ]);
  return { email, telegram };
}

function quotaSection(body: string): string[] {
  return body.split('\n').filter((line) => line.startsWith('Quota '));
}

describe('quota seat owner preservation through status replies', () => {
  it('follows each seat observation across sequential snapshots in email and Telegram', async () => {
    const staleCodexFreshNeighbor = await replies(snapshot([
      seat('Codex', iso(-45)),
      seat('Neighbor', iso(-1), { engine: 'devin', seatId: 'neighbor', label: 'Neighbor' }),
    ]));
    for (const body of [staleCodexFreshNeighbor.email, staleCodexFreshNeighbor.telegram]) {
      expect(quotaSection(body)).toEqual([
        'Quota (stale, historical) Codex: weekly: 42% · next week',
        'Quota Neighbor: weekly: 42% · next week',
      ]);
    }

    const freshCodexStaleNeighbor = await replies(snapshot([
      seat('Codex', iso(-1)),
      seat('Neighbor', iso(-45), { engine: 'devin', seatId: 'neighbor', label: 'Neighbor' }),
    ]));
    for (const body of [freshCodexStaleNeighbor.email, freshCodexStaleNeighbor.telegram]) {
      expect(quotaSection(body)).toEqual([
        'Quota Codex: weekly: 42% · next week',
        'Quota (stale, historical) Neighbor: weekly: 42% · next week',
      ]);
    }
  });

  it('keeps invalid and future observations unknown and null usage unknown', async () => {
    const result = await replies(snapshot([
      seat('Invalid Stamp', 'not-a-timestamp'),
      seat('Future Stamp', iso(1)),
      seat('Null Usage', iso(-1), { windows: [weekly(null)] }),
    ]));
    for (const body of [result.email, result.telegram]) {
      expect(quotaSection(body)).toEqual([
        'Quota (freshness unknown) Invalid Stamp: weekly: 42% · next week',
        'Quota (freshness unknown) Future Stamp: weekly: 42% · next week',
        'Quota Null Usage: weekly: unknown · next week',
      ]);
      expect(body).not.toContain('Null Usage: weekly: 0%');
    }
  });

  it('renders Claude weekly capacity without advertising session or five-hour windows', async () => {
    const result = await replies(snapshot([
      seat('Claude', iso(-1), {
        engine: 'claude',
        windows: [
          { id: 'session', usedPercent: 90, resetsAt: null, resetDescription: null, limitReached: false },
          { id: 'five_hour', usedPercent: 80, resetsAt: null, resetDescription: null, limitReached: false },
          { id: 'seven_day', usedPercent: 40, resetsAt: null, resetDescription: 'Thursday', limitReached: true },
        ],
      }),
    ]));
    for (const body of [result.email, result.telegram]) {
      expect(quotaSection(body)).toEqual([
        'Quota Claude: seven_day: 40% · Thursday (limit reached)',
      ]);
      expect(body).not.toMatch(/Quota Claude:[^\n]*(?:session|five_hour)/);
    }
  });
});
