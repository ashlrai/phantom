/**
 * routes/verse/shell/FleetNeedsYouRows.tsx — "Fleet on this Mac", the
 * Needs-you drawer's local group (unit C1): one row per thing only Mason
 * can fix on the fleet running here, derived in the browser by
 * fleet-needs-you.ts from GET /api/verse/fleet/runs, plus blocked release
 * PRs from GET /api/verse/release-pr.
 *
 * The rows are NOT NeedsYouItems — C0's kind union cannot carry them, so
 * they sit ABOVE the split's listbox instead of pretending to be options:
 * J / K triage and the batch picks stay with the server items untouched,
 * and each row carries its own Open button to the surface that can act
 * (Fleet ▸ Switches, Ops ▸ Live runs, Settings ▸ Connection). The whole
 * row clicks the same way, so the pointer cursor .row already pays for is
 * honest.
 *
 * Polls every 15 s — only while mounted (the drawer is open) and the
 * window is in view (usePollWhileVisible). A 404 means this build has no
 * live runs: nothing renders, and it reports answered:true with no items,
 * so "All clear" is decided by the server producers exactly as before. Any
 * other missing reading is reported as NOT answered — silence never earns
 * an all-clear.
 */
import { useEffect, useMemo, useState } from 'react';
import { Button } from '../../../components/primitives/Button.js';
import { ApiError } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { safeHref } from '../cloud/cloud-model.js';
import { openDockPane } from '../dock/dock-store.js';
import { releasePrQuery } from '../fleet/release-pr-query.js';
import { TERMINAL_PANE_ID } from '../terminal/terminal.pane.js';
import { normalizePaneId } from './dock-catalog.js';
import { setFocusMode } from './focus-mode.js';
import { deriveReleaseNeedsYou } from './release-needs-you.js';
import { closeVerseOverlay, setVerseSection, type NeedsYouSplit } from '../verse-ui-store.js';
import {
  deriveFleetNeedsYou,
  FLEET_NEEDS_YOU_POLL_MS,
  type FleetNeedsYouItem,
  type FleetNeedsYouResult,
} from './fleet-needs-you.js';
import { fleetRunsNeedsYouQuery } from './fleet-needs-you-query.js';
import { usePollWhileVisible } from './section-visibility.js';
import styles from './NeedsYouDrawer.module.css';

/**
 * What the drawer needs back: the derived result plus — when the snapshot
 * did not answer — how to read the silence for the split's coverage line
 * (a failed read "failed to answer"; anything else "isn't reporting").
 */
export interface FleetNeedsYouReport extends FleetNeedsYouResult {
  silent: 'unavailable' | 'error' | null;
}

const SEVERITY: Readonly<Record<FleetNeedsYouItem['severity'], { tone: 'high' | 'warn'; word: string }>> = {
  urgent: { tone: 'high', word: 'Urgent' },
  attention: { tone: 'warn', word: 'Attention' },
};

const SURFACE_NAME: Readonly<Record<FleetNeedsYouItem['target'], string>> = {
  fleet: 'Fleet',
  ops: 'Ops',
  settings: 'Settings',
};

const PANE_NAME: Readonly<Record<string, string>> = {
  'fleet-lanes': 'Lanes', 'fleet-supply': 'Supply', 'fleet-host': 'Mac host',
  'fleet-releases': 'Releases', 'leader-journal': 'Leader journal',
};

function revealPane(paneId: string): void {
  setFocusMode(false);
  setVerseSection('chat');
  openDockPane(paneId);
}

const ANSWERED_NONE: FleetNeedsYouResult = { answered: true, items: [] };

/** The item's target is a section — the drawer's own hand-off: close, then switch. */
function openSurface(target: FleetNeedsYouItem['target']): void {
  closeVerseOverlay();
  setVerseSection(target);
}

export function FleetNeedsYouRows({ split, nowMs, onResult }: {
  /** The drawer's current split; the group renders only on All and Fleet. */
  split: NeedsYouSplit;
  /** The drawer's ticking clock, so the stall rule ages while it is open. */
  nowMs: number;
  onResult: (report: FleetNeedsYouReport) => void;
}) {
  const [clipboard, setClipboard] = useState<Record<string, 'copied' | 'failed'>>({});
  const read = useQuery(fleetRunsNeedsYouQuery);
  const refetch = useRefetch(fleetRunsNeedsYouQuery);
  const releaseRead = useQuery(releasePrQuery);
  const refetchRelease = useRefetch(releasePrQuery);
  usePollWhileVisible(refetchRelease, FLEET_NEEDS_YOU_POLL_MS, { enabled: releaseRead.data?.kind !== 'notInBuild' });
  const notFound = read.error instanceof ApiError && read.error.status === 404;
  usePollWhileVisible(refetch, FLEET_NEEDS_YOU_POLL_MS, { enabled: !notFound });

  // A refresh that failed keeps its last data — that reading still stands
  // (Ops shows it the same way); only a read with NOTHING to show is silent.
  const result = useMemo(
    () => (notFound ? ANSWERED_NONE : deriveFleetNeedsYou(read.data, nowMs)),
    [notFound, read.data, nowMs],
  );
  const releaseItems = useMemo(
    () => deriveReleaseNeedsYou(releaseRead.status === 'error' ? undefined : releaseRead.data, nowMs),
    [releaseRead.data, releaseRead.status, nowMs],
  );
  const combined = useMemo(() => ({ ...result, items: [...result.items, ...releaseItems] }), [result, releaseItems]);
  const releaseUrls = useMemo(() => new Map(releaseRead.data?.kind === 'available'
    ? releaseRead.data.data.repos.flatMap(({ repo, pr }) => pr?.blocked
      ? [[`release-blocked:${repo}:${pr.number}`, safeHref(pr.url, 'github.com')] as const] : []) : []), [releaseRead.data]);
  const silent: FleetNeedsYouReport['silent'] = result.answered ? null : read.error ? 'error' : 'unavailable';
  useEffect(() => {
    onResult({ ...combined, silent });
  }, [onResult, combined, silent]);

  if ((split !== 'all' && split !== 'fleet') || combined.items.length === 0) return null;

  return (
    <section aria-label="Fleet on this Mac">
      <div className={styles.batch}>
        <p className={styles.rowKind}>Fleet on this Mac</p>
      </div>
      {combined.items.map((item) => {
        const severity = SEVERITY[item.severity];
        const destination = item.open;
        const paneId = destination?.kind === 'pane' ? normalizePaneId(destination.paneId) : null;
        const label = destination?.kind === 'terminal'
          ? `Open Terminal${clipboard[item.id] === 'copied' ? ' · command copied' : ''}`
          : `Open ${paneId ? PANE_NAME[paneId] ?? paneId : SURFACE_NAME[item.target]}`;
        const open = async () => {
          if (destination?.kind === 'terminal') {
            try {
              await navigator.clipboard.writeText(destination.command);
              setClipboard(previous => ({ ...previous, [item.id]: 'copied' }));
              closeVerseOverlay();
            } catch {
              // Keep the row visible so the operator can copy the command manually.
              setClipboard(previous => ({ ...previous, [item.id]: 'failed' }));
            }
            revealPane(TERMINAL_PANE_ID);
          } else if (paneId) {
            closeVerseOverlay();
            revealPane(paneId);
          } else {
            openSurface(item.target);
          }
        };
        const isRelease = releaseUrls.has(item.id);
        const href = releaseUrls.get(item.id);
        return (
          <div key={item.id} className={styles.row} data-severity={severity.tone} onClick={open}>
            <span className={styles.rule} aria-hidden="true" />
            <span className={styles.rowMain}>
              <span className={styles.rowTitle}>{item.title}</span>
              <span className={styles.runFacts}>{item.detail}</span>
              <span className={styles.runFacts}>Next: {item.nextStep}</span>
              {destination?.kind === 'terminal' && clipboard[item.id] === 'failed' && (
                <code onClick={event => event.stopPropagation()}>Copy command: {destination.command}</code>
              )}
              <span className={styles.rowMeta}>
                <span className={styles.severity} data-severity={severity.tone}>{severity.word}</span>
                <span>{SURFACE_NAME[item.target]}</span>
              </span>
            </span>
            <span onClick={(event) => event.stopPropagation()}>
              {isRelease && href && <a href={href} target="_blank" rel="noopener noreferrer" aria-label="Open release PR">Open</a>}
              {isRelease && <Button size="sm" variant="subtle" onClick={() => {
                closeVerseOverlay();
                setFocusMode(false);
                setVerseSection('chat');
                openDockPane('fleet-merges');
              }}>Open Merges</Button>}
              <Button size="sm" variant="subtle" aria-label={label} onClick={open}>
                {label}
              </Button>
            </span>
          </div>
        );
      })}
    </section>
  );
}
