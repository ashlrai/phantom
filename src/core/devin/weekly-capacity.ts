/**
 * Devin as a measured weekly resource. Devin Max plans meter a weekly ACU
 * allowance (no daily allowance) and every session reports `acus_consumed`,
 * so the current window's use is the sum over sessions created since the last
 * weekly reset, read from GET /v3/organizations/{org_id}/sessions.
 *
 * Nothing is guessed: with no reset anchor the window is unknown and `used` is
 * null; an incomplete listing is null; no allowance is a null limit. The
 * allowance is `devin.weeklyAcuAllowance`, else the local Devin budget total.
 * `phm capacity publish` records the last measurement so a later failed read
 * shows it as stale evidence, never as fresh headroom.
 *
 * A session is attributed to the window it was created in; its ACUs are not
 * split across a reset.
 */
import { join } from 'node:path';
import { loadConfig } from '../config.js';
import type { AshlrConfig } from '../types.js';
import { readPrivateFileCapped, writePrivateFileAtomic } from '../verse/preferences.js';
import { RESOURCE_LIVE_STALE_MS, DEVIN_FLASH_EXPIRES_AT } from '../usage/resource-live/types.js';
import type { ResourceLiveObservation } from '../usage/resource-live/source-types.js';
import type { DevinSession, DevinSessionPage } from './client.js';
import type { DevinModelCatalog } from './models.js';
import { devinCatalogModels } from './models.js';
import { connectedClient } from './service.js';
import { devinHome, ensureDevinDirectory, readDevinBudget } from './store.js';

export const DEVIN_WEEK_MS = 7 * 24 * 3_600_000;
export const DEVIN_WEEKLY_SOURCE = 'devin-api-v3-sessions';
const PAGE_SIZE = 200;
const MAX_PAGES = 25;

export type DevinWeeklyState = 'live' | 'stale' | 'unmeasured';

export interface DevinWeeklyCapacity {
  account_id?: string;
  model?: string;
  used: number | null;
  limit: number | null;
  remaining: number | null;
  /** Where the allowance came from. */
  limit_source: 'config' | 'budget' | null;
  window_start: string | null;
  reset_at: string | null;
  /** Mean ACU per hour since the window started. */
  burn_rate_per_hour: number | null;
  sessions: number | null;
  source: typeof DEVIN_WEEKLY_SOURCE | null;
  observed_at: string | null;
  state: DevinWeeklyState;
  /** Why a field is null, when one is. */
  reason: string | null;
}

const iso = (ms: number): string => new Date(ms).toISOString();
const round = (n: number): number => Math.round(n * 1000) / 1000;

/** The weekly window containing `nowMs`, from any known reset instant. Null without one. */
export function devinWeeklyWindow(anchor: string | null | undefined, nowMs: number): { startMs: number; resetMs: number } | null {
  const anchorMs = typeof anchor === 'string' ? Date.parse(anchor) : Number.NaN;
  if (!Number.isFinite(anchorMs)) return null;
  const startMs = anchorMs + Math.floor((nowMs - anchorMs) / DEVIN_WEEK_MS) * DEVIN_WEEK_MS;
  return { startMs, resetMs: startMs + DEVIN_WEEK_MS };
}

export function devinWeeklyAllowance(section: AshlrConfig['devin'] | undefined, budgetTotal: number | null): { limit: number | null; source: DevinWeeklyCapacity['limit_source'] } {
  const configured = section?.weeklyAcuAllowance;
  if (typeof configured === 'number' && Number.isFinite(configured) && configured > 0) return { limit: configured, source: 'config' };
  if (typeof budgetTotal === 'number' && Number.isFinite(budgetTotal) && budgetTotal > 0) return { limit: budgetTotal, source: 'budget' };
  return { limit: null, source: null };
}

export interface DevinWeeklyInput {
  accountId?: string;
  model?: string;
  sessions: readonly DevinSession[] | null;
  /** False when the listing hit a page cap or a malformed row. */
  complete: boolean;
  allowance: { limit: number | null; source: DevinWeeklyCapacity['limit_source'] };
  resetAnchor: string | null | undefined;
  nowMs: number;
  /** Why `sessions` is null. */
  failure?: string;
}

/** Pure: one measurement from a session listing. */
export function measureDevinWeekly(input: DevinWeeklyInput): DevinWeeklyCapacity {
  const window = devinWeeklyWindow(input.resetAnchor, input.nowMs);
  const { limit, source: limitSource } = input.allowance;
  const base: DevinWeeklyCapacity = {
    ...(input.accountId === undefined ? {} : { account_id: input.accountId }),
    ...(input.model === undefined ? {} : { model: input.model }),
    used: null, limit, remaining: null, limit_source: limitSource,
    window_start: window ? iso(window.startMs) : null, reset_at: window ? iso(window.resetMs) : null,
    burn_rate_per_hour: null, sessions: null, source: null, observed_at: null, state: 'unmeasured', reason: null,
  };
  if (!window) return { ...base, reason: 'No weekly reset anchor; set devin.weeklyResetAt.' };
  if (input.sessions === null) return { ...base, reason: input.failure ?? 'Devin session list unavailable.' };
  if (!input.complete) return { ...base, reason: 'Devin session list incomplete.' };
  let used = 0;
  let count = 0;
  for (const session of input.sessions) {
    const created = session.createdAtMs ?? null;
    if (created === null) return { ...base, reason: 'A Devin session has no created_at.' };
    if (created < window.startMs || created > input.nowMs) continue;
    count += 1;
    // Unknown consumption makes the window sum unknown, never zero.
    if (session.acusConsumed === null) return { ...base, reason: 'A Devin session has no acus_consumed.' };
    used += session.acusConsumed;
  }
  const hours = (input.nowMs - window.startMs) / 3_600_000;
  return {
    ...base, used: round(used), remaining: limit === null ? null : round(Math.max(0, limit - used)),
    burn_rate_per_hour: hours > 0 ? round(used / hours) : null, sessions: count,
    source: DEVIN_WEEKLY_SOURCE, observed_at: iso(input.nowMs), state: 'live',
    reason: limit === null ? 'No weekly allowance configured.' : null,
  };
}

export interface DevinWeeklyDeps {
  accountId?: string;
  model?: string;
  nowMs?: number;
  section?: AshlrConfig['devin'];
  budgetTotal?: number | null;
  /** One page of the org's sessions. Defaults to the connected client. */
  listPage?: (after: string | undefined) => Promise<DevinSessionPage>;
}

/** Live read: page the session list, then measure. Never throws. */
export async function readDevinWeeklyCapacity(deps: DevinWeeklyDeps = {}): Promise<DevinWeeklyCapacity> {
  const nowMs = deps.nowMs ?? Date.now();
  let section = deps.section;
  let budgetTotal = deps.budgetTotal;
  try { section ??= loadConfig().devin; } catch { section = undefined; }
  try { if (budgetTotal === undefined) budgetTotal = readDevinBudget().acuBudgetTotal; } catch { budgetTotal = null; }
  const input = { allowance: devinWeeklyAllowance(section, budgetTotal ?? null), resetAnchor: section?.weeklyResetAt, nowMs,
    accountId: deps.accountId, model: deps.model ?? section?.fleetModel };
  if (!devinWeeklyWindow(input.resetAnchor, nowMs)) return measureDevinWeekly({ ...input, sessions: null, complete: false });
  try {
    let listPage = deps.listPage;
    if (!listPage) {
      const connected = await connectedClient();
      if ('error' in connected) return measureDevinWeekly({ ...input, sessions: null, complete: false, failure: 'Devin is not connected.' });
      input.accountId = deps.accountId ?? connected.orgId;
      listPage = (after) => connected.client.listSessions(connected.orgId, { first: PAGE_SIZE, ...(after ? { after } : {}) });
    }
    const sessions: DevinSession[] = [];
    let after: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const result = await listPage(after);
      if (result.complete === false) return measureDevinWeekly({ ...input, sessions, complete: false });
      sessions.push(...result.items);
      if (!result.hasNextPage || !result.endCursor) return measureDevinWeekly({ ...input, sessions, complete: true });
      after = result.endCursor;
    }
    return measureDevinWeekly({ ...input, sessions, complete: false });
  } catch {
    return measureDevinWeekly({ ...input, sessions: null, complete: false, failure: 'Devin session list request failed.' });
  }
}

export const devinWeeklyCapacityPath = (): string => join(devinHome(), 'weekly-capacity.json');

/** The last published measurement, with its state re-derived from its age. */
export function readPublishedDevinWeekly(nowMs: number, file = devinWeeklyCapacityPath()): DevinWeeklyCapacity | null {
  try {
    const raw = readPrivateFileCapped(file, 16_384);
    const parsed = raw === null || raw.truncated ? null : JSON.parse(raw.text) as DevinWeeklyCapacity;
    const observed = parsed?.observed_at ? Date.parse(parsed.observed_at) : Number.NaN;
    if (!parsed || parsed.source !== DEVIN_WEEKLY_SOURCE || !Number.isFinite(observed) || typeof parsed.used !== 'number') return null;
    return { ...parsed, state: nowMs - observed <= RESOURCE_LIVE_STALE_MS ? 'live' : 'stale' };
  } catch {
    return null;
  }
}

/** `phm capacity publish`: measure now, record a live result, else fall back to the last one. */
export async function publishDevinWeeklyCapacity(deps: DevinWeeklyDeps & { file?: string } = {}): Promise<DevinWeeklyCapacity> {
  const nowMs = deps.nowMs ?? Date.now();
  const live = await readDevinWeeklyCapacity({ ...deps, nowMs });
  if (live.state === 'live') {
    try {
      if (!deps.file) ensureDevinDirectory();
      writePrivateFileAtomic(deps.file ?? devinWeeklyCapacityPath(), `${JSON.stringify(live)}\n`);
    } catch { /* the live answer still stands */ }
    return live;
  }
  const last = readPublishedDevinWeekly(nowMs, deps.file);
  // A recorded window that has since reset says nothing about this one.
  return last && last.reset_at !== null && Date.parse(last.reset_at) > nowMs ? { ...last, state: 'stale', reason: live.reason } : live;
}

/** resource-live.v1 observation. Null unless both the use and the reset are known. */
export function devinWeeklyObservation(capacity: DevinWeeklyCapacity): ResourceLiveObservation | null {
  if (capacity.used === null || capacity.observed_at === null || capacity.source === null || capacity.reset_at === null) return null;
  return { used: capacity.used, limit: capacity.limit, unit: 'acu', reset_at: capacity.reset_at, source: capacity.source, observed_at: capacity.observed_at,
    ...(capacity.account_id === undefined ? {} : { account_id: capacity.account_id }),
    ...(capacity.model === undefined ? {} : { model: capacity.model }),
    ...(capacity.window_start === null ? {} : { window_start: capacity.window_start }) };
}

/** Devin CLI free-preview models: zero cost until the preview ends. */
export const DEVIN_PREVIEW_MODELS = [
  { pattern: /^swe-2[\w.-]*lightning/i, label: 'SWE-2 Lightning', expires_at: DEVIN_FLASH_EXPIRES_AT },
  { pattern: /^swe-2[\w.-]*flash/i, label: 'SWE-2 Flash', expires_at: DEVIN_FLASH_EXPIRES_AT },
] as const;

/** How many preview models the CLI catalog lists as free and unexpired. Null when none. */
export function devinPreviewObservation(catalog: DevinModelCatalog | null, nowMs: number): ResourceLiveObservation | null {
  if (!catalog?.fetchedAt) return null;
  const listedMs = Date.parse(catalog.fetchedAt);
  if (!Number.isFinite(listedMs)) return null;
  const free = devinCatalogModels(catalog).filter(model => model.pricing?.free === true
    && DEVIN_PREVIEW_MODELS.some(row => row.pattern.test(model.id) && Date.parse(row.expires_at) > nowMs));
  if (free.length === 0) return null;
  return { used: null, limit: free.length, unit: 'models', reset_at: null, source: 'devin-cli-models-list', observed_at: iso(listedMs), model: free[0]!.id };
}

const show = (value: number | string | null): string => (value === null ? 'unknown' : String(value));

/** One human line for `phm capacity publish`. */
export function devinWeeklyLine(c: DevinWeeklyCapacity): string {
  return `devin weekly: used ${show(c.used)} · left ${show(c.remaining)} of ${show(c.limit)} ACU · reset ${show(c.reset_at)} · burn ${show(c.burn_rate_per_hour)} ACU/h · ${c.state}${c.reason ? ` (${c.reason})` : ''}`;
}
