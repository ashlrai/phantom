/**
 * Credit balances in the Resources drawer: a card per recorded balance from `GET /api/verse/resources/credit-pools`
 * (cloud gifts, purchased usage credits, subscription windows and Claude API promotions). Each card names the
 * balance beside its provider mark, states the recorded figure, and draws the shared usage-window bar
 * (primitives/WindowBar) for the share of the recorded grant that was gone at capture, then says when the
 * balance was captured and how long until its recorded deadline. What a bar may claim is decided in
 * credit-bar-model.ts. A balance that is unknown or hidden keeps its place with a hatched bar; it is never $0.
 * Nothing is read until the disclosure is opened, and nothing here authorizes spending.
 */
import { useId, useState } from 'react';
import type { ClaudeApiGrantView } from '../../../../core/resources/claude-api-grant-types.js';
import type { CreditPoolRowView } from '../../../../core/resources/credit-pool-types.js';
import { formatDecimalMetric } from '../../../components/charts/format-metric.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { BrandMark } from '../../../components/primitives/BrandMark.js';
import { Button } from '../../../components/primitives/Button.js';
import { WindowBar, WindowBarSwatch } from '../../../components/primitives/WindowBar.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { useNow } from '../autonomy/use-ticker.js';
import { apiGrantBar, creditPoolBar, creditSummary, spanText, summaryWords, type CreditBar } from './credit-bar-model.js';
import { apiGrantDisplay, apiGrantUsdDecimal, creditPoolDisplay } from './credit-pool-model.js';
import { creditPoolsQuery } from './credit-pools-query.js';
export { creditPoolsQuery, narrowCreditPoolsEnvelope } from './credit-pools-query.js';
import styles from './credit-pools.module.css';

const stamp = (iso: string) => new Date(iso).toLocaleString();

function ShareBar({ name, bar }: { name: string; bar: CreditBar }) {
  return <>
    {bar.drawn ? <WindowBar label={`${name}: ${bar.counts}`} valueText={bar.words} valueNow={bar.used} used={bar.used} /> : null}
    {bar.line ? <p className={styles.note} data-spent={bar.drawn ? 'share' : 'unknown'}>{bar.line}</p> : null}
  </>;
}

/** When the balance was captured, and how long ago: a recorded figure is only as current as its capture. */
function Captured({ at, now }: { at: string; now: number }) {
  const age = now - Date.parse(at);
  return <p className={styles.note}>Captured <time dateTime={at} title={at}>{stamp(at)}</time>{age >= 0 ? <span data-capture-age> · {spanText(age)} ago</span> : null}</p>;
}

function PoolCard({ row, account, now }: { row: CreditPoolRowView; account: string; now: number }) {
  const display = creditPoolDisplay(row, now);
  const bar = creditPoolBar(row, display.amountText);
  const deadline = display.expiresAt ? Date.parse(display.expiresAt) : NaN;
  const passed = Number.isFinite(deadline) && deadline <= now;
  return <li className={styles.card} data-credit={row.kind} data-passed={passed || undefined}>
    <div className={styles.heading}><strong><BrandMark brand={row.provider} size={14} />{display.title}</strong><span>{account}</span></div>
    <p className={styles.amount} title={row.amount === null ? undefined : `Recorded reading: ${display.amountText}`}>{display.amountText}</p>
    <ShareBar name={`${display.title}, ${account}`} bar={bar} />
    {row.total !== null && row.identityState === 'matched' ? <p className={styles.note} title={`Recorded total: ${formatDecimalMetric(row.total)} USD`}>Recorded {row.kind === 'gifted-cloud' ? 'grant' : 'total'}: ${formatDecimalMetric(row.total)}</p> : null}
    <p className={styles.note} data-deadline={!display.expiresAt ? 'unknown' : passed ? 'passed' : 'ahead'}>{display.expiryText}{display.expiresAt
      ? <>{passed ? null : <span data-countdown> · in {spanText(deadline - now)}</span>} · <time dateTime={display.expiresAt} title={display.expiresAt}>{stamp(display.expiresAt)}</time></> : null}</p>
    <Captured at={display.capturedAt} now={now} />
    <p className={styles.note}>{display.sourceText}</p>
    <p className={styles.note}>{display.scopeText}</p>
  </li>;
}

function ApiGrantCard({ row, now }: { row: ClaudeApiGrantView; now: number }) {
  const display = apiGrantDisplay(row);
  const cutoff = row.admissionCutoff ? Date.parse(row.admissionCutoff) : NaN;
  const passed = Number.isFinite(cutoff) && cutoff <= now;
  return <li className={styles.card} data-credit="api-promotion" data-passed={passed || undefined}>
    <div className={styles.heading}><strong><BrandMark brand="claude" size={14} />Claude API promotion</strong><span>API credits</span></div>
    <p className={styles.amount} title={row.remainingUsdMicros === null ? undefined : `Recorded balance: ${display.amountText.replace(' last recorded', '')}`}>{display.amountText}</p>
    <ShareBar name="Claude API promotion" bar={apiGrantBar(row)} />
    {row.totalUsdMicros !== null ? <p className={styles.note} title={`Recorded grant: ${formatDecimalMetric(apiGrantUsdDecimal(row.totalUsdMicros))} USD`}>Recorded API grant: ${formatDecimalMetric(apiGrantUsdDecimal(row.totalUsdMicros))}</p> : null}
    <p className={styles.note} data-deadline={row.expiryDate === null ? 'unknown' : passed ? 'passed' : 'ahead'}>{display.expiryText}</p>
    {row.admissionCutoff ? <p className={styles.note}>Phantom {passed ? 'stopped' : 'stops'} new API work {row.cutoffPolicy === 'expiry-day-start/v1' ? 'at the start of the expiry date (UTC)' : 'at the verified expiry time'}
      {passed ? null : <span data-countdown>, in {spanText(cutoff - now)}</span>}.
      <time dateTime={row.admissionCutoff} title={row.admissionCutoff}> {stamp(row.admissionCutoff)}</time></p> : null}
    {row.capturedAt ? <Captured at={row.capturedAt} now={now} /> : null}
    <p className={styles.note}>Automatic use held · billing, account binding and signed API authority need verification.</p>
  </li>;
}

function CreditPoolReading({ accountNames }: { accountNames: ReadonlyMap<string, string> }) {
  const reading = useQuery(creditPoolsQuery, { freshMs: 15_000 });
  const refetch = useRefetch(creditPoolsQuery);
  const [openedAt] = useState(() => Date.now());
  const now = useNow(2_000);
  const value = reading.data?.value;
  usePollWhileVisible(refetch, value?.state === 'warming' && now - openedAt < 30_000 ? 2_000 : 15_000);
  const pools = value?.pools;
  const apiGrants = value?.v === 2 ? value.apiGrants : null;
  if (!pools && !apiGrants) return <p className={styles.note}>{reading.data?.reason ?? (value?.state === 'unavailable'
    ? 'Credit balance records are unavailable. Balances are unknown.' : 'Reading recorded credit balances…')}</p>;
  const poolRows = pools?.sourceState === 'healthy' ? pools.rows : [];
  const grantRows = apiGrants?.state === 'healthy' ? apiGrants.rows : [];
  const summary = creditSummary(poolRows, grantRows, now);
  const keyed = poolRows.some(row => creditPoolBar(row, '').used !== null) || grantRows.some(row => apiGrantBar(row).used !== null);
  return <div className={styles.body}>
    {summary.listed ? <p className={styles.headline} data-headline>{summaryWords(summary, now)}</p> : null}
    {keyed ? <p className={styles.key} data-credit-key><span><WindowBarSwatch part="used" />share gone when the balance was captured</span></p> : null}
    {!pools ? <p className={styles.note}>Reading other recorded credit balances…</p> : !poolRows.length ? <p className={styles.note}>
      {pools.sourceState === 'unavailable' ? 'The credit balance record could not be read. Balances are unknown.'
        : 'No verified credit balance records yet. Balances are unknown.'}</p> : <ul className={styles.rows} aria-label="Recorded credit balances">
      {poolRows.map(row => <PoolCard key={`${row.provider}:${row.accountId}:${row.poolId}`} row={row} account={accountNames.get(row.accountId) ?? row.accountId} now={now} />)}
    </ul>}
    {apiGrants ? !grantRows.length ? <p className={styles.note}>
      API promotional balance records are unavailable. Balances are unknown.</p> : <ul className={styles.rows} aria-label="Recorded API promotions">
      {grantRows.map((row, index) => <ApiGrantCard key={`api-promotion:${index}`} row={row} now={now} />)}
    </ul> : null}
    {value?.state === 'stale' ? <p className={styles.note}>Showing the last reading while it refreshes.</p> : null}
    <p className={styles.note}>Subscription windows, API promotions, cloud gifts and purchased credits are separate. Recorded balances do not establish current spendability.</p>
    <Button size="sm" variant="ghost" onClick={refetch}>Refresh balances</Button>
  </div>;
}
/** This disclosure shares its recorded-balance cache with the visible resource bar. */
export function CreditPools({ accountNames = new Map() }: { accountNames?: ReadonlyMap<string, string> }) {
  const [open, setOpen] = useState(false);
  const titleId = useId();
  return <details className={styles.panel} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary id={titleId}>Credit balances <span>API promotions, gifts and purchased credits</span></summary>
    {open ? <CreditPoolReading accountNames={accountNames} /> : null}
  </details>;
}
