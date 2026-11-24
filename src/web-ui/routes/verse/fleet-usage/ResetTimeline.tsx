/**
 * routes/verse/fleet-usage/ResetTimeline.tsx — "Resets ahead" on the Usage
 * board: every account window that gave a reset instant, soonest first, on
 * one line of time that starts at now. The cards below say each reset on its
 * own; this says the order they come in and how far apart.
 *
 * The line and its ticks are decoration (aria-hidden): each row carries the
 * same facts as text (name, countdown and local time, usage now). A window
 * the provider flagged as limited draws a square instead of a dot and says
 * "limit reached", so the flag never rests on colour.
 */
import type { CSSProperties } from 'react';
import { BrandMark } from '../../../components/primitives/BrandMark.js';
import type { ResetTick, ResetTimeline as Timeline } from './reset-timeline-model.js';
import styles from './reset-timeline.module.css';

const at = (leftPct: number): CSSProperties => ({ left: `${leftPct}%` });

function Ticks({ ticks, labelled = false }: { ticks: readonly ResetTick[]; labelled?: boolean }) {
  return (
    <>
      {ticks.map((tick) => (
        <span key={tick.leftPct} className={labelled ? styles.tickLabel : styles.tick} style={at(tick.leftPct)}>
          {labelled ? tick.label : null}
        </span>
      ))}
    </>
  );
}

export function ResetTimeline({ timeline }: { timeline: Timeline }) {
  return (
    <section className={styles.root} aria-labelledby="fleet-usage-resets-title">
      <h3 id="fleet-usage-resets-title" className={styles.title}>Resets ahead</h3>
      <p className={styles.summary}>{timeline.summary}</p>
      <div className={styles.row} aria-hidden="true">
        <span />
        <span className={styles.scale}>
          <span className={styles.tickLabel} data-edge="start" style={at(0)}>now</span>
          <Ticks ticks={timeline.ticks} labelled />
        </span>
      </div>
      <ol className={styles.marks} aria-label="Resets ahead, soonest first">
        {timeline.marks.map((mark) => (
          <li key={mark.key} className={styles.row} data-limit={mark.limit || undefined}>
            <span className={styles.name}>
              <BrandMark brand={mark.provider} size={12} className={styles.brand} />
              {mark.name}
            </span>
            <span className={styles.track} aria-hidden="true">
              <Ticks ticks={timeline.ticks} />
              <span className={styles.run} style={{ width: `${mark.leftPct}%` }} />
              <span className={styles.dot} style={at(mark.leftPct)} />
            </span>
            <time className={styles.when} dateTime={mark.resetsAt}>{mark.when}</time>
            <span className={styles.usage}>{mark.usage}</span>
          </li>
        ))}
      </ol>
      {timeline.undated.length > 0 && (
        <p className={styles.undated}>
          Not on the line: {timeline.undated.map((entry) => `${entry.name} (${entry.why})`).join(', ')}.
        </p>
      )}
    </section>
  );
}
