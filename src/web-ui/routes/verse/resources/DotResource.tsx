/**
 * routes/verse/resources/DotResource.tsx — Dot (Ashlr.) in the Resources
 * drawer (⌘.): whether the teammate is reachable, when it last wrote, and
 * whether a Dot text is waiting on the fleet. Facts come from the shared
 * comms-status read (teammate log + iMessage acks), the same read the inbox
 * Comms card and the sidebar Dot row use — the card shares their cache entry.
 * It never shows message text, senders or handles, and never invents Dot's
 * usage: Dot runs on its own allowance, which Phantom cannot read.
 */
import { apiGet } from '../../../data/client.js';
import { useQuery } from '../../../data/hooks.js';
import type { QueryDef } from '../../../data/queries.js';
import { MonogramTile } from '../apps/MonogramTile.js';
import { COMMS_STATUS_PATH, readCommsStatus } from '../fleet-inbox/comms-status-model.js';
import { DOT_USAGE_NOTE, dotResourceFromStatus, type DotResourceState } from './dot-resource-model.js';
import styles from './ResourcesDrawer.module.css';

// Same key and endpoint as the Comms status card and the sidebar Dot row: one cache entry, one wire read.
const commsStatusQuery: QueryDef<unknown> = { key: 'verse-fleet-comms-status', fetch: s => apiGet(COMMS_STATUS_PATH, s) };

const STATE_WORD: Record<DotResourceState, string> = {
  live: 'Live',
  'waiting-on-fleet': 'Waiting on the fleet',
  quiet: 'Quiet',
  'not-configured': 'Not configured',
  unknown: 'No reading yet',
};

const STATE_TONE: Record<DotResourceState, 'success' | 'warning' | 'neutral'> = {
  live: 'success',
  'waiting-on-fleet': 'warning',
  quiet: 'neutral',
  'not-configured': 'neutral',
  unknown: 'neutral',
};

export function DotResource() {
  const reading = useQuery(commsStatusQuery, { freshMs: 30_000 });
  const status = !reading || reading.error ? null : readCommsStatus(reading.data);
  const loading = reading !== undefined && reading.data === undefined && !reading.error;
  const view = dotResourceFromStatus(status, Date.now());
  return (
    <li className={styles.card} data-resource="dot" data-state={view.state}
      title={status ? `Comms status (teammate log, iMessage acks) read ${status.generatedAt}` : 'Comms status not read yet'}>
      <div className={styles.cardHead}>
        <MonogramTile monogram="Dt" engine={null} size="sm" />
        <h4 className={styles.cardName}>
          <span>Dot (Ashlr.)</span>
          <span className={styles.plan}>Astra 6 · teammate</span>
        </h4>
      </div>
      {loading ? <p className={styles.subtle} aria-busy="true">Reading Dot…</p> : (
        <>
          <p className={styles.status} data-tone={STATE_TONE[view.state]}>
            <span className={styles.statusDot} aria-hidden="true" />
            <span className={styles.statusLabel}>{STATE_WORD[view.state]}</span>
            {view.pending !== null && view.pending > 0 ? (
              <span className={styles.pill} data-tone="warning">{view.pending} waiting</span>
            ) : null}
          </p>
          <p className={styles.subtle}>{view.line}</p>
        </>
      )}
      <p className={styles.fine}>{DOT_USAGE_NOTE}</p>
    </li>
  );
}
