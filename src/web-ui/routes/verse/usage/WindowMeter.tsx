/**
 * routes/verse/usage/WindowMeter.tsx: one quota window on the Usage section's account cards, drawn on the bar
 * every resource surface shares (components/primitives/WindowBar.tsx) so the same picture means the same thing
 * here as in the drawer, the rail and the boards.
 *
 * Four outcomes, and no two of them look alike:
 *
 *   measured        the share used as the fill, the percentage beside the label (amber or red when it is
 *                   tight; the fill stays the accent, because use is not health), and the provider's own
 *                   reset text VERBATIM (Claude's reset is prose and is never turned into a countdown).
 *   limit reached   a full red bar labelled "limit reached". The upstream writes a SENTINEL 100 for this, so
 *                   no percentage is printed and no numeric value is announced: it is a flag, not a reading.
 *   prior reading   the account is no longer observed: the figure stays, marked "prior", over a hatched
 *                   track with no value, and nothing is read against time.
 *   unknown         the shared <Epistemic/> unknown treatment plus a dashed rule and a one-line reason.
 *                   NEVER a bar: there is no reading to draw.
 *
 * Where the window's start is known (accounts-model WindowView.period, from the server's reset provenance) and
 * the caller passes its clock, a mark across the bar shows how much of the window's time has gone and the line
 * under it says so, with how far use sits from an even spend. Without a start, or without a clock, there is no
 * mark and no line; a start is never guessed.
 *
 * `prominent` is the binding constraint: the window that actually blocks work.
 */
import type { ReactNode } from 'react';
import { Epistemic } from '../../../components/primitives/Epistemic.js';
import { WindowBar, WindowBarSwatch } from '../../../components/primitives/WindowBar.js';
import { elapsedWords, leadWords, startClock, startWords, windowPace } from '../fleet-usage/window-pace-model.js';
import type { WindowView } from './accounts-model.js';
import { percentText } from './capacity-strip-model.js';
import { unknownQuality } from './usage-model.js';
import styles from './usage.module.css';

export function WindowMeter({
  view,
  ariaPrefix,
  prominent = false,
  historical = false,
  nowMs,
}: {
  view: WindowView;
  /** Account label, so every meter has a unique accessible name. */
  ariaPrefix: string;
  prominent?: boolean;
  /** The account is no longer observed; this is context from a prior verified reading. */
  historical?: boolean;
  /** The section's clock. Without it nothing is read against time. */
  nowMs?: number | undefined;
}): ReactNode {
  const name = `${ariaPrefix} ${view.label}`;
  const block = prominent ? styles.windowBlockLead : styles.windowBlock;

  if (!view.limitReached && view.usedPct === null) {
    return (
      <div className={block} data-window="unknown">
        <div className={styles.windowHead}>
          <span>{view.label}</span>
          <Epistemic quality={unknownQuality(historical ? 'No percentage was reported for this prior window reading.' : 'No percentage was reported for this window.')} label={historical ? `${name} prior reading` : name}>
            {null}
          </Epistemic>
        </div>
        <hr className={styles.unknownRule} aria-hidden="true" />
      </div>
    );
  }

  const flagged = view.limitReached;
  // A retained reading may describe an earlier window, so it is never placed against this one's time.
  const pace = historical || nowMs === undefined ? null
    : windowPace({ usedPercent: view.usedPct, resetsAt: view.resetsAt, limitReached: flagged, measured: view.measured && view.usedPct !== null, period: view.period ?? null }, nowMs);
  const lead = pace ? leadWords(pace) : null;
  const gone = pace ? `, ${elapsedWords(pace)}` : '';
  const reset = view.resetText ? <p className={styles.windowReset}>{historical ? 'Prior report: ' : null}{view.resetText}</p> : null;
  const paceLine = pace === null || nowMs === undefined ? null : (
    <p className={styles.windowPace} data-pace={pace.lead === null ? 'unread' : pace.lead < 0 ? 'behind' : pace.lead > 0 ? 'ahead' : 'level'}>
      <WindowBarSwatch part="elapsed" />
      {[elapsedWords(pace), lead, startWords(pace, startClock(nowMs))].filter(Boolean).join(' · ')}
    </p>
  );

  if (flagged) {
    return (
      <div className={block} data-window={historical ? 'prior' : 'limit'}>
        <div className={styles.windowHead}>
          <span>{view.label}</span>
          <span className={styles.windowFlag}>{historical ? 'limit reached · prior reading' : 'limit reached'}</span>
        </div>
        <WindowBar
          label={name}
          valueText={`${historical ? 'prior reading; ' : ''}the provider flagged this window as rate-limited, so no percentage is shown${historical ? '; current access unconfirmed' : ''}${gone}`}
          valueNow={null}
          used={historical ? null : 100}
          elapsed={pace?.elapsedPct ?? null}
          ending="spent"
        />
        {reset}
        {paceLine}
      </div>
    );
  }

  const usedPct = view.usedPct ?? 0;
  return (
    <div className={block} data-window={historical ? 'prior' : 'measured'}>
      <div className={styles.windowHead}>
        <span>{view.label}</span>
        <span className={styles.windowPct} data-tone={historical ? undefined : view.tone}>{percentText(usedPct)}{historical ? ' · prior' : null}</span>
      </div>
      <WindowBar
        label={`${name} ${historical ? 'prior reading used' : 'used'}`}
        valueText={`${historical ? 'Prior reading: ' : ''}${percentText(usedPct)} used${view.resetText ? `, ${historical ? 'prior report: ' : ''}${view.resetText}` : ''}${historical ? '; current access unconfirmed' : ''}${gone}`}
        valueNow={historical ? null : usedPct}
        used={historical ? null : usedPct}
        elapsed={pace?.elapsedPct ?? null}
      />
      {reset}
      {paceLine}
    </div>
  );
}
