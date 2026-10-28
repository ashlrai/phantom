/**
 * Deterministic bridge-session harness. All nondeterminism (model/tool/CLI
 * responses, clock reads, random IDs, file reads) must go through `call`.
 * The runner is trusted application code, NOT code loaded from fleet.json.
 * Replay supplies no live adapter and grants no authority to perform effects.
 * Calls are deliberately serial; concurrent effects/timers cannot be reproduced
 * from a simple ordered tape and are refused rather than given false fidelity.
 */
import {
  canonicalReplayJson, replayError, replayIdentity, replayValue, restoreReplayError,
  REPLAY_MAX_CALLS, REPLAY_MAX_SESSIONS, ReplayHarnessError,
  type ReplayCall, type ReplayOutcome, type ReplaySession, type ReplayValue,
} from './replay-codec.js';
import { lockReplayFleet, readReplayFleet } from './replay-store.js';

export { ReplayHarnessError } from './replay-codec.js';
export type { ReplayOutcome, ReplaySession, ReplayValue } from './replay-codec.js';
export { readReplayFleet } from './replay-store.js';

export interface ReplayContext {
  readonly input: ReplayValue;
  call(operation: string, input: ReplayValue): Promise<ReplayValue>;
}

export type ReplayRunner = (context: ReplayContext) => Promise<ReplayValue>;
export type ReplayAdapter = (operation: string, input: ReplayValue) => Promise<ReplayValue>;

async function terminal(run: () => Promise<ReplayValue>): Promise<ReplayOutcome> {
  try { return { status: 'returned', value: replayValue(await run()) }; } catch (error) {
    if (error instanceof ReplayHarnessError) throw error;
    return replayError(error);
  }
}

function same(a: unknown, b: unknown): boolean {
  return canonicalReplayJson(a) === canonicalReplayJson(b);
}

function deliver(outcome: ReplayOutcome): ReplayValue {
  if (outcome.status === 'threw') throw restoreReplayError(outcome);
  return replayValue(outcome.value);
}

function handled(promise: Promise<ReplayValue>): Promise<ReplayValue> {
  // A fire-and-forget call still invalidates the session, but its rejection
  // must not also escape as an unhandled process-level rejection.
  void promise.catch(() => {});
  return promise;
}

async function drainCall(pending: Promise<ReplayValue> | null): Promise<void> {
  if (pending) await pending.catch(() => {});
}

/** Persist the session and each request BEFORE invoking its external adapter.
 * A crash leaves outcome=null, so it cannot masquerade as a complete capture.
 * Job IDs are immutable: retries need distinct IDs to retain failed attempts.
 */
export async function recordFleetSession(
  options: { path: string; jobId: string; input: ReplayValue },
  runner: ReplayRunner,
  adapter: ReplayAdapter,
): Promise<ReplayOutcome> {
  const session: ReplaySession = {
    jobId: replayIdentity(options.jobId), input: replayValue(options.input), calls: [], outcome: null,
  };
  const store = lockReplayFleet(options.path);
  let active: Promise<ReplayValue> | null = null;
  let closed = false;
  let fault: ReplayHarnessError | null = null;
  function refuse(error: unknown): never {
    fault ??= error instanceof ReplayHarnessError ? error : new ReplayHarnessError('storage');
    throw fault;
  }
  try {
    if (store.fleet.sessions.length >= REPLAY_MAX_SESSIONS ||
        store.fleet.sessions.some((s) => s.jobId === session.jobId)) throw new ReplayHarnessError('invalid');
    store.fleet.sessions.push(session);
    store.save();
    const context: ReplayContext = {
      input: replayValue(session.input),
      call(operation, input) {
        return handled((async () => {
          try {
            if (closed || active || fault || session.calls.length >= REPLAY_MAX_CALLS) refuse(new ReplayHarnessError('invalid'));
            const call: ReplayCall = { operation: replayIdentity(operation), input: replayValue(input), outcome: null };
            session.calls.push(call);
            store.save();
            // Schedule adapter invocation after `active` is set, including for a
            // synchronous throw or an adapter that re-enters the runner.
            const pending = Promise.resolve().then(() => terminal(() => adapter(call.operation, replayValue(call.input))))
              .then((outcome) => {
                if (fault) throw fault;
                call.outcome = outcome;
                store.save();
                return deliver(outcome);
              });
            active = pending;
            try { return await pending; } finally { active = null; }
          } catch (error) {
            if (error instanceof ReplayHarnessError) refuse(error);
            throw error;
          }
        })());
      },
    };
    const outcome = await terminal(() => runner(context));
    closed = true;
    if (active) refuse(new ReplayHarnessError('incomplete'));
    if (fault) throw fault;
    session.outcome = outcome;
    store.save();
    return replayOutcomeCopy(outcome);
  } finally {
    closed = true;
    // Never release a writer lock while an unawaited effect is still running.
    await drainCall(active);
    store.release();
  }
}

function replayOutcomeCopy(outcome: ReplayOutcome): ReplayOutcome {
  return JSON.parse(canonicalReplayJson(outcome)) as ReplayOutcome;
}

/** Run the same session code using only a complete selected fleet.json capture.
 * A mismatch is sticky even if the runner catches it. Exact terminal comparison
 * also catches changed logic that happens to request the same external calls.
 */
export async function replayFleetSession(
  options: { path: string; jobId: string }, runner: ReplayRunner,
): Promise<ReplayOutcome> {
  const id = replayIdentity(options.jobId);
  const session = readReplayFleet(options.path).sessions.find((s) => s.jobId === id);
  if (!session) throw new ReplayHarnessError('invalid');
  if (session.outcome === null || session.calls.some((call) => call.outcome === null)) throw new ReplayHarnessError('incomplete');
  let index = 0;
  let closed = false;
  let active = false;
  let fault: ReplayHarnessError | null = null;
  const context: ReplayContext = {
    input: replayValue(session.input),
    call(operation, input) {
      return handled((async () => {
        try {
          const expected = session.calls[index];
          if (closed || active || fault || !expected || replayIdentity(operation) !== expected.operation ||
              !same(replayValue(input), expected.input)) throw new ReplayHarnessError('mismatch');
          index++;
          active = true;
          try {
            await Promise.resolve();
            return deliver(expected.outcome!);
          } finally { active = false; }
        } catch (error) {
          if (error instanceof ReplayHarnessError) {
            fault ??= error;
            throw fault;
          }
          throw error;
        }
      })());
    },
  };
  let actual: ReplayOutcome;
  try { actual = await terminal(() => runner(context)); } finally { closed = true; }
  if (fault) throw fault;
  if (active || index !== session.calls.length || !same(actual, session.outcome)) throw new ReplayHarnessError('mismatch');
  return replayOutcomeCopy(actual);
}
