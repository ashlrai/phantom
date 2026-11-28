/**
 * routes/verse/usage/CapacityStrip.tsx — THE capacity view (SPEC-310C §4:
 * "Resources, NewChatDialog and onboarding drop their own capacity views and
 * import usage/CapacityStrip instead"). Apps & Accounts and Usage render it
 * too, so every surface answers "how much of each seat is left" the same way.
 *
 *   [C] Claude Max · max            ● connected                 [actions]
 *       usable · 40% of weekly window used
 *       weekly window  ▇▇▇░░░░░░░░│▨▨▨  40%   resets Thu
 *       Anthropic removed the 5-hour limit on this plan. Only the weekly
 *       window applies.
 *       Reserved for you 40% · Autonomy: Eligible
 *
 * Each bar is the shared usage-window bar (components/primitives/WindowBar,
 * the one the resource boards and the drawer's account cards draw): used
 * (solid), what autonomy may still use (track), and the band KEPT FOR YOU
 * (hatched) past a tick at 100 − reserve, so "Reserved for you 40%" is
 * something you can see, not just read. The reserve applies to the binding
 * window; the other windows carry no tick. Where the seat's reset provenance
 * holds the window's start, the full strip also marks how far the window's
 * time has run and says so under the bar; a window with no known start gets
 * no mark and no line.
 *
 * Honesty (docs/VERSE-TELEMETRY-V2.md), enforced by the model and kept here:
 *   - no reading, or a reading no longer current → a hatched track and the
 *     words ("no reading", "… · last"), never a 0% bar and no time mark;
 *   - a flagged limit → a full red bar and "limit reached", never "100%";
 *   - reset prose is printed verbatim, never turned into a countdown;
 *   - every state is a WORD first; colour only reinforces it.
 *
 * Three entry points:
 *   <CapacityStrip seats health? budget? …/>   pure: props in, markup out;
 *   <LiveCapacityStrip …/>                      reads the shared caches itself
 *                                               (bootstrap seats, /health,
 *                                               /budget) — drop-in for C1/C2;
 *   useCapacityRows()                           the rows, for a custom layout
 *                                               (the rail ring, the seat chip).
 */
import { useId, useMemo, type ReactNode } from 'react';
import type { BudgetView } from '../../../../core/routing/policy.js';
import type { SeatHealthReport } from '../../../../core/verse/health-types.js';
import type { VerseBootstrap, VerseSeat } from '../../../data/api-types.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { Tooltip } from '../../../components/primitives/Tooltip.js';
import { WindowBar, WindowBarSwatch } from '../../../components/primitives/WindowBar.js';
import { elapsedWords, leadWords, startClock, startWords, windowPace } from '../fleet-usage/window-pace-model.js';
import { MonogramTile } from '../apps/MonogramTile.js';
import { budgetQuery } from '../budget/budget-queries.js';
import { useSeatHealth } from '../health/useSeatHealth.js';
import { usePollWhileVisible, useSectionVisible } from '../shell/section-visibility.js';
import { useSeatsRefresh } from '../useSeatsRefresh.js';
import { nativeCreditBalanceTitle } from '../resources/codex-credit-value.js';
import { claudeQuotaDiagnostic } from './accounts-model.js';
import { verseBootstrapQuery } from '../verse-queries.js';
import {
  accountStatus,
  buildCapacityRows,
  capacityHeadline,
  capacityTone,
  orderAccountRows,
  percentText,
  windowSentence,
  type AccountStatus,
  type CapacityInputs,
  type CapacityRow,
  type CapacityWindowRow,
} from './capacity-strip-model.js';
import styles from './CapacityStrip.module.css';

/** At this share of a window the figure beside the bar turns amber (the word "tight" rides with it); the bar never does. */
const TIGHT_AT = 90;

/** How often an accounts strip re-reads the clock ("usable again in 7h", "checked 2m ago"). */
export { ACCOUNT_CLOCK_MS, useCapacityClock } from '../seat-subscription.js';
import { useCapacityClock } from '../seat-subscription.js';

/**
 * Apps & Accounts mode: every row leads with a sentence-case status
 * ("Connected · usable now", "Spent · resets Fri 11:46 PM", "Signed out ·
 * reconnect to use it", "Checking…"), says when it was last checked and — for
 * a spent seat — when it is usable again, and usable rows come first.
 */
export interface CapacityAccountsMode {
  /** False until the health sweep has answered once. */
  healthRead: boolean;
  /** The seat whose check is running now (its row reads "Checking…"). */
  checkingSeatId?: string | null;
  /** Injected clock for tests; otherwise the strip ticks every ACCOUNT_CLOCK_MS while visible. */
  now?: number;
}

export interface CapacityStripProps {
  seats: readonly VerseSeat[];
  health?: readonly SeatHealthReport[] | null;
  budget?: BudgetView | null;
  local?: CapacityInputs['local'];
  seatIds?: readonly string[];
  /** full: every window with resets and the reserve; compact: one line per seat (pickers, side panels). */
  density?: 'full' | 'compact';
  /** Show the one-sentence summary above the rows. Default true for full, false for compact. */
  headline?: boolean;
  /** Heading for assistive tech (visually hidden). */
  title?: string;
  /**
   * The id of a heading that already names this strip (Apps' "Accounts"
   * group). The strip then labels itself by it instead of adding a second,
   * hidden heading — two regions with one name is noise to a screen reader.
   */
  labelledBy?: string;
  /** Per-seat trailing controls (Apps passes Reconnect / Fix / Edit budget). */
  renderActions?: (row: CapacityRow) => ReactNode;
  /** Makes each seat name a toggle (Usage opens the account's detail). */
  onSelectSeat?: (seatId: string) => void;
  selectedSeatId?: string | null;
  /** Shown instead of rows when the roster is empty. */
  emptyText?: string;
  /** Apps & Accounts: a status per row, when it was checked, usable rows first. */
  accounts?: CapacityAccountsMode;
}

function pct(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

function WindowLine({
  row,
  w,
  reservePercent,
  compact,
  now,
}: {
  row: CapacityRow;
  w: CapacityWindowRow;
  reservePercent: number | null;
  compact: boolean;
  now: number;
}) {
  const sentence = windowSentence(row, w, w.binding ? reservePercent : null);
  // The meter is named for whose window it is; the rest of the sentence is its value.
  const head = `${row.label} ${w.label}`;
  const said = sentence.startsWith(`${head}: `) ? sentence.slice(head.length + 2) : sentence;
  const current = row.quotaCurrent !== false;
  let level: 'ok' | 'tight' | 'limit' | 'unknown';
  let value: string;
  // Null draws the hatched track: no reading, or one that is no longer current. Never a 0% bar.
  let used: number | null = null;
  if (!current) {
    level = 'unknown';
    value = `${w.limitReached ? 'limit was flagged' : w.usedPercent === null ? 'usage unknown' : `${percentText(w.usedPercent)} used`} · last`;
  } else if (w.limitReached) {
    level = 'limit';
    value = 'limit reached';
    used = 100;
  } else if (w.usedPercent === null) {
    level = 'unknown';
    value = 'no reading';
  } else {
    used = pct(w.usedPercent);
    level = used >= TIGHT_AT ? 'tight' : 'ok';
    value = percentText(w.usedPercent);
  }
  // The reserve is drawn against a measured share only: a flagged limit has no share to hold it against.
  const kept = level !== 'limit' && used !== null && w.binding && reservePercent !== null && reservePercent > 0 ? pct(reservePercent) : null;
  // Time gone is read only on the full strip and only against a current reading: a retained one may describe
  // an earlier window. No known start means no pace at all.
  const pace = !compact && current
    ? windowPace({ usedPercent: w.usedPercent, resetsAt: w.resetsAt, limitReached: w.limitReached, measured: w.usedPercent !== null, period: w.period }, now)
    : null;
  return (
    <div className={styles.bar} data-binding={w.binding || undefined} data-compact={compact || undefined}>
      <Tooltip label={w.label} placement="top"><span className={styles.barLabel} tabIndex={0}>{w.label.replace(/ window$/, '')}</span></Tooltip>
      <WindowBar className={styles.track} label={head} valueText={pace ? `${said}, ${elapsedWords(pace)}` : said} valueNow={level === 'limit' ? null : used}
        used={used} kept={kept} elapsed={pace?.elapsedPct ?? null} ending={level === 'limit' ? 'spent' : undefined} />
      <span className={styles.value} data-level={level}>{value}</span>
      {!compact && current && w.resetText !== null ? <Tooltip label={w.resetText} placement="top"><span className={styles.reset} tabIndex={0}>{w.resetText}</span></Tooltip> : null}
      {pace !== null ? (
        <span className={styles.pace} data-pace={pace.lead === null ? 'unread' : pace.lead < 0 ? 'behind' : pace.lead > 0 ? 'ahead' : 'level'}>
          {used !== null ? <WindowBarSwatch part="elapsed" /> : null}
          {[elapsedWords(pace), leadWords(pace), startWords(pace, startClock(now))].filter(Boolean).join(' · ')}
        </span>
      ) : null}
    </div>
  );
}

function SeatName({ row, onSelect, selected }: { row: CapacityRow; onSelect: ((id: string) => void) | undefined; selected: boolean }) {
  const text = (
    <>
      <span className={styles.name}>{row.label}</span>
      {row.plan !== null ? <span className={styles.plan}>{row.plan}</span> : null}
    </>
  );
  // A control only when there is something for it to open.
  if (!onSelect) return <span className={styles.nameWrap}>{text}</span>;
  return (
    <button type="button" className={styles.nameButton} aria-pressed={selected} onClick={() => onSelect(row.seatId)}>
      {text}
    </button>
  );
}

function StatusLine({ status }: { status: AccountStatus }) {
  return (
    <span className={styles.status} data-tone={status.tone} data-status={status.kind}>
      <span className={styles.dot} aria-hidden="true" />
      <span className={styles.statusLabel}>{status.label}</span>
      {status.detail !== null ? <span className={styles.statusDetail}>{`· ${status.detail}`}</span> : null}
    </span>
  );
}

/** "usable again in 7h 12m · checked 2m ago" — the row's clock facts, when it has any. */
function StampLine({ status }: { status: AccountStatus }) {
  if (status.usableAgain === null && status.checked === null) return null;
  return (
    <p className={styles.stamp}>
      {status.usableAgain !== null ? <span className={styles.usableAgain}>{status.usableAgain}</span> : null}
      {status.usableAgain !== null && status.checked !== null ? ' · ' : null}
      {status.checked !== null ? <span title={status.checkedTitle ?? undefined}>{status.checked}</span> : null}
    </p>
  );
}

function CapacityRowView({
  row,
  compact,
  renderActions,
  onSelectSeat,
  selected,
  status,
  now,
}: {
  row: CapacityRow;
  compact: boolean;
  renderActions: CapacityStripProps['renderActions'];
  onSelectSeat: CapacityStripProps['onSelectSeat'];
  selected: boolean;
  status: AccountStatus | null;
  now: number;
}) {
  const tone = capacityTone(row.cls);
  const binding = row.windows.find((w) => w.binding) ?? null;
  const windows = compact ? (binding ? [binding] : []) : row.windows;
  const actions = renderActions ? renderActions(row) : null;
  const reserve = row.reserve;
  const quotaDiagnostic = status !== null && windows.length === 0 ? claudeQuotaDiagnostic(row.quotaReadReason) : null;
  return (
    <li className={styles.row} data-capacity={row.cls} data-compact={compact || undefined} data-status={status?.kind}>
      <MonogramTile monogram={row.monogram} engine={row.engine} size="sm" />
      <div className={styles.main}>
        <div className={styles.head}>
          <SeatName row={row} onSelect={onSelectSeat} selected={selected} />
          {status !== null ? (
            <StatusLine status={status} />
          ) : (
            <span className={styles.word} data-tone={tone}>
              <span className={styles.dot} aria-hidden="true" />
              {row.word}
            </span>
          )}
          {row.connection !== null && row.connection.connection !== 'connected' && row.connection.connection !== 'unknown'
            && !(status?.coversConnection ?? false) && !(status?.kind === 'signed-out') ? (
            <span className={styles.word} data-tone={row.connection.tone}>
              <span className={styles.dot} aria-hidden="true" />
              {row.connection.word}
            </span>
          ) : null}
        </div>
        {!compact || windows.length === 0 ? <p className={styles.summary}>{row.summary}</p> : null}
        {quotaDiagnostic ? <p className={styles.summary}>Claude quota check: {quotaDiagnostic.sentence} <code>{quotaDiagnostic.code}</code></p> : null}
        {status !== null && !compact ? <StampLine status={status} /> : null}
        {windows.length > 0 ? (
          <div className={styles.bars}>
            {windows.map((w) => (
              <WindowLine key={w.id} row={row} w={w} reservePercent={reserve?.percent ?? null} compact={compact} now={now} />
            ))}
          </div>
        ) : null}
        {!compact && (reserve !== null || row.credits !== null) ? (
          <p className={styles.meta}>
            {reserve !== null ? (
              <Tooltip label={reserve.why} placement="top"><span tabIndex={0}>
                {reserve.label}
                {/* "Autonomy off — all yours" already says it; no second "Off". */}
                {reserve.autonomy === 'off' ? null : (
                  <> · Autonomy: <span className={styles.autonomy} data-status={reserve.autonomy}>{reserve.autonomyWord}</span></>
                )}
              </span></Tooltip>
            ) : null}
            {reserve !== null && row.credits !== null ? ' · ' : null}
            {row.credits !== null ? <Tooltip content={nativeCreditBalanceTitle(row.creditBalance)} placement="top"><span tabIndex={nativeCreditBalanceTitle(row.creditBalance) === null ? undefined : 0}>{row.credits}</span></Tooltip> : null}
          </p>
        ) : null}
      </div>
      {actions ? <div className={styles.actions}>{actions}</div> : null}
    </li>
  );
}

export function CapacityStrip({
  seats,
  health,
  budget,
  local,
  seatIds,
  density = 'full',
  headline,
  title = 'Seat capacity',
  labelledBy,
  renderActions,
  onSelectSeat,
  selectedSeatId = null,
  emptyText = 'No seats yet. Connect an account or start Ollama.',
  accounts,
}: CapacityStripProps) {
  const headingId = useId();
  const now = useCapacityClock(accounts?.now, seats.map(seat => seat.capacity));
  const healthRead = accounts?.healthRead ?? false;
  const accountsMode = accounts !== undefined;
  // Accounts mode words every window reset and reason against the SAME clock
  // as its status line ("Spent · resets Sat 11:46 PM"), so the two never
  // disagree about which day "today" is.
  // Every layout expires current evidence even when its cached seats do not change.
  const rowsNow = now;
  const built = useMemo(
    () => buildCapacityRows(seats, {
      health: health ?? null,
      budget: budget ?? null,
      ...(local ? { local } : {}),
      ...(seatIds ? { seatIds } : {}),
      ...(rowsNow !== undefined ? { now: rowsNow } : {}),
    }),
    [seats, health, budget, local, seatIds, rowsNow],
  );
  const rows = useMemo(
    () => (accountsMode ? orderAccountRows(built, { healthRead, now }) : built),
    [built, accountsMode, healthRead, now],
  );
  const compact = density === 'compact';
  const showHeadline = headline ?? !compact;
  // Named by the caller's heading: a plain block inside the caller's region,
  // not a second region with the same name.
  const Wrapper = labelledBy ? 'div' : 'section';
  return (
    <Wrapper className={styles.strip} aria-labelledby={labelledBy ? undefined : headingId} data-density={density}>
      {labelledBy ? null : <h3 id={headingId} className={styles.visuallyHidden}>{title}</h3>}
      {showHeadline && rows.length > 0 ? <p className={styles.headline}>{capacityHeadline(rows)}</p> : null}
      {rows.length === 0 ? (
        <p className={styles.empty}>{emptyText}</p>
      ) : (
        <ul className={styles.rows} aria-label={labelledBy ? undefined : title} aria-labelledby={labelledBy}>
          {rows.map((row) => (
            <CapacityRowView
              key={row.seatId}
              row={row}
              compact={compact}
              renderActions={renderActions}
              onSelectSeat={onSelectSeat}
              selected={selectedSeatId === row.seatId}
              now={now}
              status={accounts
                ? accountStatus(row, { healthRead, now, checking: accounts.checkingSeatId === row.seatId })
                : null}
            />
          ))}
        </ul>
      )}
    </Wrapper>
  );
}

// ---------------------------------------------------------------------------
// Live data
// ---------------------------------------------------------------------------

/** Budget moves with the collector (30 s); a minute is plenty for a strip. */
export const CAPACITY_BUDGET_POLL_MS = 60_000;

export interface CapacityData {
  seats: readonly VerseSeat[];
  health: readonly SeatHealthReport[] | null;
  budget: BudgetView | null;
  /** True until the seat roster has been read once. */
  loading: boolean;
  /** Cached values remain visible while independent shared reads update. */
  refreshing: boolean;
  readFailed: boolean;
  /** Roster/health failed; an unrelated budget error does not stale local readiness. */
  localReadFailed?: boolean;
  rosterUnavailable: boolean;
  pendingSeatIds: readonly string[];
}

/**
 * The three shared reads behind the strip, kept live while the surface is on
 * screen: seats (the /seats poll merged into bootstrap), A2's health (30 s)
 * and A9's budget (60 s). Each is the app-wide cache entry — mounting this
 * twice costs no extra request.
 */
export function useCapacityData(opts: { withBudget?: boolean; withHealth?: boolean } = {}): CapacityData {
  const visible = useSectionVisible();
  const withBudget = opts.withBudget ?? true;
  const withHealth = opts.withHealth ?? true;
  const bootstrap = useQuery(verseBootstrapQuery);
  useSeatsRefresh(visible);
  const health = useSeatHealth(visible && withHealth);
  const budget = useQuery(budgetQuery, { enabled: withBudget });
  const refetchBudget = useRefetch(budgetQuery);
  usePollWhileVisible(refetchBudget, CAPACITY_BUDGET_POLL_MS, { enabled: withBudget });
  const data = bootstrap.data as VerseBootstrap | undefined;
  return {
    seats: data?.seats ?? [],
    health: withHealth ? (health.data?.seats ?? null) : null,
    budget: withBudget ? (budget.data ?? null) : null,
    loading: data === undefined && (bootstrap.status === 'loading' || bootstrap.status === 'idle'),
    refreshing: data?.accountTelemetry?.refreshing === true || bootstrap.status === 'refreshing' || (withHealth && health.status === 'refreshing') || (withBudget && budget.status === 'refreshing'),
    localReadFailed: bootstrap.error !== undefined || bootstrap.status === 'error' || (withHealth && (health.error !== undefined || health.status === 'error')),
    readFailed: bootstrap.status === 'error' || (withHealth && health.status === 'error') || (withBudget && budget.status === 'error'),
    rosterUnavailable: data === undefined && bootstrap.status === 'error',
    pendingSeatIds: Array.isArray(data?.accountTelemetry?.pendingAccountIds) ? data.accountTelemetry.pendingAccountIds : [],
  };
}

/** The rows for a custom layout (the rail's capacity ring, the composer's seat chip). */
export function useCapacityRows(inputs: Omit<CapacityInputs, 'health' | 'budget'> = {}): CapacityRow[] {
  const data = useCapacityData();
  const now = useCapacityClock(inputs.now, data.seats.map(seat => seat.capacity));
  return useMemo(
    () => buildCapacityRows(data.seats, { health: data.health, budget: data.budget, ...inputs, now }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- inputs is a small literal; its fields are the identity.
    [data.seats, data.health, data.budget, inputs.local, inputs.seatIds, now],
  );
}

export interface LiveCapacityStripProps extends Omit<CapacityStripProps, 'seats' | 'health' | 'budget'> {
  /**
   * The roster, when the caller already holds it (the new-chat dialog, whose
   * seat list IS this roster and whose pre-fill works from its own props).
   * The strip then adds only health and budget, and never shows "Reading
   * seats…" over a roster that is already on screen.
   */
  seats?: readonly VerseSeat[];
}

/** Drop-in strip that reads its own data — what NewChatDialog and onboarding mount. */
export function LiveCapacityStrip({ seats: given, ...props }: LiveCapacityStripProps) {
  const data = useCapacityData();
  if (given === undefined && data.loading) {
    return <p className={styles.empty} aria-busy="true">Reading seats…</p>;
  }
  return <CapacityStrip {...props} seats={given ?? data.seats} health={data.health} budget={data.budget} />;
}
