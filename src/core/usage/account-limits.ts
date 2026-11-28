/**
 * core/usage/account-limits.ts — where every provider account stands against
 * its limits: the one summary behind both `phm usage limits` and the console's
 * Usage board, so the two cannot disagree.
 *
 * Pure: no I/O. It reads the account records `GET /api/verse/accounts` serves
 * (buildVerseAccountsSnapshot) and adds a standing per account, the counts,
 * a headline and the next reset. A value the records do not hold stays null
 * and prints as "unknown", never 0.
 */
import { visibleWindows } from './provider-windows.js';

const USAGE_LIMITS_SCHEMA = 'usage.limits.v1' as const;

type AccountState = 'checking' | 'observed' | 'signed-out' | 'unavailable';

/** Where one account stands, from its state and the windows the provider reported. */
export type AccountStanding = 'limit' | 'unread' | 'checking' | 'no-reading' | 'read';

interface WindowFacts { usedPercent: number | null; resetsAt: string | null; limitReached: boolean; measured: boolean }
interface StandingInput { state: AccountState; windows: readonly WindowFacts[] }

export function accountStanding(row: StandingInput): AccountStanding {
  if (row.state === 'checking') return 'checking';
  if (row.state !== 'observed') return 'unread';
  // A provider flag, never inferred from a 100% reading: credits can keep such an account usable.
  if (row.windows.some((w) => w.limitReached)) return 'limit';
  return row.windows.some((w) => w.measured && w.usedPercent !== null) ? 'read' : 'no-reading';
}

export function standingCounts(rows: readonly StandingInput[]): Record<AccountStanding, number> {
  const n: Record<AccountStanding, number> = { limit: 0, unread: 0, checking: 0, 'no-reading': 0, read: 0 };
  for (const row of rows) n[accountStanding(row)] += 1;
  return n;
}

/** One sentence over the accounts; null when there are none to count. */
export function usageHeadline(rows: readonly StandingInput[]): string | null {
  if (rows.length === 0) return null;
  const n = standingCounts(rows);
  const parts = [
    n.limit > 0 ? `${n.limit} flagged at a limit` : '',
    n.unread > 0 ? `${n.unread} not readable` : '',
    n.checking > 0 ? `${n.checking} still checking` : '',
    n['no-reading'] > 0 ? `${n['no-reading']} with no reading` : '',
  ].filter(Boolean);
  const noun = rows.length === 1 ? '1 account' : `${rows.length} accounts`;
  return parts.length === 0 ? `${noun} read, none flagged at a limit.` : `${noun}: ${parts.join(', ')}.`;
}

export interface NextReset { account: string; window: string; resetsAt: string }

/** The soonest machine-readable reset still ahead. Prose-only resets (Claude's) carry no instant and are skipped. */
export function nextAccountReset(
  rows: readonly { label: string; state: AccountState; windows: readonly (WindowFacts & { label: string })[] }[],
  nowMs: number,
): NextReset | null {
  let next: (NextReset & { at: number }) | null = null;
  for (const row of rows) {
    if (row.state !== 'observed') continue;
    for (const w of row.windows) {
      const at = w.resetsAt === null ? NaN : Date.parse(w.resetsAt);
      if (!Number.isFinite(at) || at <= nowMs) continue;
      if (next === null || at < next.at) next = { account: row.label, window: w.label, resetsAt: w.resetsAt as string, at };
    }
  }
  return next === null ? null : { account: next.account, window: next.window, resetsAt: next.resetsAt };
}

// ---------------------------------------------------------------------------
// The report (`phm usage limits --json`)
// ---------------------------------------------------------------------------

/** The fields of the accounts snapshot this report reads; VerseAccountsSnapshot satisfies it. */
export interface AccountLimitsSource {
  sampledAt: string;
  evidenceSource: string;
  collector: { mode: string; state: string };
  accounts: readonly {
    id: string; label: string; provider: string; planType: string | null; state: AccountState;
    reason: string; observedAt: string | null;
    windows: readonly (WindowFacts & { id: string; nativeReport: { resetDescription: string | null } | null })[];
  }[];
}

export interface AccountLimitsWindow extends WindowFacts {
  id: string;
  label: string;
  /** The provider's own reset sentence (Claude), verbatim; null when it gave none. */
  resetDescription: string | null;
}

export interface AccountLimitsRow {
  id: string; label: string; provider: string; planType: string | null;
  state: AccountState; standing: AccountStanding;
  /** The probe's machine-readable reason, verbatim; null when it gave none. */
  reason: string | null;
  observedAt: string | null;
  windows: AccountLimitsWindow[];
}

export interface AccountLimitsReport {
  schema: typeof USAGE_LIMITS_SCHEMA;
  generatedAt: string;
  sampledAt: string;
  /** Where the windows came from: collector, shared-evidence, baseline or none. */
  evidenceSource: string;
  collector: { mode: string; state: string };
  counts: Record<AccountStanding, number>;
  headline: string | null;
  nextReset: NextReset | null;
  accounts: AccountLimitsRow[];
}

export function accountLimitsReport(source: AccountLimitsSource, nowMs: number): AccountLimitsReport {
  const accounts: AccountLimitsRow[] = source.accounts.map((account) => {
    // Claude's retired 5-hour window is dropped here exactly as the console drops it.
    const windows = visibleWindows(account.provider, account.windows).map((w) => ({
      id: w.id, label: w.id, usedPercent: w.usedPercent, resetsAt: w.resetsAt,
      resetDescription: w.nativeReport?.resetDescription ?? null, limitReached: w.limitReached, measured: w.measured,
    }));
    return {
      id: account.id, label: account.label, provider: account.provider, planType: account.planType,
      state: account.state, standing: accountStanding({ state: account.state, windows }),
      reason: account.reason.length > 0 ? account.reason : null, observedAt: account.observedAt, windows,
    };
  });
  return {
    schema: USAGE_LIMITS_SCHEMA,
    generatedAt: new Date(nowMs).toISOString(),
    sampledAt: source.sampledAt,
    evidenceSource: source.evidenceSource,
    collector: { mode: source.collector.mode, state: source.collector.state },
    counts: standingCounts(accounts),
    headline: usageHeadline(accounts),
    nextReset: nextAccountReset(accounts, nowMs),
    accounts,
  };
}

const STANDING_WORD: Record<AccountStanding, string> = {
  limit: 'flagged at a limit', unread: 'not readable', checking: 'still checking', 'no-reading': 'no reading', read: 'read',
};

/** "in 2h 5m", "in 3d 4h", "in 12m"; null for a passed or unparseable instant. */
export function resetCountdown(iso: string | null, nowMs: number): string | null {
  const at = iso === null ? NaN : Date.parse(iso);
  if (!Number.isFinite(at) || at <= nowMs) return null;
  const minutes = Math.max(1, Math.round((at - nowMs) / 60_000));
  const d = Math.floor(minutes / 1440), h = Math.floor((minutes % 1440) / 60), m = minutes % 60;
  return `in ${d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`}`;
}

function windowLine(w: AccountLimitsWindow, nowMs: number): string {
  const used = w.limitReached ? 'limit reached' : w.measured && w.usedPercent !== null ? `${w.usedPercent}% used` : 'usage unknown';
  const countdown = resetCountdown(w.resetsAt, nowMs);
  const reset = w.resetDescription ?? (w.resetsAt === null ? 'reset unknown' : `resets ${w.resetsAt}${countdown === null ? ' (passed)' : ` (${countdown})`}`);
  return `  ${w.label}: ${used}, ${reset}`;
}

/** The plain-text form of the report, one line per account window. */
export function accountLimitsText(report: AccountLimitsReport, nowMs: number): string[] {
  const next = report.nextReset;
  const lines = [
    `Provider accounts: ${report.headline ?? 'none enrolled.'}`,
    next === null
      ? 'Next reset: no account gave one as a date and time.'
      : `Next reset: ${next.account}, ${next.window}, ${next.resetsAt} (${resetCountdown(next.resetsAt, nowMs) ?? 'passed'}).`,
    `Read from: ${report.evidenceSource} (collector ${report.collector.mode}, ${report.collector.state}), sampled ${report.sampledAt}.`,
  ];
  for (const account of report.accounts) {
    const plan = account.planType === null ? '' : `, ${account.planType}`;
    const why = account.standing === 'unread' || account.standing === 'checking' ? ` (${account.state}${account.reason === null ? '' : `: ${account.reason}`})` : '';
    lines.push('', `${account.label} (${account.provider}${plan}): ${STANDING_WORD[account.standing]}${why}`);
    if (account.windows.length === 0) lines.push('  no windows reported');
    for (const w of account.windows) lines.push(windowLine(w, nowMs));
    if (account.standing !== 'unread' && account.standing !== 'checking') lines.push(`  read ${account.observedAt ?? 'at an unknown time'}`);
  }
  return lines;
}
