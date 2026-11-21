/**
 * routes/verse/fleet-supply/FleetSupplyPane.tsx — the Supply board: how many job files to write so the lanes stay
 * full. A headline, the fleet's opening slots as one strip, a card per lane (provider mark, a square per slot that
 * opens in the window, filled when a job waits for it), where tokens go, and the weekly waste forecast with its
 * target fix. Slots and waiting jobs come from GET /api/verse/fleet/runs (`phm fleet runs --json`); run-out times
 * and the forecast from GET /api/verse/leader/resources.
 */
import { useMemo, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { ProviderBadge } from '../../../components/primitives/ProviderBadge.js';
import { StatusBadge } from '../../../components/primitives/StatusBadge.js';
import { refetchQuery } from '../../../data/cache.js';
import { ApiError, readFailureReason } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { VerseControlLockedError } from '../autonomy/control-queries.js';
import { openDockPane } from '../dock/dock-store.js';
import { laneWriting, setLaneWriting, subscribeLaneWrite } from '../fleet-lanes/LaneTargetStepper.js';
import { laneTargetsQuery, postLaneTarget } from '../ops/lane-targets-queries.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { exhaustionByLane, soonestExhaustion } from './supply-exhaustion-model.js';
import { supplyLedgerQuery } from './supply-ledger-query.js';
import { fleetSupplyQuery } from './fleet-supply-queries.js';
import { heldUntilText } from './held-until-text.js';
import { laneYield, yieldRanking, yieldText } from './lane-yield-model.js';
import { boardHeadline, supplyCard, supplyStrip, totalsLine, wasteBar, type SupplyCard } from './supply-board-model.js';
import { asRecord, HORIZON_SECONDS, laneSupply, TYPICAL_RUN_SECONDS } from './supply-model.js';
import { suggestedTarget, wasteForecast, wasteHeadline } from './waste-forecast-model.js';
import styles from './fleet-supply.module.css';

/** The slots a lane opens in the window: a square each, or one bar for a lane too large to count by eye. */
function OpeningSlots({ card }: { card: SupplyCard }) {
  if (card.coveredPct === null) return null;
  if (card.marks) return <div className={styles.pips} role="img" aria-label={card.picture}>
    {card.marks.map((mark, i) => <span key={i} className={styles.pip} data-pip={mark} />)}
  </div>;
  return <div className={styles.track} role="img" aria-label={card.picture}>
    <div className={styles.fill} style={{ width: `${card.coveredPct}%` }} />
  </div>;
}

export function FleetSupplyPane({ visible }: PaneProps) {
  const [notices, setNotices] = useState<Record<string, string>>({});
  const writing = useSyncExternalStore(subscribeLaneWrite, laneWriting, () => false);
  const read = useQuery(fleetSupplyQuery, { enabled: visible, freshMs: 0 });
  const ledgerQuery = useMemo(() => supplyLedgerQuery(), []);
  const ledger = useQuery(ledgerQuery, { enabled: visible, freshMs: 0 });
  const refetchLedger = useRefetch(ledgerQuery);
  const refetch = useRefetch(fleetSupplyQuery);
  usePollWhileVisible(refetch, 10_000, { enabled: visible });
  usePollWhileVisible(refetchLedger, 10_000, { enabled: visible });
  async function setTarget(lane: string, target: number) {
    if (laneWriting()) return;
    setLaneWriting(true);
    setNotices(current => ({ ...current, [lane]: '' }));
    try {
      const response = await postLaneTarget(lane, target);
      const saved = response.lanes.find(row => row.lane === lane);
      setNotices(current => ({ ...current, [lane]: saved ? `Lane ${lane}: target ${saved.target} saved` : `Lane ${lane}: target response unavailable` }));
      await Promise.all([
        refetchQuery(laneTargetsQuery.key, () => laneTargetsQuery.fetch(), true),
        refetchQuery(fleetSupplyQuery.key, () => fleetSupplyQuery.fetch(), true),
        refetchQuery(ledgerQuery.key, () => ledgerQuery.fetch(), true),
      ]);
    } catch (reason) {
      setNotices(current => ({ ...current, [lane]: reason instanceof VerseControlLockedError ? reason.message : readFailureReason(reason) }));
    } finally { setLaneWriting(false); }
  }
  if (read.data === null || (read.error instanceof ApiError && read.error.status === 404)) {
    return <section className={styles.root} aria-label="Fleet supply"><h2 className={styles.headline}>Supply</h2><p className={styles.message}>Live runs not in this build</p></section>;
  }
  if (read.data === undefined) {
    return <section className={styles.root} aria-label="Fleet supply"><h2 className={styles.headline}>Supply</h2>
      <p className={styles.message} role="status">{read.status === 'error' ? 'Live runs are unavailable.' : 'Reading live runs…'}</p>
    </section>;
  }
  const now = Date.now();
  const data = asRecord(read.data);
  const rows = laneSupply(data);
  // An unread drop folder leaves the pending-file count unknown: the board then counts queued jobs only and says so.
  const unreadable = asRecord(data.sources).runsDir !== 'healthy' || data.drop === null;
  const cards = rows.map(row => supplyCard(row, !unreadable));
  const strip = supplyStrip(cards);
  const totals = totalsLine(cards, !unreadable);
  const lanes = Array.isArray(data.lanes) ? data.lanes.map(asRecord) : [];
  const yieldLanes = lanes.filter(lane => ['tokensLastHour', 'merged24h', 'mergeRate24h'].some(key => key in lane));
  const yields = new Map(yieldLanes.map(lane => [lane.lane, laneYield(lane)]));
  const ranking = yieldRanking(yieldLanes);
  const exhaustion = exhaustionByLane(ledger.data, now);
  const visibleExhaustion = new Map(rows.flatMap(row => {
    const entry = exhaustion.get(row.lane);
    return entry ? [[row.lane, entry] as const] : [];
  }));
  const soonest = soonestExhaustion(visibleExhaustion);
  const forecasts = (ledger.data?.lanes ?? []).flatMap(lane => {
    const forecast = wasteForecast(lane, now);
    return forecast ? [{ forecast, lane }] : [];
  }).sort((a, b) => b.forecast.unusedPct - a.forecast.unusedPct);
  const waste = wasteHeadline(forecasts.map(item => item.forecast));
  const claudeLane = typeof data.claudeLane === 'string' && /down/i.test(data.claudeLane) ? data.claudeLane : null;
  return <section className={styles.root} aria-label="Fleet supply">
    <h2 className={styles.headline}>{boardHeadline(cards, !unreadable)}{soonest && ` · ${soonest}`}</h2>
    {totals && <p className={styles.meta}>{totals}</p>}
    {strip && <div className={styles.strip} role="img" aria-label={strip.label}>
      {strip.segments.map((segment, index) => <span key={`${segment.lane}-${index}`} className={styles.segment} data-state={segment.state}
        title={segment.lane} style={{ flexGrow: segment.weight } as CSSProperties}>
        <span className={styles.segmentFill} style={{ width: `${segment.coveredPct}%` }} />
      </span>)}
    </div>}
    {unreadable && <p className={styles.message} data-stale role="status">Drop folder unreadable: pending counts unknown</p>}
    {claudeLane && <p className={styles.message} data-stale>{claudeLane}</p>}
    {ledger.status === 'error' && <p className={styles.message} data-stale role="status">Resource ledger could not refresh{ledger.data ? '. Showing the last reading.' : '.'}</p>}
    {read.status === 'error' && <p className={styles.message} data-stale role="status">Live runs could not refresh. Showing the last reading.</p>}
    {ranking.length > 0 && <section className={styles.section} aria-labelledby="supply-yield-heading">
      <h3 id="supply-yield-heading" className={styles.title}>Where tokens go</h3>
      <ul className={styles.rows}>{ranking.map((item, index) => <li key={`${item.lane}-${index}`}>
        <strong>{item.lane}</strong>: {yieldText(item)} · <span className={styles.hint}>{item.hint}</span>
      </li>)}</ul>
    </section>}
    <section className={styles.section} aria-labelledby="supply-lanes-heading">
      <h3 id="supply-lanes-heading" className={styles.title}>Job supply per lane</h3>
      {cards.length === 0 ? <p className={styles.message}>No lane readings yet.</p> : <ul className={styles.list} aria-labelledby="supply-lanes-heading">
        {cards.map((card, index) => {
          const laneExhaustion = exhaustion.get(card.lane);
          const laneYieldRow = yields.get(card.lane);
          return <li key={`${card.lane}-${index}`} className={styles.lane} data-board-card data-state={card.state} aria-label={card.lane}>
            <div className={styles.line}>
              <span className={styles.name}>
                <ProviderBadge of={card.lane} iconOnly size={14} />
                <button type="button" className={styles.linkButton} onClick={() => openDockPane('fleet-lanes')} aria-label={`Open Lanes pane (${card.lane})`}>{card.lane}</button>
              </span>
              {card.held && <span className={styles.badge} title={card.heldReason ?? undefined}>{heldUntilText(card.heldReason, now)}</span>}
              {/* The words carry the state; the mark before them only repeats it. */}
              <span className={styles.state}>{card.stateText}</span>
            </div>
            {card.coveredPct !== null && <div className={styles.slots}>
              <OpeningSlots card={card} />
              <span className={styles.count}>{card.covered} of {card.demand} opening {card.demand === 1 ? 'slot' : 'slots'} covered{card.spare > 0 && ` · ${card.spare} more waiting`}</span>
            </div>}
            <dl className={styles.facts}>{card.facts.map(fact => <div key={fact.label} className={styles.fact}>
              <dt>{fact.label}</dt>
              <dd data-short={fact.label === 'Shortfall' && card.shortfall > 0 ? 'true' : undefined}>{fact.label === 'Shortfall' && card.shortfall > 0 ? <strong>{fact.value}</strong> : fact.value}</dd>
            </div>)}</dl>
            {(laneYieldRow || laneExhaustion) && <div className={styles.notes}>
              {laneYieldRow && <span data-testid="lane-yield">{yieldText(laneYieldRow)}</span>}
              {laneExhaustion && <button type="button" className={`${styles.linkButton} ${styles.exhaustion}`} onClick={() => openDockPane('fleet-usage')} data-tone={laneExhaustion.tone}>{laneExhaustion.text}</button>}
            </div>}
          </li>;
        })}
      </ul>}
    </section>
    {waste && <section className={styles.section} aria-label="Waste forecast">
      <h3 className={styles.title} data-plain>{waste}</h3>
      <ul className={styles.rows}>{forecasts.map(({ forecast, lane }) => {
        const row = rows.find(item => item.lane === forecast.lane);
        const held = row?.held || lane.held === true;
        const suggestion = row ? suggestedTarget(forecast, { ...row, held: !!held }, lane.burnPctPerHour) : null;
        const bar = wasteBar(lane.usedPct, forecast.unusedPct, forecast.burnKnown);
        return <li key={forecast.lane} data-tone={forecast.tone}>
          <StatusBadge status={forecast.tone} tone={forecast.tone === 'bad' ? 'danger' : forecast.tone === 'warn' ? 'warning' : 'success'}>{forecast.tone === 'bad' ? 'High' : forecast.tone === 'warn' ? 'Watch' : 'On track'}</StatusBadge> {forecast.text}
          {held && <> · held: release first</>}
          {suggestion && <> · needs target {suggestion.target} (now {row!.target}, {new Intl.NumberFormat('en-US', { maximumSignificantDigits: 3 }).format(suggestion.perWorkerPctPerHour)}%/h per worker){suggestion.target * suggestion.perWorkerPctPerHour < forecast.neededBurnPctPerHour && ' · capped at 64; may leave usage unused'} <button type="button" disabled={writing} onClick={() => void setTarget(forecast.lane, suggestion.target)}>Set target {suggestion.target}</button></>}
          {notices[forecast.lane] && <> · <span role="status">{notices[forecast.lane]}</span></>}
          {bar && <div className={styles.waste} role="img" aria-label={`${forecast.lane} at reset: ${bar.label}`}>
            <span className={styles.wasteUsed} style={{ width: `${bar.usedPct}%` }} />
            <span className={styles.wasteBurn} style={{ width: `${bar.burnPct}%` }} />
            <span className={styles.wasteUnused} style={{ width: `${bar.unusedPct}%` }} />
          </div>}
        </li>;
      })}</ul>
    </section>}
    <p className={styles.footer}>Next {HORIZON_SECONDS / 60} min · assumes ~{TYPICAL_RUN_SECONDS / 60} min per job. Waiting = pending files + queued jobs.</p>
  </section>;
}
