/** The Scoreboard: five small charts of what the fleet optimizes, then the existing spend-down card. Same read as `phm fleet score --json`. */
import { useState } from 'react';
import type { ScoreKey, ScorePoint, Scoreboard, ScoreSeries, Trend } from '../../../../core/fleet/scoreboard.js';
import { LineChart } from '../../../components/charts/LineChart.js';
import { Segmented } from '../../../components/primitives/Segmented.js';
import { apiGet } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import type { QueryDef } from '../../../data/queries.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { SpendDown } from '../resources/SpendDown.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import styles from './fleet-scoreboard.module.css';

const query: QueryDef<Scoreboard> = { key: 'fleet-scoreboard', fetch: signal => apiGet('/api/verse/fleet/runs/scoreboard?days=7', signal) };
const WORDS: Record<Trend, string> = { up: '↑ up', down: '↓ down', flat: '→ flat', unknown: '? unknown' };
const percent = (v: number | null): string => v === null ? 'unknown' : `${Math.round(v * 100)}%`;
const ratio = (v: number | null): string => v === null ? 'unknown' : String(Math.round(v * 100) / 100);
const duration = (s: number | null): string => s === null ? 'unknown' : s < 60 ? `${Math.round(s)} s` : s < 3600 ? `${Math.round(s / 60)} min` : `${Math.round(s / 360) / 10} h`;

interface Card { id: string; title: string; key: ScoreKey; caption: string; value: (p: ScorePoint, hours: number) => number | null; show: (v: number | null) => string }
const CARDS: Card[] = [
  { id: 'merged', title: 'Merged per hour', key: 'merged', caption: 'PRs merged, divided by hours in the window.',
    value: (p, hours) => p.merged === null ? null : p.merged / hours, show: v => v === null ? 'unknown' : `${Math.round(v * 100) / 100} an hour` },
  { id: 'ttm', title: 'Time to merge', key: 'median_ttm_s', caption: 'Middle time from publish to merge; lower is faster.', value: p => p.median_ttm_s, show: duration },
  { id: 'yield', title: 'Merged per start', key: 'merged_per_start', caption: 'PRs merged for each job started.', value: p => p.merged_per_start, show: ratio },
  { id: 'empty', title: 'Empty share', key: 'empty_share', caption: 'Finished jobs that produced nothing.', value: p => p.empty_share, show: percent },
  { id: 'self', title: 'Self-improvement', key: 'self_improvement_share', caption: 'Merged PRs that improve phantom itself.', value: p => p.self_improvement_share, show: percent },
];

function ScoreCard({ card, series }: { card: Card; series: ScoreSeries }) {
  const size = series.span === 'hour' ? 1 : 24;
  const hours = size * series.points.length;
  const trend = series.trend[card.key];
  const current = card.value(series.current, hours);
  return <li className={styles.card} aria-label={card.title}>
    <h3>{card.title}</h3>
    <p className={styles.value}><span>{card.show(current)}</span><span className={styles.trend} data-trend={trend}>{WORDS[trend]}</span></p>
    <p className={styles.caption}>{card.caption}</p>
    <LineChart series={[{ id: card.id, label: card.title, points: series.points.map(p => ({ x: Date.parse(p.start), y: card.value(p, size) })) }]}
      height={80} formatY={v => card.show(v)} ariaLabel={`${card.title}, per ${series.span}`} />
  </li>;
}

export function ScoreboardPane({ visible }: PaneProps) {
  const read = useQuery(query, { enabled: visible, freshMs: 0 });
  const refresh = useRefetch(query);
  usePollWhileVisible(refresh, 60_000, { enabled: visible });
  const [span, setSpan] = useState<'hourly' | 'daily'>('hourly');
  const board = read.data;
  const series = board?.[span];
  return <section className={styles.root} aria-label="Scoreboard">
    <div className={styles.top}><h2>Scoreboard</h2>
      <Segmented<'hourly' | 'daily'> options={[{ value: 'hourly', label: '24 hours' }, { value: 'daily', label: `${board?.days ?? 7} days` }]}
        value={span} onChange={setSpan} size="sm" aria-label="Scoreboard window" /></div>
    {!board ? <p className={styles.note}>{read.status === 'error' ? 'Scoreboard is unknown.' : 'Reading the scoreboard…'}</p>
      : board.metrics === 'unreadable' ? <p className={styles.note}>Scoreboard: unknown (the job metrics file could not be read).</p> : null}
    <p className={styles.note}>Each arrow compares this window with the one before it. Unknown means no data, not zero.</p>
    {series && board?.metrics === 'ok' ? <ul className={styles.cards} aria-label="Scoreboard charts">{CARDS.map(card => <ScoreCard key={card.id} card={card} series={series} />)}</ul> : null}
    <SpendDown />
  </section>;
}
