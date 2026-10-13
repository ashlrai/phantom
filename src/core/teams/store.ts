/**
 * Local-first team event bus: `$ASHLR_HOME/teams/<team>/events.jsonl`.
 * Writers serialize through a mkdir lock so claim conflict checks and appends
 * are atomic across concurrent agent processes on one machine.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { ashlrHome } from '../cloud/store.js';
import { scrubSecrets } from '../util/scrub.js';
import {
  TEAM_PROTOCOL_VERSION, TEAM_EVENT_TYPES, validId,
  type TeamActor, type TeamEvent, type TeamEventType,
} from './protocol.js';

export function teamDir(team: string): string {
  if (!validId(team) || team.includes('/') || team.includes('..')) throw new Error('Invalid team id.');
  return join(ashlrHome(), 'teams', team);
}
function logPath(team: string): string { return join(teamDir(team), 'events.jsonl'); }

export function newEventId(now = Date.now()): string {
  return `${now.toString(36).padStart(9, '0')}-${randomBytes(4).toString('hex')}`;
}

/** Throws if any string inside `value` looks like a credential. */
export function assertNoSecrets(value: unknown): void {
  const text = JSON.stringify(value) ?? '';
  if (scrubSecrets(text) !== text) {
    throw new Error('Refused: payload contains a credential-shaped value. Store it in Phantom Secrets and reference it as phm_<name>.');
  }
}

function sleep(ms: number): void { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

export function withTeamLock<T>(team: string, fn: () => T): T {
  const dir = teamDir(team);
  mkdirSync(dir, { recursive: true });
  const lock = join(dir, '.lock');
  const deadline = Date.now() + 5000;
  for (;;) {
    try { mkdirSync(lock); break; } catch {
      try { if (Date.now() - statSync(lock).mtimeMs > 10_000) { rmdirSync(lock); continue; } } catch { /* raced */ }
      if (Date.now() > deadline) throw new Error('Team log is busy; retry.');
      sleep(15);
    }
  }
  try { return fn(); } finally { try { rmdirSync(lock); } catch { /* already gone */ } }
}

export function readEvents(team: string): TeamEvent[] {
  const file = logPath(team);
  if (!existsSync(file)) return [];
  const out: TeamEvent[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line) as TeamEvent;
      if (ev && ev.v === TEAM_PROTOCOL_VERSION && (TEAM_EVENT_TYPES as readonly string[]).includes(ev.type)) out.push(ev);
    } catch { /* torn/foreign line: skip, never crash */ }
  }
  return out;
}

/** Append without taking the lock (caller must hold it). */
export function appendUnlocked<P extends Record<string, unknown>>(team: string, actor: TeamActor, type: TeamEventType, payload: P): TeamEvent<P> {
  if (!validId(actor.id)) throw new Error('Invalid actor id.');
  assertNoSecrets({ actor, payload });
  const ev: TeamEvent<P> = { v: TEAM_PROTOCOL_VERSION, id: newEventId(), ts: new Date().toISOString(), team, actor, type, payload };
  appendFileSync(logPath(team), JSON.stringify(ev) + '\n', { mode: 0o600 });
  return ev;
}

export function appendEvent<P extends Record<string, unknown>>(team: string, actor: TeamActor, type: TeamEventType, payload: P): TeamEvent<P> {
  return withTeamLock(team, () => appendUnlocked(team, actor, type, payload));
}

/** Import events from a peer/sync service (idempotent by id). */
export function importEvents(team: string, events: TeamEvent[]): number {
  return withTeamLock(team, () => {
    const seen = new Set(readEvents(team).map((e) => e.id));
    let n = 0;
    for (const ev of events) {
      if (ev.team !== team || seen.has(ev.id) || ev.v !== TEAM_PROTOCOL_VERSION) continue;
      assertNoSecrets(ev);
      appendFileSync(logPath(team), JSON.stringify(ev) + '\n', { mode: 0o600 });
      seen.add(ev.id); n++;
    }
    return n;
  });
}
