/**
 * routes/verse/fleet-usage/FleetUsagePane.tsx — the dock Usage pane.
 *
 * One dense row per provider account (Claude, Codex, Grok) rendering exactly
 * the windows the provider reported — minus Claude's retired 5-hour window,
 * which Anthropic lifted; the row carries one note saying the weekly window
 * is the whole story — plus the fleet snapshot's own Codex personal figure
 * and a tokens-per-lane table. Accounts and the zero-waste meter audit poll
 * every 60 s and the live fleet snapshot every 10 s, only while the pane is
 * on top; unavailable reads degrade to notices.
 */
import { useMemo, useState } from 'react';
import { formatDecimalMetric, formatMetric } from '../../../components/charts/format-metric.js';
import { copyText } from '../../../components/primitives/clipboard.js';
import { Button, SkeletonLine } from '../../../components/primitives/index.js';
import { auditHeadline, auditRows } from './usage-audit-model.js';
import { usageAuditQuery } from './usage-audit-queries.js';
import { ApiError, readFailureReason } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { formatRelative } from '../autonomy/format.js';
import { formatTokens } from '../fleet-lanes/fleet-lanes-model.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { usedPercentText } from '../percent-text.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { creditsSpendable } from '../usage/accounts-model.js';
import { projectAccountsSnapshot, type AccountCredits } from '../usage/usage-contract.js';
import { verseAccountsQuery } from '../usage/usage-queries.js';
import { fleetUsageRunsQuery } from './fleet-usage-queries.js';
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
import styles from './fleet-usage.module.css';

const ACCOUNTS_POLL_MS = 60_000;
const RUNS_POLL_MS = 10_000;

const STATE_FALLBACK: Record<UsageRow['state'], string> = {
  checking: 'checking…',
  observed: '',
  'signed-out': 'signed out',
  unavailable: 'unavailable',
};

const toneFor = (pct: number | null): 'ok' | 'warn' | 'danger' =>
  pct !== null && pct >= 90 ? 'danger' : pct !== null && pct >= 70 ? 'warn' : 'ok';

/**
 * One provider-reported window as a thin meter. A flagged limit is a flag,
 * not a measurement: it renders a full danger bar labelled "limit reached"
 * and announces no percentage — the same rule the Usage section's
 * WindowMeter follows. An unmeasured reading is an empty track and "—",
 * never a bar that could be misread.
 */
function WindowMeter({ account, window: w, nowMs }: { account: string; window: UsageWindowRow; nowMs: number }) {
  const name = `${account} ${w.label}`;
  const reset = w.resetDescription ?? formatReset(w.resetsAt, nowMs);
  const pct = w.measured ? w.usedPercent : null;
  const value = w.limitReached ? 'limit reached' : usedPercentText(pct);
  return (
    <li className={styles.window}>
      <span className={styles.windowLabel}>{w.label}</span>
      {w.limitReached ? (
        <span
          className={styles.track}
          data-tone="danger"
          role="img"
          aria-label={`${name}: the provider flagged this window as rate-limited, so no percentage is shown`}
        >
          <span className={styles.fill} style={{ width: '100%' }} />
        </span>
      ) : (
        <span
          className={styles.track}
          data-tone={toneFor(pct)}
          role="meter"
          aria-label={`${name} used`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct === null ? undefined : Math.round(pct)}
          aria-valuetext={pct === null ? 'unknown' : `${usedPercentText(pct)} used`}
        >
          <span className={styles.fill} style={{ width: `${pct === null ? 0 : Math.min(100, Math.max(0, pct))}%` }} />
        </span>
      )}
      <span className={w.limitReached ? styles.flag : styles.pct}>{value}</span>
      <span className={styles.reset}>{reset}</span>
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

function AccountRow({ row, nowMs }: { row: UsageRow; nowMs: number }) {
  const planType = row.planType ?? null;
  const hasFacts = row.observedAt != null || row.credits != null || row.reconnectCommand != null;
  return (
    <li className={styles.row}>
      <span className={styles.account} title={row.label}>
        {row.label}
        {planType !== null ? ` · ${planType}` : ''}
      </span>
      {row.state !== 'observed' ? (
        <ul className={styles.windows}>
          <li className={styles.reason}>{row.reason ?? STATE_FALLBACK[row.state]}</li>
          {row.note !== null ? <li className={styles.asOf}>{row.note}</li> : null}
          <AccountFacts row={row} nowMs={nowMs} />
        </ul>
      ) : row.windows.length === 0 && row.note === null && !hasFacts ? (
        <span className={styles.reason}>—</span>
      ) : (
        <ul className={styles.windows}>
          {row.windows.map((w, i) => <WindowMeter key={`${w.label}:${i}`} account={row.label} window={w} nowMs={nowMs} />)}
          {row.windows.length === 0 && row.note === null ? <li className={styles.reason}>—</li> : null}
          {row.note !== null ? <li className={styles.asOf}>{row.note}</li> : null}
          <AccountFacts row={row} nowMs={nowMs} />
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
  const personal = useMemo(() => codexPersonalRow(runsRead.data ?? null), [runsRead.data]);
  const lanes = useMemo(() => laneTokens(runsRead.data ?? null), [runsRead.data]);
  const degraded = useMemo(() => degradedSources(runsRead.data ?? null), [runsRead.data]);
  const nowMs = Date.now();
  const disagreement = personalDisagreement(rows, personal, personalCodexAccount(snapshot?.accounts ?? [])?.observedAt ?? null, nowMs);

  const accountsMissing = read !== undefined && !read.available;
  const runsMissing = runsRead.data === null || (runsRead.error instanceof ApiError && runsRead.error.status === 404);

  const hasContent = rows.length > 0 || personal !== null || lanes.length > 0;
  const waiting = read === undefined || (runsRead.data === undefined && runsRead.error === undefined);

  return (
    <section className={styles.root} aria-label="Usage">
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

      {(rows.length > 0 || personal !== null) && (
        <ul className={styles.rows} aria-label="Provider usage">
          {rows.map((row) => <AccountRow key={row.id} row={row} nowMs={nowMs} />)}
          {personal !== null && (
            <li className={styles.row}>
              <span className={styles.account}>Codex personal</span>
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
              {auditRows(auditRead.data).map(row => (
                <li key={row.lane} title={row.nextAction} className={styles.auditRow}>
                  <span>{row.lane}</span>{' '}
                  <span className={styles.verdict} data-tone={row.tone}>{row.verdict}</span>{' '}
                  <span>{row.deltaText}</span>{' '}
                  <span className={styles.reason}>{row.reason}</span>
                </li>
              ))}
            </ul>
          </>
        ) : <p className={styles.message}>Reading zero-waste audit…</p>}
      </section>

      {lanes.length > 0 && (
        <section className={styles.laneSection} aria-labelledby="fleet-usage-lane-title">
          <h3 id="fleet-usage-lane-title" className={styles.title}>Tokens last hour</h3>
          <table className={styles.table}>
            <thead>
              <tr><th scope="col">Lane</th><th scope="col" className={styles.num}>Running</th><th scope="col" className={styles.num}>Tokens</th></tr>
            </thead>
            <tbody>
              {lanes.map((lane) => (
                <tr key={lane.lane}>
                  <td>{lane.lane}</td>
                  <td className={styles.num}>{lane.running === null && lane.target === null ? '—' : `${lane.running ?? '—'}/${lane.target ?? '—'}`}</td>
                  <td className={styles.num}>{formatTokens(lane.tokensLastHour)}</td>
                </tr>
              ))}
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
