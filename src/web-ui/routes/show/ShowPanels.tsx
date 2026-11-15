import { Link } from 'react-router-dom';
import { EpistemicBadge } from '../../components/primitives/Epistemic.js';
import type { SourceQuality } from '../../data/api-types.js';
import type { JournalEntry } from '../journal/journal-model.js';
import type { CommsThread } from './comms-model.js';
import type { QuotaGauge } from './show-model.js';
import styles from './ShowView.module.css';

export type PanelState = 'loading' | 'error' | 'ready';

function emptyText(state: PanelState, what: string): string {
  return state === 'loading' ? `Loading ${what}…` : state === 'error' ? `${what[0]!.toUpperCase()}${what.slice(1)} unavailable.` : `No recent ${what} reported.`;
}

function formatClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString(undefined, { hour12: false });
}

/**
 * The fleet's own channel: recent agent actions folded into per-session
 * threads (run / proposal / trajectory / actor) so the chatter reads like
 * a conversation, not a flat log. Thread headers deep-link into the
 * session they belong to.
 */
export function AgentComms({ threads, state, quality }: { threads: CommsThread[]; state: PanelState; quality?: SourceQuality }) {
  return (
    <section className={styles.panel} aria-label="Agent comms">
      <div className={styles.sectionHeading}>
        <span>AGENT COMMS</span>
        <span>BY SESSION</span>
      </div>
      {threads.length ? (
        <ul className={styles.feed}>
          {threads.map((thread) => (
            <li key={thread.key} className={styles.thread}>
              <div className={styles.threadHead}>
                <strong title={thread.title}>{thread.title}</strong>
                {thread.href ? (
                  <Link to={thread.href} className={styles.jump}>
                    open →
                  </Link>
                ) : null}
              </div>
              <ul className={styles.threadMsgs}>
                {thread.messages.map((msg, i) => (
                  <li key={`${msg.ts}-${i}`}>
                    <span className={styles.msgDot} data-tone={msg.tone} aria-hidden="true" />
                    <div>
                      <strong>
                        {msg.actor} · {msg.kindLabel}
                        {msg.backend ? ` · ${msg.backend}` : ''}
                      </strong>
                      <p>{msg.summary}</p>
                      <time title={msg.ts} dateTime={msg.ts}>
                        {formatClock(msg.ts)}
                      </time>
                    </div>
                  </li>
                ))}
              </ul>
              {thread.hiddenCount > 0 ? <p className={styles.more}>+{thread.hiddenCount} earlier</p> : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className={styles.empty}>{emptyText(state, 'agent comms')}</p>
      )}
      <EpistemicBadge quality={quality} label="comms" />
    </section>
  );
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
