/**
 * routes/verse/fleet-usage/FleetUsagePane.tsx — the dock Usage pane.
 *
 * A board of provider accounts (Claude, Codex, Grok): a headline counting
 * where they stand, the next reset, then one card per account with its brand
 * mark, plan and exactly the windows the provider reported, each reset as a
 * countdown and a local time (and, above the cards, every dated reset on one
 * line of time) — minus Claude's retired 5-hour window,
 * which Anthropic lifted; the row carries one note saying the weekly window
 * is the whole story — plus the fleet snapshot's own Codex personal figure
 * and a tokens-per-lane table. Accounts and the zero-waste meter audit poll
 * every 60 s and the live fleet snapshot every 10 s, only while the pane is
 * on top; unavailable reads degrade to notices.
 */
import { useMemo, useState, type CSSProperties } from 'react';
import { resolveBrand } from '../../../../core/brand/registry.js';
import { BrandMark } from '../../../components/primitives/BrandMark.js';
import { formatDecimalMetric, formatMetric } from '../../../components/charts/format-metric.js';
import { copyText } from '../../../components/primitives/clipboard.js';
import { Button, SkeletonLine, WindowBar, WindowBarSwatch } from '../../../components/primitives/index.js';
import { auditHeadline, auditRows } from './usage-audit-model.js';
import { usageAuditQuery } from './usage-audit-queries.js';
import { ApiError, readFailureReason } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { formatRelative } from '../autonomy/format.js';
import { formatTokens } from '../fleet-lanes/fleet-lanes-model.js';
import { openInterjectDialog } from '../fleet/interject-dialog-store.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { usedPercentText } from '../percent-text.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { creditsSpendable } from '../usage/accounts-model.js';
import { projectAccountsSnapshot, type AccountCredits } from '../usage/usage-contract.js';
import { verseAccountsQuery } from '../usage/usage-queries.js';
import { fleetUsageRunsQuery } from './fleet-usage-queries.js';
import { auditSteerPrefill, auditSteerVisible } from './audit-steer-prefill.js';
import { claudeIdle } from './claude-idle-model.js';
import {
  codexPersonalRow,
  degradedSources,
  formatReset,
  laneTokens,
  personalCodexAccount,
  personalDisagreement,
  rowsFromAccounts,
  type UsageRow,
  type UsageWindowRow,
} from './usage-pane-model.js';
import { ObserveSlice } from '../fleet-observe/ObserveFacts.js';
import { spendDown, type SpendDownItem } from './spend-down-model.js';
import { accountStanding, laneSharePct, laneTotals, nextAccountReset, resetLocalTime, usageHeadline } from './usage-board-model.js';
import { ResetTimeline } from './ResetTimeline.js';
import { resetTimeline } from './reset-timeline-model.js';
import { elapsedWords, leadWords, startWords, windowPace } from './window-pace-model.js';
import styles from './fleet-usage.module.css';
import compact from '../../../components/layout/compact-view.module.css';

const ACCOUNTS_POLL_MS = 60_000;
const RUNS_POLL_MS = 10_000;

const STATE_WORD: Record<UsageRow['state'], string> = {
  checking: 'checking…',
  observed: '',
  'signed-out': 'signed out',
  unavailable: 'unavailable',
};

const sampledTime = (iso: string | null): string | null => {
  const ms = iso === null ? NaN : Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : null;
};

const SPEND_DOWN_MAX_SHOWN = 4;

/** One strip above the account rows: windows that will reset with usage unspent, or one muted all-clear line. */
function SpendDownStrip({ items, nowMs }: { items: SpendDownItem[]; nowMs: number }) {
  if (items.length === 0) return null;
  const risks = items.filter((item) => item.level === 'waste-risk');
  if (risks.length === 0) return <p className={styles.message}>All measured windows are on track to be used.</p>;
  const shown = risks.slice(0, SPEND_DOWN_MAX_SHOWN).map(
    (item) => `${item.accountLabel} (${item.windowLabel}) ${usedPercentText(item.leftPercent)} left, ${formatReset(item.resetsAt, nowMs)}`,
  );
  if (risks.length > shown.length) shown.push(`+${risks.length - shown.length} more`);
  return <p className={styles.spendDown} role="status">Spend before reset: {shown.join(' · ')}</p>;
}

/** A window's start as a local clock time: the weekday inside six days, the date beyond. */
const startTime = (nowMs: number) => (iso: string): string => new Date(iso).toLocaleString(undefined, nowMs - Date.parse(iso) < 6 * 86_400_000
  ? { weekday: 'short', hour: 'numeric', minute: '2-digit' } : { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/**
 * One provider-reported window as the shared WindowBar. A flagged limit is a
 * flag, not a measurement: it renders a full danger bar labelled "limit
 * reached" and announces no percentage — the same rule the Usage section's
 * WindowMeter follows. An unmeasured reading is a hatched track and "—",
 * never an empty bar that could be misread as nothing used. A reset the
 * provider gave as an instant also shows as a local clock time. Where the
 * accounts read holds the window's start, a mark on the bar shows how much
 * of its time has gone and a line under it says how far use sits from an
 * even spend (window-pace-model); use is never coloured by how high it is.
 */
function WindowMeter({ account, window: w, nowMs }: { account: string; window: UsageWindowRow; nowMs: number }) {
  const name = `${account} ${w.label}`;
  const reset = w.resetDescription ?? formatReset(w.resetsAt, nowMs);
  const pct = w.measured ? w.usedPercent : null;
  const value = w.limitReached ? 'limit reached' : usedPercentText(pct);
  const resetAt = w.resetDescription === null ? resetLocalTime(w.resetsAt, nowMs) : null;
  const pace = windowPace(w, nowMs);
  const lead = pace ? leadWords(pace) : null;
  return (
    <li className={styles.window}>
      <span className={styles.windowLabel}>{w.label}</span>
      {w.limitReached ? (
        <span
          className={styles.track}
          role="img"
          aria-label={`${name}: the provider flagged this window as rate-limited, so no percentage is shown`}
        >
          <span className={styles.fill} style={{ width: '100%' }} />
        </span>
      ) : (
        <div className={styles.bar}>
          <WindowBar label={`${name} used`} valueNow={pct} used={pct} elapsed={pace?.elapsedPct ?? null}
            valueText={pct === null ? 'unknown' : `${usedPercentText(pct)} used${pace ? `, ${elapsedWords(pace)}` : ''}`} />
        </div>
      )}
      <span className={w.limitReached ? styles.flag : styles.pct}>{value}</span>
      <span className={styles.reset}>
        {reset}
        {resetAt !== null && w.resetsAt !== null ? <time className={styles.resetAt} dateTime={w.resetsAt}>{resetAt}</time> : null}
      </span>
      {pace !== null && (
        <span className={styles.pace} data-pace={pace.lead === null ? 'unread' : pace.lead < 0 ? 'behind' : pace.lead > 0 ? 'ahead' : 'level'}>
          {[elapsedWords(pace), lead, startWords(pace, startTime(nowMs))].filter(Boolean).join(' · ')}
        </span>
      )}
    </li>
  );
}

/** The balance figure, mirroring the Usage section's CreditsRow derivation. */
function creditBalanceText(credits: AccountCredits): string {
  if (credits.unlimited) return 'unlimited';
  if (credits.balance === null) return 'not reported';
  return credits.balanceValue !== null
    ? formatDecimalMetric(credits.balance) ?? formatMetric(credits.balanceValue)
    : formatDecimalMetric(credits.balance) ?? credits.balance;
}

/**
 * What the balance means for usability, in one clause. The
 * usable-past-the-limit fact is claimed only when the provider's own fields
 * support it (creditsSpendable) — a held spend control or a balance that is
 * not spendable gets the honest sentence instead.
 */
function creditUsabilityNote(credits: AccountCredits): string {
  if (credits.spendControlReached === true) return 'the provider reports credit spending held';
  if (!creditsSpendable(credits)) return 'no spendable credit balance is reported';
  if (credits.spendControlReached !== false) return 'credit spending control is unconfirmed';
  return 'credits keep this account usable past the weekly limit';
}

/**
 * The account facts the meters cannot say: how old the reading is, whether
 * credits keep the account usable past the weekly limit, and the server's
 * sanitized reconnect command as a copy action. Null when the wire carries
 * none of them, so a fact-less row is exactly the one this pane has always
 * rendered.
 */
function AccountFacts({ row, nowMs }: { row: UsageRow; nowMs: number }) {
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle');
  const observedAt = row.observedAt ?? null;
  const credits = row.credits ?? null;
  const reconnectCommand = row.reconnectCommand ?? null;
  if (observedAt === null && credits === null && reconnectCommand === null) return null;
  return (
    <>
      {observedAt !== null && (
        <li className={styles.asOf}>
          <time dateTime={observedAt}>as of {formatRelative(observedAt, nowMs)}</time>
        </li>
      )}
      {credits !== null && (
        <li className={styles.asOf}>credits: {creditBalanceText(credits)} — {creditUsabilityNote(credits)}</li>
      )}
      {reconnectCommand !== null && (
        <li className={styles.asOf}>
          <Button
            variant="subtle"
            size="sm"
            title={reconnectCommand}
            onClick={() => void copyText(reconnectCommand).then((ok) => setCopied(ok ? 'copied' : 'failed'))}
          >
            Copy reconnect command
          </Button>{' '}
          <span role="status">{copied === 'copied' ? 'Copied' : copied === 'failed' ? 'Copy failed' : ''}</span>
        </li>
      )}
    </>
  );
}

function AccountRow({ row, nowMs, incident }: { row: UsageRow; nowMs: number; incident: ReturnType<typeof claudeIdle> }) {
  const planType = row.planType ?? null;
  const hasFacts = row.observedAt != null || row.credits != null || row.reconnectCommand != null;
  const standing = accountStanding(row);
  return (
    <li className={styles.row} data-standing={standing}>
      <div className={styles.head}>
        <BrandMark brand={row.provider} size={16} />
        <span className={styles.account}>
          {row.label}
          {planType !== null ? ` · ${planType}` : ''}
        </span>
        {/* The state word sits by the name; the provider's own reason, when it gave one, goes below. */}
        {row.state !== 'observed' ? <span className={styles.tag} data-standing={standing}>{STATE_WORD[row.state]}</span> : null}
        {standing === 'no-reading' ? <span className={styles.tag} data-standing={standing}>no reading</span> : null}
      </div>
      {row.state !== 'observed' ? (
        <ul className={styles.windows}>
          {row.reason !== null ? <li className={styles.reason}>{row.reason}</li> : null}
          {row.note !== null ? <li className={styles.asOf}>{row.note}</li> : null}
          <AccountFacts row={row} nowMs={nowMs} />
          {incident && <li className={styles.incident} data-tone={incident.tone}><span className={styles.verdict}>Incident</span> {incident.text}</li>}
        </ul>
      ) : row.windows.length === 0 && row.note === null && !hasFacts && !incident ? (
        <span className={styles.reason}>—</span>
      ) : (
        <ul className={styles.windows}>
          {row.windows.map((w, i) => <WindowMeter key={`${w.label}:${i}`} account={row.label} window={w} nowMs={nowMs} />)}
          {row.windows.length === 0 && row.note === null ? <li className={styles.reason}>—</li> : null}
          {row.note !== null ? <li className={styles.asOf}>{row.note}</li> : null}
          <AccountFacts row={row} nowMs={nowMs} />
          {incident && <li className={styles.incident} data-tone={incident.tone}><span className={styles.verdict}>Incident</span> {incident.text}</li>}
        </ul>
      )}
    </li>
  );
}

export function FleetUsagePane({ visible }: PaneProps) {
  const auditRead = useQuery(usageAuditQuery, { enabled: visible, freshMs: 0 });
  const refetchAudit = useRefetch(usageAuditQuery);
  usePollWhileVisible(refetchAudit, 60_000, { enabled: visible });
  const accountsRead = useQuery(verseAccountsQuery, { enabled: visible, freshMs: 0 });
  const runsRead = useQuery(fleetUsageRunsQuery, { enabled: visible, freshMs: 0 });
  const refetchAccounts = useRefetch(verseAccountsQuery);
  const refetchRuns = useRefetch(fleetUsageRunsQuery);
  usePollWhileVisible(refetchAccounts, ACCOUNTS_POLL_MS, { enabled: visible });
  usePollWhileVisible(refetchRuns, RUNS_POLL_MS, { enabled: visible });

  const read = accountsRead.data;
  const snapshot = useMemo(() => (read?.available ? projectAccountsSnapshot(read.raw) : null), [read]);
  const rows = useMemo(() => rowsFromAccounts(snapshot), [snapshot]);
  const nowMs = Date.now();
  const spend = useMemo(() => spendDown(rows, nowMs), [rows, nowMs]);
  const personal = useMemo(() => codexPersonalRow(runsRead.data ?? null), [runsRead.data]);
  const lanes = useMemo(() => laneTokens(runsRead.data ?? null), [runsRead.data]);
  const degraded = useMemo(() => degradedSources(runsRead.data ?? null), [runsRead.data]);
  const runs = runsRead.data && typeof runsRead.data === 'object' && !Array.isArray(runsRead.data)
    ? runsRead.data as Record<string, unknown> : null;
  const disagreement = personalDisagreement(rows, personal, personalCodexAccount(snapshot?.accounts ?? [])?.observedAt ?? null, nowMs);

  const accountsMissing = read !== undefined && !read.available;
  const runsMissing = runsRead.data === null || (runsRead.error instanceof ApiError && runsRead.error.status === 404);
  const auditLanes = new Map(auditRead.data?.lanes.map(lane => [lane.lane, lane]));

  const headline = usageHeadline(rows);
  const next = nextAccountReset(rows, nowMs);
  const sampled = sampledTime(snapshot?.sampledAt ?? null);
  const totals = laneTotals(lanes);
  const resets = useMemo(() => resetTimeline(rows, personal, nowMs), [rows, personal, nowMs]);

  // The key under the cards is drawn only when some bar carries the time mark.
  const timed = rows.some((row) => row.state === 'observed' && row.windows.some((w) => !w.limitReached && w.measured && w.usedPercent !== null && windowPace(w, nowMs) !== null));
  const hasContent = rows.length > 0 || personal !== null || lanes.length > 0;
  const waiting = read === undefined || (runsRead.data === undefined && runsRead.error === undefined);

  return (
    <section className={`${styles.root} ${compact.view}`} aria-label="Usage">
      {accountsMissing && runsMissing && <p className={styles.message}>Usage not in this build</p>}
      {accountsMissing && <p className={styles.notice} role="status">{read.reason ?? 'Provider account usage is unavailable.'}</p>}
      {runsMissing && <p className={styles.notice} role="status">Live fleet usage is not in this build.</p>}
      {!runsMissing && runsRead.data === undefined && runsRead.status === 'error' && (
        <p className={styles.notice} role="status">Live fleet usage could not be read.</p>
      )}
      {degraded.length > 0 && <p className={styles.notice} role="status">{`Fleet sources degraded: ${degraded.join(', ')}.`}</p>}
      {snapshot?.collectorNote && <p className={styles.notice} role="status">{snapshot.collectorNote}</p>}
      {read?.available && snapshot === null && (
        <p className={styles.notice} role="status">Provider accounts answered in a shape this build cannot read.</p>
      )}

      {headline !== null && (
        <>
          <p className={styles.headline}>{headline}</p>
          <p className={styles.meta}>
            {next !== null
              ? `Next reset: ${next.account}, ${next.window}, ${formatReset(next.resetsAt, nowMs).replace(/^resets /, '')}.`
              : 'Next reset: no account gave one as a date and time.'}
            {sampled !== null ? ` Accounts read ${sampled}.` : ''}
          </p>
        </>
      )}

      <ObserveSlice visible={visible} part="usage" />
      <SpendDownStrip items={spend} nowMs={nowMs} />
      {resets !== null && <ResetTimeline timeline={resets} />}

      {(rows.length > 0 || personal !== null) && (
        <ul className={styles.rows} aria-label="Provider usage">
          {rows.map((row) => {
            const weekly = row.windows.filter((window) => /weekly|seven[\s_-]*day|7[\s_-]*(?:day|d)\b/i.test(window.label));
            const window = weekly.length === 1 ? weekly[0] : weekly.length === 0 && row.windows.length === 1 ? row.windows[0] : null;
            const incident = row.provider === 'claude' ? claudeIdle({
              claudeLane: runs?.['claudeLane'], lanes, usedPercent: window?.measured && !window.limitReached ? window.usedPercent : null,
              resetsAt: window?.resetsAt ?? null, nowMs,
            }) : null;
            return <AccountRow key={row.id} row={row} nowMs={nowMs} incident={incident} />;
          })}
          {personal !== null && (
            <li className={styles.row}>
              <div className={styles.head}>
                <BrandMark brand="codex" size={16} />
                <span className={styles.account}>Codex personal</span>
                <span className={styles.tag}>fleet reading</span>
              </div>
              <ul className={styles.windows}>
                <WindowMeter
                  account="Codex personal"
                  window={{
                    label: 'personal',
                    usedPercent: personal.usedPct,
                    resetsAt: personal.resetsAt,
                    resetDescription: null,
                    limitReached: false,
                    measured: personal.usedPct !== null,
                  }}
                  nowMs={nowMs}
                />
                {personal.asOf && <li className={styles.asOf}>as of {formatRelative(personal.asOf)}</li>}
                {disagreement && <li className={styles.notice} role="status" data-tone="warn">{disagreement.text}</li>}
              </ul>
            </li>
          )}
        </ul>
      )}
      {timed && (
        <p className={styles.barKey} data-bar-key>
          <WindowBarSwatch part="used" /> used so far <WindowBarSwatch part="elapsed" /> how far the window&rsquo;s time has run, drawn only where the accounts read holds the window&rsquo;s start. A bar that stops short of the mark is behind an even spend.
        </p>
      )}
      {read?.available && snapshot !== null && rows.length === 0 && (
        <p className={styles.message}>No provider accounts reported.</p>
      )}

      <section className={styles.laneSection} aria-label="Zero waste (last hour)">
        <h3 className={styles.title}>Zero waste (last hour)</h3>
        {auditRead.error !== undefined ? (
          <p className={styles.notice} role="status">Zero-waste audit unavailable: {readFailureReason(auditRead.error)}</p>
        ) : auditRead.data === null ? (
          <p className={styles.notice} role="status">Zero-waste audit unavailable: invalid response.</p>
        ) : auditRead.data ? (
          <>
            <p>{auditHeadline(auditRead.data)}</p>
            <ul className={styles.rows}>
              {auditRows(auditRead.data).map(row => {
                const lane = auditLanes.get(row.lane);
                return (
                  <li key={row.lane} title={row.nextAction} className={styles.auditRow}>
                    <span>{row.lane}</span>{' '}
                    <span className={styles.verdict} data-tone={row.tone}>{row.verdict}</span>{' '}
                    <span>{row.deltaText}</span>{' '}
                    <span className={styles.reason}>{row.reason}</span>
                    {lane && auditSteerVisible(lane) && (
                      <Button variant="subtle" size="sm" aria-label={`Steer ${row.lane}`}
                        onClick={() => openInterjectDialog({ prefill: auditSteerPrefill(lane, new Date().toISOString()) })}>
                        Steer
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          </>
        ) : <p className={styles.message}>Reading zero-waste audit…</p>}
      </section>

      {lanes.length > 0 && (
        <section className={styles.laneSection} aria-labelledby="fleet-usage-lane-title">
          <h3 id="fleet-usage-lane-title" className={styles.title}>Tokens last hour</h3>
          <p className={styles.meta}>
            {totals.total === null
              ? 'No lane reported a token figure.'
              : `${formatTokens(totals.total)} across ${totals.read} ${totals.read === 1 ? 'lane' : 'lanes'}${totals.unread > 0 ? `; ${totals.unread} with no reading` : ''}. Bars are each lane against the busiest.`}
          </p>
          <table className={styles.table}>
            <thead>
              <tr><th scope="col">Lane</th><th scope="col" className={styles.num}>Running</th><th scope="col" className={styles.num}>Tokens</th></tr>
            </thead>
            <tbody>
              {lanes.map((lane) => {
                const share = laneSharePct(lane, lanes);
                return (
                <tr key={lane.lane} className={styles.laneRow}
                  style={share === null ? undefined : { '--share': `${share}%` } as CSSProperties}>
                  {/* A mark only for a lane named after a known brand: a monogram per lane would be noise. */}
                  <td data-label="Lane">{resolveBrand(lane.lane) ? <BrandMark brand={lane.lane} size={12} className={styles.laneMark} /> : null}{lane.lane}</td>
                  <td data-label="Running" className={styles.num}>{lane.running === null && lane.target === null ? '—' : `${lane.running ?? '—'}/${lane.target ?? '—'}`}</td>
                  <td data-label="Tokens" className={styles.num}>{formatTokens(lane.tokensLastHour)}</td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}

      {!hasContent && waiting && (
        <div className={styles.loading} role="status"><span>Reading usage…</span><SkeletonLine /><SkeletonLine /></div>
      )}
    </section>
  );
}
