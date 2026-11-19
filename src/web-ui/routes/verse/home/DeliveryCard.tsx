/**
 * Home's Merged PRs card: the three figures the `phm home` summary holds (last hour, last 24 hours, median time to
 * merge), then the day drawn from the `phm throughput --hours 24 --json` report the Throughput pane reads: one bar per
 * hour of PRs merged, the launched, published and merged counts, and the lanes that merged. Read-only. Both reads come
 * from the same job metrics file, so the figures and the drawing agree. A count neither holds reads unknown, never 0.
 */
import type { HomeField, HomeSummary } from '../../../../core/fleet/home.js';
import type { ThroughputReport } from '../../../../core/fleet/throughput.js';
import { ProviderBadge } from '../../../components/primitives/ProviderBadge.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { THROUGHPUT_QUERIES } from '../fleet-throughput/throughput-query.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { flowSteps, hourBars, laneRows, throughputOf } from './delivery-card-model.js';
import home from './home.module.css';
import styles from './delivery-card.module.css';

const QUERY = THROUGHPUT_QUERIES[24];
const BAR_STEP = 10, BAR_WIDTH = 7, CHART_HEIGHT = 40, ZERO_HEIGHT = 1.5;
const hourOf = (stamp: string): string => new Date(stamp).toLocaleTimeString(undefined, { hour: 'numeric' });
const timeOf = (stamp: string): string => new Date(stamp).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
const prs = (count: number): string => `${count} ${count === 1 ? 'PR' : 'PRs'}`;
const duration = (seconds: number) => seconds < 90 ? { words: `${Math.round(seconds)} seconds`, short: `${Math.round(seconds)} s` } : { words: `${Math.round(seconds / 60)} minutes`, short: `${Math.round(seconds / 60)} min` };
const count = (value: number) => ({ words: String(value), short: String(value) });

/** One figure: the number large over its label. The sentence a screen reader gets is the same one `phm home` prints. */
function Figure<T>({ label, field, format }: { label: string; field: HomeField<T>; format: (value: T) => { words: string; short: string } }) {
  if (field.state !== 'ok') return <p className={styles.figure}><span className={styles.label}>{label}</span><span data-unknown>Unknown: {field.reason}</span></p>;
  const shown = format(field.value);
  return <p className={styles.figure}>
    <span className={styles.value} aria-hidden="true">{shown.short}</span><span className={styles.label} aria-hidden="true">{label}</span>
    <span className="visually-hidden">{`${label}: ${shown.words}`}</span>
  </p>;
}

/** One bar per hour, oldest first. A quiet hour is a stub on the baseline and an hour with no count is a gap, so neither passes for the other. */
function Hours({ report }: { report: ThroughputReport }) {
  const { bars, peak, known } = hourBars(report);
  if (known === 0) return <p className={styles.note} data-unknown>Hourly merges: unknown (the report holds no hourly count).</p>;
  const last = bars.at(-1)!;
  const label = `PRs merged per hour, last ${bars.length} hours: ${peak ? `busiest ${peak.merged} in the hour from ${hourOf(peak.start)}` : 'none merged'}, ${last.merged ?? 'unknown'} in the last hour.`;
  return <div className={styles.hours}>
    <svg className={styles.bars} role="img" aria-label={label} viewBox={`0 0 ${bars.length * BAR_STEP} ${CHART_HEIGHT}`} preserveAspectRatio="none">
      {bars.map((bar, index) => {
        if (bar.merged === null) return null;
        const height = bar.merged === 0 ? ZERO_HEIGHT : Math.max(ZERO_HEIGHT * 2, bar.share * CHART_HEIGHT);
        // Keyed by position: the hours roll forward on every read, and a bar that only moved must not replay its entrance.
        return <rect key={index} className={styles.bar} data-quiet={bar.merged === 0 || undefined} data-latest={index === bars.length - 1 || undefined}
          x={index * BAR_STEP + (BAR_STEP - BAR_WIDTH) / 2} y={CHART_HEIGHT - height} width={BAR_WIDTH} height={height}><title>{`${hourOf(bar.start)}: ${bar.merged} merged`}</title></rect>;
      })}
    </svg>
    <p className={styles.axis} aria-hidden="true"><span>{hourOf(bars[0]!.start)}</span><span>now</span></p>
    <p className={styles.note}>{peak ? `Busiest hour: ${prs(peak.merged!)} merged from ${hourOf(peak.start)}.` : `No PR merged in the last ${bars.length} hours.`}
      {known < bars.length ? ` Hours with no count: ${bars.length - known}.` : ''}</p>
  </div>;
}

function Day({ report }: { report: ThroughputReport }) {
  const steps = flowSteps(report);
  const { rows, more } = laneRows(report);
  return <>
    <Hours report={report} />
    {steps ? <ol className={styles.flow} aria-label={`Launched, published and merged in the last ${report.hours} hours`}>
      {steps.map(step => <li key={step.id}><strong>{step.value}</strong> {step.id}</li>)}
    </ol> : null}
    {rows.length > 0 ? <ul className={styles.lanes} aria-label={`Merged by lane, last ${report.hours} hours`}>
      {rows.map(lane => <li key={lane.name}>
        <span className={styles.lane}><ProviderBadge of={lane.name} iconOnly size={14} />{lane.name}</span>
        <span className={styles.track} aria-hidden="true"><span className={styles.fill} style={{ width: `${Math.round(lane.share * 100)}%` }} /></span>
        <span className={styles.merged}>{lane.merged} merged</span>
      </li>)}
    </ul> : null}
    {more > 0 ? <p className={styles.note}>and {more} more {more === 1 ? 'lane' : 'lanes'} in Throughput.</p> : null}
  </>;
}

export function DeliveryCard({ summary, visible = true, onOpen }: { summary: HomeSummary; visible?: boolean; onOpen: () => void }) {
  const read = useQuery(QUERY, { enabled: visible, freshMs: 0 });
  const refresh = useRefetch(QUERY);
  usePollWhileVisible(refresh, 60_000, { enabled: visible });
  const report = throughputOf(read.data);
  const failed = read.status === 'error';
  const { mergedLastHour: hour, merged24h: day, medianMergeSeconds: median } = summary;
  // One reason for all three figures is said once, not three times.
  const shared = hour.state === 'unknown' && day.state === 'unknown' && median.state === 'unknown' && hour.reason === day.reason && day.reason === median.reason ? hour.reason : null;
  return <section className={home.card} aria-label="Merged PRs">
    <h3>Merged PRs</h3>
    <div className={styles.body}>
      {shared !== null ? <p><span data-unknown>Unknown: {shared}</span></p> : <div className={styles.figures}>
        <Figure label="Last hour" field={hour} format={count} />
        <Figure label="Last 24 hours" field={day} format={count} />
        <Figure label="Median time to merge" field={median} format={duration} />
      </div>}
      {/* A failed refresh keeps the last drawing on screen; it must not read as current. */}
      {report && failed ? <p className={styles.note} data-warn role="status">Could not refresh the hourly record. Showing the reading from {timeOf(report.as_of)}.</p> : null}
      {report ? report.metrics === 'ok' ? <Day report={report} /> : <p className={styles.note} data-unknown>Hourly merges: unknown (the job metrics file could not be read).</p>
        : failed || read.data ? <p className={styles.note} data-unknown>Hourly merges: unknown (the throughput report could not be read).</p>
          : <p className={styles.note} data-reading role="status">Reading the hourly record…</p>}
    </div>
    <button type="button" className={home.action} onClick={onOpen}>Open Throughput</button>
  </section>;
}
