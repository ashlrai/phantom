import type { AshlrConfig } from '../types.js';
import type { VerseAccountCollector } from '../verse/accounts.js';
import type { VerseSeat } from '../verse/types.js';
import { capacityFromSeat, type SeatCapacity } from './headroom.js';
import { writeCapacitySnapshotAsync } from './budget-store.js';

export interface CapacityReading {
  seats: SeatCapacity[];
  sampledAt: string;
}

export type CapacitySource = (cfg: AshlrConfig, opts?: { collector?: VerseAccountCollector | null }) => Promise<CapacityReading>;

const SEAT_IDENTITY_TTL_MS = 60_000;
let identityCache: { cfg: AshlrConfig; expiresAt: number; seats: VerseSeat[] } | null = null;
let identityInFlight: Promise<VerseSeat[]> | null = null;
let lastSnapshotAt = 0;

async function defaultCapacitySource(cfg: AshlrConfig, opts: { collector?: VerseAccountCollector | null } = {}): Promise<CapacityReading> {
  const seatsMod = await import('../verse/seats.js');
  const now = Date.now();
  let seats: VerseSeat[];
  if (identityCache && identityCache.cfg === cfg && now < identityCache.expiresAt) {
    seats = identityCache.seats;
  } else {
    if (!identityInFlight) {
      identityInFlight = seatsMod.discoverSeats(cfg, {
        claudeUsage: () => ({ tokens5h: 0, tokens7d: 0, messages5h: 0, messages7d: 0, readAt: Date.now(), filesScanned: 0 }),
      })
        .then((discovery) => {
          identityCache = { cfg, expiresAt: Date.now() + SEAT_IDENTITY_TTL_MS, seats: discovery.seats };
          return discovery.seats;
        })
        .finally(() => { identityInFlight = null; });
    }
    seats = await identityInFlight;
  }
  const telemetry = seatsMod.buildSeatTelemetry(
    seatsMod.resolveAccountsRoot(cfg),
    opts.collector !== undefined ? { collector: opts.collector } : {},
  );
  return {
    sampledAt: new Date().toISOString(),
    seats: seats.map((seat) => capacityFromSeat(
      seat,
      seat.engine === 'local' ? undefined : telemetry.get(seat.accountId)?.capacity ?? null,
    )),
  };
}

let capacitySource: CapacitySource = defaultCapacitySource;

export function readCapacitySource(
  cfg: AshlrConfig,
  opts?: { collector?: VerseAccountCollector | null },
): Promise<CapacityReading> {
  return capacitySource(cfg, opts);
}

export function setCapacitySourceForTest(source?: CapacitySource): void {
  capacitySource = source ?? defaultCapacitySource;
  identityCache = null;
  identityInFlight = null;
  lastSnapshotAt = 0;
}

export function capacitySnapshotLastWrittenAt(): number {
  return lastSnapshotAt;
}

export function markCapacitySnapshotWrittenAt(nowMs: number): void {
  lastSnapshotAt = nowMs;
}

export async function publishCapacitySnapshotFrom(cfg: AshlrConfig, collector: VerseAccountCollector): Promise<string> {
  const reading = await readCapacitySource(cfg, { collector });
  const snapshot = await writeCapacitySnapshotAsync(reading.seats, new Date());
  markCapacitySnapshotWrittenAt(Date.now());
  return snapshot.publishedAt;
}
