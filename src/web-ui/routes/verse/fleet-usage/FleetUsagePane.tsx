/**
 * routes/verse/fleet-usage/FleetUsagePane.tsx — the dock Usage pane.
 *
 * One dense row per provider account (Claude, Codex, Grok) rendering exactly
 * the windows the provider reported — minus Claude's retired 5-hour window,
 * which Anthropic lifted; the row carries one note saying the weekly window
 * is the whole story — plus the fleet snapshot's own Codex personal figure
 * and a tokens-per-lane table. Accounts poll every
 * 60 s and the live fleet snapshot every 10 s, only while the pane is on
 * top; both reads degrade to a notice rather than taking the pane down.
 */
import { useMemo } from 'react';
import { SkeletonLine } from '../../../components/primitives/index.js';
import { ApiError } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { formatRelative } from '../autonomy/format.js';
import { formatTokens } from '../fleet-lanes/fleet-lanes-model.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { usedPercentText } from '../percent-text.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { projectAccountsSnapshot } from '../usage/usage-contract.js';
import { verseAccountsQuery } from '../usage/usage-queries.js';
import { fleetUsageRunsQuery } from './fleet-usage-queries.js';
import {
  codexPersonalRow,
  degradedSources,
  formatReset,
  laneTokens,
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

function AccountRow({ row, nowMs }: { row: UsageRow; nowMs: number }) {
  return (
    <li className={styles.row}>
      <span className={styles.account} title={row.label}>{row.label}</span>
      {row.state !== 'observed' ? (
        <ul className={styles.windows}>
          <li className={styles.reason}>{row.reason ?? STATE_FALLBACK[row.state]}</li>
          {row.note !== null ? <li className={styles.asOf}>{row.note}</li> : null}
        </ul>
      ) : row.windows.length === 0 && row.note === null ? (
        <span className={styles.reason}>—</span>
      ) : (
        <ul className={styles.windows}>
          {row.windows.map((w, i) => <WindowMeter key={`${w.label}:${i}`} account={row.label} window={w} nowMs={nowMs} />)}
          {row.note !== null ? <li className={styles.asOf}>{row.note}</li> : null}
        </ul>
      )}
    </li>
  );
}

export function FleetUsagePane({ visible }: PaneProps) {
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

  const accountsMissing = read !== undefined && !read.available;
  const runsMissing = runsRead.data === null || (runsRead.error instanceof ApiError && runsRead.error.status === 404);
  if (accountsMissing && runsMissing) return <p className={styles.message}>Usage not in this build</p>;

  const hasContent = rows.length > 0 || personal !== null || lanes.length > 0;
  const waiting = read === undefined || (runsRead.data === undefined && runsRead.error === undefined);

  return (
    <section className={styles.root} aria-label="Usage">
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
              </ul>
            </li>
          )}
        </ul>
      )}
      {read?.available && snapshot !== null && rows.length === 0 && (
        <p className={styles.message}>No provider accounts reported.</p>
      )}

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
