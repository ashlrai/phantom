/**
 * routes/verse/resources/ResourceCard.tsx — one paid account in the Resources
 * drawer (unit 3.11 C6):
 *
 *   [C] Claude Max · max
 *       ● Spent · resets Sat 11:46 PM · usable again in 1d 7h
 *       checked 2m ago
 *       Weekly  ▇▇▇▇▇▇▇▇│░░░░▕▨▨  62%
 *               resets Sat 11:46 PM
 *               │ 71% of the window gone · use is 9 points behind an even spend   ▨ 40% kept for you
 *       Anthropic removed the 5-hour limit on this plan.
 *       Reserved for you 40% · balanced mode
 *       [Check again]
 *
 * Every word comes from the shared capacity projection — `accountStatus` for
 * the status line, the row's windows for the meters (resets already worded by
 * `describeResetAt`), `usedPercentText` for every percent, `accountActions`
 * for what the account needs — so this card and Apps & Accounts can never
 * disagree about one seat. Text wraps at word boundaries; anything long also
 * carries its full text as a tooltip.
 *
 * Each window is the shared WindowBar (the bar every resource board draws):
 * used so far, the reserve as a hatched band at the window's end, and, only
 * where the seat's reset provenance holds the window's start, a mark for how
 * far its time has run. A flagged limit is a full red bar and no percentage;
 * no reading, or a reading that is no longer current, is a hatched track.
 */
import { estimatedCreditValue, formatNativeCreditUnits, nativeCreditBalanceTitle, CODEX_CREDIT_VALUE_SOURCE, CODEX_CREDIT_VALUE_CHECKED } from './codex-credit-value.js';
import type { BudgetMode } from '../../../../core/routing/types.js';
import { Button } from '../../../components/primitives/Button.js';
import { WindowBar, WindowBarSwatch } from '../../../components/primitives/WindowBar.js';
import { elapsedWords, leadWords, startClock, startWords, windowPace } from '../fleet-usage/window-pace-model.js';
import { codexFreeResetsLine, codexResetLine } from './codex-reset-line.js';
import { readingAge } from './reading-age.js';
import { relativePhrase } from '../context/context-model.js';
import { accountActions, type AccountAction } from '../apps/apps-model.js';
import { MonogramTile } from '../apps/MonogramTile.js';
import { usedPercentText } from '../percent-text.js';
import { claudeQuotaDiagnostic } from '../usage/accounts-model.js';
import { windowSentence, type AccountStatus, type CapacityRow, type CapacityWindowRow } from '../usage/capacity-strip-model.js';
import type { ResourceReadinessRow } from '../../../../core/routing/readiness-types.js';
import { ReadinessLines } from './ReadinessLines.js';
import { ResourceFacts } from './ResourceFacts.js';
import type { ResourceDisplayView } from './resource-display-model.js';
import type { ResourceFactsView } from './resources-model.js';
import { useWorldReading } from './world-card-reading.js';
import { SchedulingEvidence } from './SchedulingEvidence.js';
import type { SchedulingEvidenceView } from './scheduling-model.js';
import styles from './ResourcesDrawer.module.css';
import { lazy, Suspense } from 'react';
import type { BudgetView } from '../../../../core/routing/policy.js';
const ResetSpendingAccountControl = lazy(() => import('../budget/ResetSpendingControl.js').then(module => ({ default: module.ResetSpendingAccountControl })));

/** At this share of a window the figure beside the bar turns amber (the capacity strip's own line); the bar never does. */
const TIGHT_AT = 90;

const MODE_WORD: Readonly<Record<BudgetMode, string>> = {
  'all-in': 'all-in mode',
  balanced: 'balanced mode',
  reserve: 'reserve mode',
};

function clamp(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

export function StatusLine({ status }: { status: AccountStatus }) {
  const parts = [status.detail, status.usableAgain].filter((p): p is string => p !== null && p.length > 0);
  const full = [status.label, ...parts].join(' · ');
  return (
    <p className={styles.status} data-tone={status.tone} data-status={status.kind} title={full}>
      <span className={styles.statusDot} aria-hidden="true" />
      <span>
        <span className={styles.statusLabel}>{status.label}</span>
        {parts.map((p) => (
          <span key={p} className={styles.statusDetail}>{` · ${p}`}</span>
        ))}
      </span>
    </p>
  );
}

function WindowMeter({ row, w, reservePercent, current = true, nowMs }: { row: CapacityRow; w: CapacityWindowRow; reservePercent: number | null; current?: boolean; nowMs: number }) {
  current = current && row.quotaCurrent !== false;
  const resetText = w.resetText === null ? null : current ? w.resetText : `Recorded reset ${w.resetText.replace(/^resets\s+/i, '')}`;
  const sentence = windowSentence(row, { ...w, resetText }, w.binding ? reservePercent : null) + (current ? '' : `${row.quotaCurrent === false && resetText !== null ? `; ${resetText}` : ''}; last reading, current usage unconfirmed`);
  const head = `${row.label} ${w.label}`;
  const label = w.label.replace(/ window$/, '');
  let level: 'ok' | 'tight' | 'limit' | 'unknown';
  let value: string;
  // Null draws the hatched track: no reading, or one that is no longer current.
  let used: number | null = null;
  if (!current) {
    level = 'unknown';
    value = `${w.limitReached ? 'limit was flagged' : w.usedPercent === null ? 'usage unknown' : usedPercentText(w.usedPercent)} · last`;
  } else if (w.limitReached) {
    level = 'limit';
    value = 'limit reached';
    used = 100;
  } else if (w.usedPercent === null) {
    level = 'unknown';
    value = 'no reading';
  } else {
    used = clamp(w.usedPercent);
    level = used >= TIGHT_AT ? 'tight' : 'ok';
    value = usedPercentText(w.usedPercent);
  }
  // Time gone is read only against a current reading: a retained one may describe an earlier window.
  const pace = current ? windowPace({ usedPercent: w.usedPercent, resetsAt: w.resetsAt, limitReached: w.limitReached, measured: w.usedPercent !== null, period: w.period }, nowMs) : null;
  const lead = pace ? leadWords(pace) : null;
  const kept = used !== null && w.binding && reservePercent !== null && reservePercent > 0 ? clamp(reservePercent) : null;
  const said = sentence.startsWith(`${head}: `) ? sentence.slice(head.length + 2) : sentence;
  return (
    <div className={styles.meter} data-binding={w.binding || undefined} data-level={level}>
      <span className={styles.meterLabel} title={w.label}>{label.charAt(0).toUpperCase() + label.slice(1)}</span>
      <WindowBar label={head} valueText={pace ? `${said}, ${elapsedWords(pace)}` : said} valueNow={level === 'limit' ? null : used}
        used={used} kept={kept} elapsed={pace?.elapsedPct ?? null} ending={level === 'limit' ? 'spent' : undefined} />
      <span className={styles.meterValue} aria-hidden="true">{value}</span>
      {resetText !== null ? <span className={styles.meterReset} title={resetText} aria-hidden="true">{resetText}</span> : null}
      {pace !== null || kept !== null ? (
        <span className={styles.meterPace} data-pace={pace === null ? undefined : pace.lead === null ? 'unread' : pace.lead < 0 ? 'behind' : pace.lead > 0 ? 'ahead' : 'level'}>
          {pace !== null ? <span data-time-gone>{used !== null ? <WindowBarSwatch part="elapsed" /> : null}{[elapsedWords(pace), lead, startWords(pace, startClock(nowMs))].filter(Boolean).join(' · ')}</span> : null}
          {kept !== null ? <span data-kept><WindowBarSwatch part="kept" />{kept}% kept for you</span> : null}
        </span>
      ) : null}
    </div>
  );
}

/** Rendered only for a missing reading, so other cards never subscribe to the world model. */
export function WorldReadingLine({ seatId, engine }: { seatId: string; engine: string }) {
  const world = useWorldReading(seatId, engine);
  if (world === null) return null;
  return <p className={styles.subtle} data-resource-world-reading>World model: {world.usage} · {world.remaining} · from {world.source} · {world.age}</p>;
}

export interface ResourceCardProps {
  row: CapacityRow;
  /** Worded against the drawer's clock, with any running check applied. */
  status: AccountStatus;
  display?: ResourceDisplayView;
  /** The status with no check applied, so a button does not vanish while its own check runs. */
  settled: AccountStatus;
  mode: BudgetMode | null;
  busy: { seatId: string; kind: AccountAction['kind'] } | null;
  onAction: (row: CapacityRow, action: AccountAction) => void;
  /**
   * This account's row of GET /api/verse/budget/readiness (3.14). Its
   * reconnect / check-again fixes are NOT repeated here — `accountActions`
   * already offers them below — only a literal command is.
   */
  readiness?: ResourceReadinessRow | null;
  /** 3.15: tier · cost basis · models — the facts row every card carries. */
  facts?: ResourceFactsView | null;
  scheduling?: SchedulingEvidenceView;
  resetBudget?: BudgetView | null;
  resetNowMs?: number;
  onReviewGrant?: () => void;
}

export function ResourceCard({ row, status, display, settled, mode, busy, onAction, readiness = null, facts = null, scheduling, resetBudget = null, resetNowMs = Date.now(), onReviewGrant }: ResourceCardProps) {
  // Budget editing lives in Apps & Accounts; the drawer offers what the seat needs now.
  const actions = accountActions(row, settled).filter((a) => a.kind !== 'edit-budget');
  const reserve = row.reserve;
  const creditCurrent = display?.credit.current ?? (!row.lastReading && !row.signedOut);
  const creditText = creditCurrent ? row.credits : null;
  const primaryWindow = row.windows.find((w) => w.binding) ?? row.windows[0] ?? null;
  const otherWindows = row.windows.filter((w) => w !== primaryWindow);
  const reserveText = reserve === null ? null : reserve.percent !== null && mode !== null ? `${reserve.label} · ${MODE_WORD[mode]}` : reserve.label;
  const connectionPhrase = display?.connection.checkedAt ? relativePhrase(display.connection.checkedAt, resetNowMs) : null;
  const resetLine = display?.usage.current === false || row.quotaCurrent === false ? null : codexResetLine(row, resetNowMs);
  const freeResetsLine = codexFreeResetsLine(row);
  const quotaDiagnostic = row.windows.length === 0 ? claudeQuotaDiagnostic(row.quotaReadReason) : null;
  return (
    <li className={styles.card} data-status={status.kind} data-seat={row.seatId} data-usage-state={display?.usage.state} data-usage-observed-at={display?.usage.observedAt ?? undefined} data-verse-anchor={`resources:${row.seatId}`}>
      <div className={styles.cardHead}>
        <MonogramTile monogram={row.monogram} engine={row.engine} size="sm" />
        <h4 className={styles.cardName}>
          <span title={row.label}>{row.label}</span>
          {row.plan !== null ? <span className={styles.plan}>{row.plan}</span> : null}
        </h4>
      </div>
      {row.engine === 'grok' ? <p className={styles.subtle}>Grok Build · native CLI</p> : null}
      <StatusLine status={status} />
      {display ? <p className={styles.subtle} data-resource-usage-label>{display.usage.label}</p> : null}
      {display?.usage.state === 'missing' ? <WorldReadingLine seatId={row.seatId} engine={row.engine} /> : null}
      {display ? <p className={styles.stamp}>{display.usage.observedAt ? <time dateTime={display.usage.observedAt} title={display.usage.observedAt}>{readingAge(display.usage.observedAt)}</time> : 'Reading age unknown'}</p> : null}
      {creditText !== null ? <p className={styles.subtle}>{creditText}</p> : null}
      {!creditCurrent && row.engine === 'codex' && row.creditState !== undefined && row.creditState !== 'unknown' ? <p className={styles.subtle}>Credits unconfirmed · current balance and availability are unknown.</p> : null}
      {display?.connection.checkedAt ? <p className={styles.stamp}><span>Connection </span><time dateTime={display.connection.checkedAt} title={display.connection.checkedAt}>{connectionPhrase ? `checked ${connectionPhrase}` : 'check time unconfirmed'}</time></p>
        : !display && status.checked !== null ? <p className={styles.stamp} title={status.checkedTitle ?? undefined}>{status.checked}</p> : null}
      {row.windows.length > 0 ? (
        <div className={styles.meters}>
          {primaryWindow !== null ? <WindowMeter row={row} w={primaryWindow} current={display?.usage.current ?? true} reservePercent={reserve?.percent ?? null} nowMs={resetNowMs} /> : null}
        </div>
      ) : <p className={styles.subtle}>Usage not reported by this resource.</p>}
      {resetLine !== null ? <p className={styles.subtle} data-resource-codex-reset>{resetLine}</p> : null}
      {freeResetsLine !== null ? <p className={styles.subtle} data-resource-codex-free-resets>{freeResetsLine}</p> : null}
      {quotaDiagnostic ? <p className={styles.subtle}>Claude quota check: {quotaDiagnostic.sentence} <code>{quotaDiagnostic.code}</code></p> : null}
      {row.lastReading ? <p className={styles.subtle}>Last known usage · latest check failed.</p> : null}
      {row.windows.length === 0 && row.historicalUsage && !row.signedOut ? <div className={styles.fine}>
        <p>Last known usage · current availability unconfirmed.</p>
        <p>Recorded <time dateTime={row.historicalUsage.observedAt} title={row.historicalUsage.observedAt}>{new Date(row.historicalUsage.observedAt).toLocaleString()}</time></p>
        {row.historicalUsage.windows.map(window => <p key={window.id}>{window.id}: {window.limitReached ? 'limit was flagged' : window.usedPercent === null ? 'usage unknown' : `${usedPercentText(window.usedPercent)} used`}
          {window.resetsAt ? <> · recorded reset <time dateTime={window.resetsAt} title={window.resetsAt}>{new Date(window.resetsAt).toLocaleString()}</time></> : null}</p>)}
      </div> : null}
      <details className={styles.usageDetails}>
        <summary tabIndex={0} aria-label={`Usage details: ${row.label}`}>Usage details</summary>
        <div className={styles.usageDetailBody}>
          {facts !== null ? <ResourceFacts facts={facts} /> : null}
          {scheduling ? <SchedulingEvidence view={scheduling} /> : null}
          {otherWindows.length > 0 ? <div className={styles.meters}>{otherWindows.map((w) => <WindowMeter key={w.id} row={row} w={w} current={display?.usage.current ?? true} reservePercent={reserve?.percent ?? null} nowMs={resetNowMs} />)}</div> : null}
          {row.windows.length === 0 ? <p className={styles.subtle}>Connection status and usage are separate. No percentage has been supplied.</p> : null}
          {creditCurrent && row.engine === 'codex' && row.creditState !== undefined && row.creditState !== 'unknown' ? <p className={styles.subtle}>
            {row.creditState === 'none' ? 'Native provider reports no available credits. ' : ''}
            {row.creditBalance !== null && row.creditBalance !== undefined ? <span title={nativeCreditBalanceTitle(row.creditBalance) ?? undefined}>Native balance {formatNativeCreditUnits(row.creditBalance) ?? 'unknown'} credit units. </span> : null}
            Estimated credit value: {estimatedCreditValue(row.creditBalance, row.plan) ?? 'unknown'}.
            {' '}Personal-plan reference $0.04 per credit; not actual purchase price or attributed spend.
            {' '}<a href={CODEX_CREDIT_VALUE_SOURCE} target="_blank" rel="noreferrer">Published reference</a> checked {CODEX_CREDIT_VALUE_CHECKED}.
          </p> : null}
          {row.notes.map((note) => <p key={note} className={styles.subtle}>{note}</p>)}
          {reserveText !== null || creditText !== null ? (
            <p className={styles.reserveLine}>
              {reserveText !== null ? <span title={reserve?.why}>{reserveText}</span> : null}
              {reserveText !== null && creditText !== null ? ' · ' : null}
              {creditText !== null ? <span>{creditText}</span> : null}
            </p>
          ) : null}
        </div>
      </details>
      <ReadinessLines row={readiness} />
      {resetBudget?.resetSpendingStatus ? <Suspense fallback={null}>
        <ResetSpendingAccountControl view={resetBudget} nowMs={resetNowMs} seatId={row.seatId} label={row.label} onReviewGrant={onReviewGrant} />
      </Suspense> : null}
      {actions.length > 0 ? (
        <div className={styles.cardActions}>
          {actions.map((action) => (
            <Button
              key={action.kind}
              size="sm"
              variant={action.primary ? 'primary' : 'ghost'}
              busy={busy?.seatId === row.seatId && busy.kind === action.kind}
              aria-label={`${action.kind === 'fix' ? 'Fix in Apps' : action.label}: ${row.label}`}
              onClick={() => onAction(row, action)}
            >
              {action.kind === 'fix' ? 'Fix in Apps' : action.label}
            </Button>
          ))}
        </div>
      ) : null}
    </li>
  );
}
