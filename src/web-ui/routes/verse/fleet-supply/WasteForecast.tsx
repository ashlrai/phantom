/**
 * routes/verse/fleet-supply/WasteForecast.tsx: the Supply board's waste forecast, a row per weekly window from
 * the resource ledger (GET /api/verse/leader/resources, what `phm resources ledger --json` prints). Each row is
 * the lane with its provider mark, the share set to go unused, the shared WindowBar (used, more by the reset,
 * left unused, time gone), the facts behind it on one line, and under that the one thing to do about it: the
 * target that would use the window, or the hold to release first.
 */
import { Button } from '../../../components/primitives/Button.js';
import { ProviderBadge } from '../../../components/primitives/ProviderBadge.js';
import { StatusBadge } from '../../../components/primitives/StatusBadge.js';
import { WindowBar, WindowBarSwatch } from '../../../components/primitives/WindowBar.js';
import type { ResourceLaneRow } from '../usage/fleet-ledger-model.js';
import type { LaneSupply } from './supply-model.js';
import { suggestedTarget, type WasteForecast } from './waste-forecast-model.js';
import { wasteRow } from './waste-row-model.js';
import styles from './waste-forecast.module.css';

const perWorker = new Intl.NumberFormat('en-US', { maximumSignificantDigits: 3 });
const BADGE_TONE = { bad: 'danger', warn: 'warning', ok: 'success' } as const;

export interface WasteForecastRowsProps {
  forecasts: readonly { forecast: WasteForecast; lane: ResourceLaneRow }[];
  /** The live lanes from `phm fleet runs`: running, target and hold, for the target that would use the window. */
  rows: readonly LaneSupply[];
  nowMs: number;
  /** A target write is in flight somewhere in the console. */
  writing: boolean;
  /** What the last target write for a lane answered. */
  notices: Readonly<Record<string, string>>;
  onSetTarget: (lane: string, target: number) => void;
}

export function WasteForecastRows({ forecasts, rows, nowMs, writing, notices, onSetTarget }: WasteForecastRowsProps) {
  const drawn = forecasts.map(item => ({ ...item, row: wasteRow(item.forecast, item.lane, nowMs) }));
  return <>
    <p className={styles.key} data-waste-key>
      <span><WindowBarSwatch part="used" />used so far</span>
      {drawn.some(item => item.row.more !== null) ? <>
        <span><WindowBarSwatch part="more" />more by the reset at this burn</span>
        <span><WindowBarSwatch part="unused" />left unused at the reset</span>
      </> : null}
      {drawn.some(item => item.row.elapsed !== null) ? <span><WindowBarSwatch part="elapsed" />time gone, counting seven days back from the reset</span> : null}
      <span>Same data: <code>phm resources ledger</code>.</span>
    </p>
    <ul className={styles.rows}>{drawn.map(({ forecast, lane, row }) => {
      const live = rows.find(item => item.lane === forecast.lane);
      const held = live?.held || lane.held === true;
      const suggestion = live ? suggestedTarget(forecast, { ...live, held: !!held }, lane.burnPctPerHour) : null;
      const notice = notices[forecast.lane];
      return <li key={forecast.lane} className={styles.row} data-lane={forecast.lane} data-tone={row.tone}>
        <div className={styles.head}>
          <span className={styles.name}><ProviderBadge of={forecast.lane} iconOnly size={14} /><strong>{forecast.lane}</strong></span>
          <span className={styles.figure} data-figure>{row.figure}</span>
          <StatusBadge status={row.tone} tone={BADGE_TONE[row.tone]}>{row.verdict}</StatusBadge>
        </div>
        <WindowBar label={`${forecast.lane} weekly window`} valueText={row.valueText} valueNow={row.used}
          used={row.used} more={row.more} unused={row.unused} elapsed={row.elapsed} />
        <p className={styles.facts} data-facts>{row.facts.join(' · ')}</p>
        {held || suggestion || notice ? <p className={styles.act}>
          {held ? <span data-hold>held: release first</span> : null}
          {suggestion ? <>
            <span>needs target {suggestion.target} (now {live!.target}, {perWorker.format(suggestion.perWorkerPctPerHour)}%/h per worker){suggestion.target * suggestion.perWorkerPctPerHour < forecast.neededBurnPctPerHour ? ' · capped at 64; may leave usage unused' : ''}</span>
            <Button variant="subtle" size="sm" disabled={writing} onClick={() => onSetTarget(forecast.lane, suggestion.target)}>Set target {suggestion.target}</Button>
          </> : null}
          {notice ? <span role="status">{notice}</span> : null}
        </p> : null}
      </li>;
    })}</ul>
  </>;
}
