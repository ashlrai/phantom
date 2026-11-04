/**
 * RQ-PHX-MAINREDNOTIFY09 — Mason's Nov 1 23:31 order (the always-on
 * main-guardian keeps main moving, and main will sometimes break) plus his
 * Nov 1 00:08 order (status reaches him; he never has to ask). This module
 * plans the one-shot notices: one short message when a repo's default branch
 * turns red, and one when it recovers. The sends themselves live in
 * src/cli/fleet-main-red-notify.ts.
 *
 * Dedup is a small state file — <runsDir>/state/main-red-notify.json —
 * mapping repo to its last notified state ('red' | 'green'), written
 * atomically (temp file + rename) with mode 0600. An unreadable file counts
 * as empty state.
 *
 * Missing evidence is never a transition: an 'unknown' row, a stale status
 * table or an unavailable source produces no notice and leaves the repo's
 * recorded state untouched, so a flaky read can neither re-fire a 'red'
 * notice nor fake a recovery. A repo absent from the table keeps its
 * recorded state for the same reason — if it reappears green after having
 * been red, the recovery notice still fires once.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ensurePrivateDirectory, writePrivateFileAtomic } from '../verse/preferences.js';
import type { FleetMainHealthV1 } from './main-health.js';

export const MAIN_RED_NOTIFY_SCHEMA = 'fleet.main-red-notify.v1';
/** State path relative to the runs dir. */
export const MAIN_RED_NOTIFY_STATE = join('state', 'main-red-notify.json');

const MAX_NAME_CHARS = 80;
const MAX_TEXT_CHARS = 300;

export type MainRedNotifyState = Record<string, 'red' | 'green'>;
export interface MainRedNotice {
  repo: string;
  kind: 'red' | 'recovered';
  text: string;
}
export interface MainRedNoticePlan {
  notices: MainRedNotice[];
  next: MainRedNotifyState;
}

/** Operator-facing text carries no control bytes and stays bounded. */
// eslint-disable-next-line no-control-regex -- table cells must not carry control bytes.
const clean = (raw: string | null | undefined): string => (raw ?? '').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, MAX_NAME_CHARS);
const clip = (text: string): string => text.slice(0, MAX_TEXT_CHARS);

/**
 * Pure: fold the guardian health table over the recorded states. `nowMs` is
 * part of the contract (a future cooldown window would need it); the current
 * rule set is transition-only.
 */
export function planMainRedNotices(
  prev: MainRedNotifyState,
  health: FleetMainHealthV1,
  _nowMs: number,
): MainRedNoticePlan {
  const next: MainRedNotifyState = { ...prev };
  const notices: MainRedNotice[] = [];
  if (health.source === 'unavailable' || health.stale) return { notices, next };
  for (const row of health.repos) {
    const repo = clean(row.repo);
    if (!repo) continue;
    const was = next[repo];
    if (row.state === 'red') {
      next[repo] = 'red';
      if (was === 'red') continue;
      const check = clean(row.failingCheck) || 'check failing';
      const fix = clean(row.fixJobs[0]) || 'none yet';
      notices.push({ repo, kind: 'red', text: clip(`Main red on ${repo}: ${check}. Fix job: ${fix}.`) });
    } else if (row.state === 'green') {
      next[repo] = 'green';
      if (was === 'red') notices.push({ repo, kind: 'recovered', text: clip(`Main green again on ${repo}.`) });
    }
    // 'unknown' rows are missing evidence: recorded state stays as it was.
  }
  return { notices, next };
}

/** An unreadable or malformed state file counts as empty state. */
export function readMainRedNotifyState(runsDir: string): MainRedNotifyState {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(runsDir, MAIN_RED_NOTIFY_STATE), 'utf8'));
  } catch {
    return {};
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const state: MainRedNotifyState = {};
  for (const [repo, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === 'red' || value === 'green') state[repo] = value;
  }
  return state;
}

/** Temp file + rename, mode 0600 via writePrivateFileAtomic. */
export function writeMainRedNotifyState(runsDir: string, state: MainRedNotifyState): void {
  const path = join(runsDir, MAIN_RED_NOTIFY_STATE);
  ensurePrivateDirectory(dirname(path));
  writePrivateFileAtomic(path, `${JSON.stringify(state, null, 2)}\n`);
}
