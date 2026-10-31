/**
 * routes/verse/fleet-usage/usage-pane-model.ts — the pure projection behind
 * the dock Usage pane: one dense row per provider account, the fleet
 * snapshot's own Codex personal figure, and tokens-per-lane.
 *
 * Windows are rendered EXACTLY as the provider reported them, minus the one
 * window that no longer exists: Anthropic removed Claude's 5-hour limit, so
 * a stale `five_hour` in the payload is filtered out (provider-windows) and
 * the row says why only the weekly window applies. Runs data is narrowed
 * field-by-field (like fleet-events-model) so a drifted or partial body
 * degrades to nothing rather than throwing at render time.
 */
import type { Account, AccountProvider, AccountsSnapshot } from '../usage/usage-contract.js';
import { visibleWindows, windowNote } from '../usage/provider-windows.js';

// ---------------------------------------------------------------------------
// Provider accounts (GET /api/verse/accounts, already narrowed to
// AccountsSnapshot by usage-contract's projectAccountsSnapshot)
// ---------------------------------------------------------------------------

export interface UsageWindowRow {
  /** Provider label, else the window id — never invented. */
  label: string;
  /** 0–100, or null for "no reading". */
  usedPercent: number | null;
  resetsAt: string | null;
  /** Claude's prose reset ("resets Fri 2 am"), rendered verbatim ahead of any countdown. */
  resetDescription: string | null;
  limitReached: boolean;
  measured: boolean;
}

export interface UsageRow {
  id: string;
  label: string;
  provider: AccountProvider;
  state: Account['state'];
  reason: string | null;
  windows: UsageWindowRow[];
  /** One line when the provider retired a window (Claude's lifted 5-hour limit). */
  note: string | null;
}

const PROVIDER_RANK: Record<AccountProvider, number> = { claude: 0, codex: 1, grok: 2 };

/** One row per account, Claude → Codex → Grok, ties on label. Windows keep wire order. */
export function rowsFromAccounts(snapshot: AccountsSnapshot | null): UsageRow[] {
  if (!snapshot) return [];
  return snapshot.accounts
    .map((account) => ({
      id: account.id,
      label: account.label,
      provider: account.provider,
      state: account.state,
      reason: account.reason,
      windows: visibleWindows(account.provider, account.windows).map((w) => ({
        label: w.label ?? w.id,
        usedPercent: w.usedPercent,
        resetsAt: w.resetsAt,
        resetDescription: w.resetDescription,
        limitReached: w.limitReached,
        measured: w.measured,
      })),
      note: windowNote(account.provider),
    }))
    .sort((a, b) => PROVIDER_RANK[a.provider] - PROVIDER_RANK[b.provider] || a.label.localeCompare(b.label));
}

// ---------------------------------------------------------------------------
// Live fleet snapshot (GET /api/verse/fleet/runs), structurally narrowed
// ---------------------------------------------------------------------------

const record = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const str = (r: Record<string, unknown>, key: string): string | null =>
  typeof r[key] === 'string' && (r[key] as string).length > 0 ? (r[key] as string) : null;
const num = (r: Record<string, unknown>, key: string): number | null =>
  typeof r[key] === 'number' && Number.isFinite(r[key] as number) ? (r[key] as number) : null;

export interface CodexPersonalRow {
  usedPct: number | null;
  resetsAt: string | null;
  asOf: string | null;
}

/** The fleet snapshot's own Codex personal reading, or null when the snapshot does not carry one. */
export function codexPersonalRow(runs: unknown): CodexPersonalRow | null {
  const data = record(runs);
  const personal = data ? record(data['codexPersonal']) : null;
  if (!personal) return null;
  return { usedPct: num(personal, 'usedPct'), resetsAt: str(personal, 'resetsAt'), asOf: str(personal, 'asOf') };
}

export interface LaneTokenRow {
  lane: string;
  running: number | null;
  target: number | null;
  tokensLastHour: number | null;
}

/** Tokens burned per lane, busiest first; lanes without a reading sink to the bottom, order kept. */
export function laneTokens(runs: unknown): LaneTokenRow[] {
  const data = record(runs);
  const lanes = data && Array.isArray(data['lanes']) ? (data['lanes'] as unknown[]) : [];
  return lanes
    .flatMap((entry) => {
      const lane = record(entry);
      if (lane === null) return [];
      const name = str(lane, 'lane');
      if (name === null) return [];
      return [{ lane: name, running: num(lane, 'running'), target: num(lane, 'target'), tokensLastHour: num(lane, 'tokensLastHour') }];
    })
    .sort((a, b) => {
      if (a.tokensLastHour === null) return b.tokensLastHour === null ? 0 : 1;
      if (b.tokensLastHour === null) return -1;
      return b.tokensLastHour - a.tokensLastHour;
    });
}

/** The `sources` entries this pane actually reads, named when they stop being healthy. */
const PANE_SOURCES = ['runsDir', 'codex'] as const;

export function degradedSources(runs: unknown): string[] {
  const data = record(runs);
  const sources = data ? record(data['sources']) : null;
  if (!sources) return [];
  return PANE_SOURCES.filter((name) => typeof sources[name] === 'string' && sources[name] !== 'healthy');
}

// ---------------------------------------------------------------------------
// Reset countdown
// ---------------------------------------------------------------------------

/**
 * A machine-readable reset instant as a countdown ("resets in 2 h 10 m").
 * `—` when there is no instant or it does not parse; `reset` once the moment
 * has passed — the provider prose (Claude's) is handled elsewhere and never
 * reaches this function.
 */
export function formatReset(iso: string | null, nowMs: number): string {
  if (typeof iso !== 'string' || iso.length === 0) return '—';
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return '—';
  const remaining = at - nowMs;
  if (remaining <= 0) return 'reset';
  const minutes = Math.floor(remaining / 60_000);
  if (minutes < 1) return 'resets in <1 m';
  if (minutes < 60) return `resets in ${minutes} m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest === 0 ? `resets in ${hours} h` : `resets in ${hours} h ${rest} m`;
  }
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  return rest === 0 ? `resets in ${days} d` : `resets in ${days} d ${rest} h`;
}
