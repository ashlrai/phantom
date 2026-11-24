/**
 * The `seats` section of `agents bus work mine`: the bot-seat handoff work
 * the agent still holds, read through the same `planSeatHandoffs` projection
 * `phm bots handoffs` and the unified inbox's seats source serve, so the
 * digest, that verb and `phm comms inbox --source seats` can never disagree.
 * Only seats the agent denotes — its resolved identity's labels or the
 * literal seat/participant ref — that are eligible and still carry pending
 * (not yet journaled) handoff records list; an ineligible seat's held work
 * is not a handoff candidate and a journaled record is already applied.
 * Seat handoffs are agent work, never owner-blocking, and claims coordinate
 * scope only — this section reports, it never releases or applies.
 *
 * The section is async where the rest of the digest is synchronous: the seat
 * plan reads quota evidence (which can consult a custody subprocess) and the
 * coordination table, so `readBusWorkMineWithSeats` composes the synchronous
 * `readBusWorkMine` sections with this read and leaves `seats` absent on the
 * bare synchronous result rather than reporting a section it never read.
 */
import { agentLabels, readAgentRegistry, resolveAgent } from './bus-identity.js';
import { planSeatHandoffs, type SeatHandoff, type SeatHandoffsPlan, type SeatOptions } from '../bots/seats.js';
import { scrubSecrets } from '../util/scrub.js';
import { readBusWorkMine, type BusWorkMineOptions, type BusWorkMineResult, type BusWorkMineSeat, type BusWorkMineSeats } from './bus-work-mine.js';

/** Seats with pending handoffs a digest shows; `matched` keeps the true total. */
const WORK_MINE_SEATS_MAX = 20;

/**
 * The `--contains` verdict for one pending seat handoff, decided on the only
 * descriptive fields the record carries — the held work's ref, branch and
 * pull request, scrubbed and normalized like every other bus `--contains`
 * haystack. Seat id, participant, state and handoff id are routing labels,
 * statuses and record ids, never search text; a handoff whose fields name
 * no match drops out and `matched` recounts, so every count stays the
 * filtered total.
 */
function seatHandoffContainsMatch(handoff: SeatHandoff, needle: string): boolean {
  return scrubSecrets(`${handoff.work.ref} ${handoff.branch ?? ''} ${handoff.pr ?? ''}`)
    .toLowerCase().replace(/\s+/g, ' ').includes(needle);
}

/**
 * Shape one seat-handoff plan into the digest section. `denotes` is the
 * caller's seat-membership predicate over `{seatId, participantId}`; under a
 * `job` filter only `node-job` records whose ref is the job id survive — a
 * `bus-claim` ref is a coordination claim key, not a job id, matching the
 * unified inbox's job-citation rule — and under a `contains` filter only
 * records whose held-work text carries the needle survive. Seats left with
 * no records drop out and `matched` recounts, so every count stays the
 * filtered total. The section takes no `since`, `priority` or `channel`:
 * a pending handoff record's `createdAt` stamps the plan read instant, not
 * the held work's age, so no per-record recency exists to filter on, the
 * record carries no wire band, and seat work has no per-record room —
 * every listed record is current evidence and the section stays whole
 * like `channels`.
 */
export function busWorkMineSeatsFromPlan(
  plan: SeatHandoffsPlan,
  denotes: (seat: { seatId: string; participantId: string }) => boolean,
  job?: string,
  contains?: string,
): BusWorkMineSeats {
  const needle = contains?.toLowerCase().replace(/\s+/g, ' ').trim();
  const matched: BusWorkMineSeat[] = [];
  for (const entry of plan.seats) {
    if (!entry.eligible || entry.handoffs.length === 0 || !denotes(entry)) continue;
    const handoffs = entry.handoffs
      .filter(h => job === undefined || (h.work.kind === 'node-job' && h.work.ref === job))
      .filter(h => needle === undefined || needle === '' || seatHandoffContainsMatch(h, needle));
    if (handoffs.length === 0) continue;
    matched.push({ seatId: entry.seatId, participantId: entry.participantId, state: entry.state,
      handoffs: handoffs.map(h => ({ handoffId: h.handoffId, work: { kind: h.work.kind, ref: h.work.ref },
        branch: h.branch, pr: h.pr })) });
  }
  const seats = matched.slice(0, WORK_MINE_SEATS_MAX);
  return { status: 'ok', matched: matched.length, seats, truncated: matched.length > seats.length };
}

/**
 * The `seats` section alone: resolves the agent's identity labels exactly as
 * the synchronous sections do — the literal ref or any label of the resolved
 * identity, never widened on an unreadable registry — then reads the fleet
 * seat plan under the digest's frozen clock and store roots. A throwing plan
 * read (unreadable roster, coordination table or node store) reports
 * `unavailable`, never an empty plan passed off as fact.
 */
export async function readBusWorkMineSeats(agent: string, options: BusWorkMineOptions = {}): Promise<BusWorkMineSeats> {
  const nowMs = (options.now ?? Date.now)();
  const seatOptions: SeatOptions = {
    ...options.seats,
    fleetRoot: options.seats?.fleetRoot ?? options.root,
    runs: options.seats?.runs ?? options.runsRoot,
    now: options.seats?.now ?? (() => nowMs),
  };
  let plan: SeatHandoffsPlan;
  try { plan = await planSeatHandoffs(seatOptions); }
  catch { return { status: 'unavailable', reason: 'seat-handoff-plan-unreadable' }; }

  const read = readAgentRegistry({ root: options.root });
  const registry = read.status === 'ok' ? read.registry : undefined;
  const identity = registry === undefined ? undefined : resolveAgent(registry, agent);
  const labels = identity === undefined ? [agent] : agentLabels(identity);
  return busWorkMineSeatsFromPlan(plan,
    seat => seat.seatId === agent || labels.includes(seat.participantId), options.job, options.contains);
}

/**
 * The full `work mine` digest: every synchronous section plus the async
 * seat-handoff plan, merged into one `BusWorkMineResult`. An invalid agent or
 * job ref fails fast through `readBusWorkMine` before any seat read runs.
 */
export async function readBusWorkMineWithSeats(agent: string, options: BusWorkMineOptions = {}): Promise<BusWorkMineResult> {
  const base = readBusWorkMine(agent, options);
  if (base.status !== 'ok') return base;
  return { ...base, seats: await readBusWorkMineSeats(agent, options) };
}
