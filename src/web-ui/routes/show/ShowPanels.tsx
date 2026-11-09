import { EpistemicBadge } from '../../components/primitives/Epistemic.js';
import type { JournalEntry } from '../journal/journal-model.js';
import type { QuotaGauge } from './show-model.js';
import styles from './ShowView.module.css';

export type PanelState = 'loading' | 'error' | 'ready';

function emptyText(state: PanelState, what: string): string {
  return state === 'loading' ? `Loading ${what}…` : state === 'error' ? `${what[0]!.toUpperCase()}${what.slice(1)} unavailable.` : `No recent ${what} reported.`;
}

export function AgentFeed({ entries, state }: { entries: JournalEntry[]; state: PanelState }) {
  return <section className={styles.panel} aria-label="Agent feed">
    <div className={styles.sectionHeading}><span>AGENT FEED</span><span>LIVE</span></div>
    {entries.length ? <ul className={styles.feed}>{entries.map(entry => <li key={entry.id}>
      <span className={styles.dot} data-status={entry.statusLabel} aria-hidden="true" />
      <div><strong>{entry.title}</strong><p>{entry.repo ? `${entry.repo} · ` : ''}{entry.statusLabel}</p><time>{entry.ts}</time></div>
    </li>)}</ul> : <p className={styles.empty}>{emptyText(state, 'agent activity')}</p>}
  </section>;
}

export function WinFeed({ entries, state }: { entries: JournalEntry[]; state: PanelState }) {
  return <section className={styles.panel} aria-label="Win feed">
    <div className={styles.sectionHeading}><span>WINS</span><span>RECENT</span></div>
    {entries.length ? <ul className={styles.feed}>{entries.map(entry => <li key={entry.id}>
      <span className={styles.spark} aria-hidden="true">✦</span>
      <div><strong>{entry.title}</strong><p>{entry.detail}</p><time>{entry.ts}</time><EpistemicBadge quality={entry.sourceQuality} /></div>
    </li>)}</ul> : <p className={styles.empty}>{emptyText(state, 'wins')}</p>}
  </section>;
}

export function QuotaGauges({ gauges, state }: { gauges: QuotaGauge[]; state: PanelState }) {
  return <section className={styles.panel} aria-label="Quota gauges">
    <div className={styles.sectionHeading}><span>QUOTA</span><span>OBSERVED</span></div>
    {gauges.length ? <ul className={styles.gauges}>{gauges.map(gauge => <li key={gauge.lane}>
      <div className={styles.gaugeHead}><strong>{gauge.lane}</strong><span>{gauge.held ? 'HELD · ' : ''}{gauge.label}</span></div>
      {gauge.pct !== null && <div className={styles.track} role="meter" aria-label={`${gauge.lane} remaining`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(gauge.pct)}><div className={styles.fill} data-low={gauge.pct < 20} style={{ width: `${gauge.pct}%` }} /></div>}
    </li>)}</ul> : <p className={styles.empty}>{emptyText(state, 'quota readings')}</p>}
  </section>;
}
