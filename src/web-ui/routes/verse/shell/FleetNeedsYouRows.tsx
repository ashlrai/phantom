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
import { ApiError, apiGet, apiPost } from '../../../data/client.js';
import { useMutationHold, useQuery, useRefetch, useRefresh } from '../../../data/hooks.js';
import { safeHref } from '../cloud/cloud-model.js';
import { openDockPane } from '../dock/dock-store.js';
import { openInterjectDialog } from '../fleet/interject-dialog-store.js';
import { releasePrQuery } from '../fleet/release-pr-query.js';
import { openDropJobSheet } from '../fleet-queue/drop-job-sheet-store.js';
import { mainRedFixDraft } from '../fleet-queue/main-red-fix-draft.js';
import { postReleaseHold } from '../fleet-lanes/lane-hold-release.js';
import { TERMINAL_PANE_ID } from '../terminal/terminal.pane.js';
import { normalizePaneId } from './dock-catalog.js';
import { setFocusMode } from './focus-mode.js';
import { deriveCiNeedsYou } from './ci-needs-you.js';
import { FLEET_CI_RUNS_POLL_MS, fleetCiRunsQuery } from './fleet-ci-runs-query.js';
import { deriveLaneStallNeedsYou, laneStallId } from './lane-stall-needs-you.js';
import { deriveLaneStreakNeedsYou } from './lane-streak-needs-you.js';
import { laneStreaksQuery } from './lane-streak-query.js';
import { deriveMainHealthNeedsYou } from './main-health-needs-you.js';
import { mainHealthQuery } from './main-health-query.js';
import { selfTickNeedsYou } from './self-tick-needs-you.js';
import { deriveStraySlotsNeedsYou } from './stray-slots-needs-you.js';
import { straySlotsQuery } from './stray-slots-query.js';
import { selfTickQuery } from './self-tick-query.js';
import { runSelfTickNow, type SelfTickRunNowView } from './self-tick-run-now.js';
import { isFleetRuns } from '../ops/ops-runs-model.js';
import { derivePhoneNeedsYou, PHONE_CONNECTION_PANE } from './phone-needs-you.js';
import { phonePendingQuery } from './phone-pending-query.js';
import { deriveReleaseNeedsYou } from './release-needs-you.js';
import { deriveResetNeedsYou, mergeNeedsYou } from './reset-needs-you.js';
import { usageResetsQuery } from './usage-resets-query.js';
import { closeVerseOverlay, setVerseSection, type NeedsYouSplit } from '../verse-ui-store.js';
import {
  deriveFleetNeedsYou,
  FLEET_NEEDS_YOU_POLL_MS,
  type FleetNeedsYouItem,
  type FleetNeedsYouResult,
} from './fleet-needs-you.js';
import { fleetRunsNeedsYouQuery } from './fleet-needs-you-query.js';
import { tellLeadersPrefill } from './needs-you-tell.js';
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
  [PHONE_CONNECTION_PANE]: 'Connection',
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

/** The self-tick row's action: one locked `fleet self-tick` pass in the server process. */
function SelfTickRunNowButton({ onRan }: { onRan: (view: SelfTickRunNowView) => void }) {
  const { hasHold, token, touch } = useMutationHold();
  const [pending, setPending] = useState(false);
  async function run() {
    if (!hasHold || !token || pending) return;
    setPending(true);
    try {
      const view = await runSelfTickNow(fetch, token);
      touch();
      onRan(view);
    } finally { setPending(false); }
  }
  return <>
    <Button size="sm" disabled={!hasHold || pending} title={!hasHold ? 'Unlock to run self-tick' : undefined}
      aria-label="Run self-tick now" onClick={() => void run()}>{pending ? 'Running…' : 'Run now'}</Button>
    {!hasHold && <span>Unlock to run</span>}
  </>;
}

function ResetReleaseButton({ lane, onReleased }: { lane: string; onReleased: (lane: string) => void }) {
  const { hasHold } = useMutationHold();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  async function release() {
    if (!hasHold || pending) return;
    setPending(true);
    setError('');
    try {
      await postReleaseHold(lane, 'reset detected (Needs-you)');
      onReleased(lane);
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.detail ?? reason.message : 'The release failed.');
    } finally { setPending(false); }
  }
  return <>
    <Button size="sm" disabled={!hasHold || pending} title={!hasHold ? 'Unlock to release' : undefined}
      aria-label={`Release ${lane}`} onClick={() => void release()}>{pending ? 'Releasing…' : 'Release'}</Button>
    {!hasHold && <span>Unlock to release</span>}
    {error && <span role="status">{error}</span>}
  </>;
}

interface NeedsMasonRow { id: string; text: string }

/** NEEDS-MASON.md lines: Resolve (with an optional one-line reply) puts needs_mason.resolved on the bus. Text only, never HTML. */
function NeedsMasonRows() {
  const { hasHold, token, touch } = useMutationHold();
  const [items, setItems] = useState<NeedsMasonRow[]>([]);
  const [replies, setReplies] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    const abort = new AbortController();
    apiGet<{ items?: NeedsMasonRow[] }>('/api/verse/agent-bus/needs-mason', abort.signal)
      .then(read => setItems(Array.isArray(read.items) ? read.items.filter(row => typeof row?.id === 'string' && typeof row.text === 'string') : []))
      .catch(() => { /* a hub without the route shows nothing */ });
    return () => abort.abort();
  }, []);
  async function resolve(id: string) {
    if (!hasHold || !token || busy) { setError('Unlock to resolve.'); return; }
    setBusy(id);
    setError('');
    try {
      const reply = (replies[id] ?? '').trim();
      await apiPost('/api/verse/agent-bus/needs-mason/resolve', reply ? { itemId: id, reply } : { itemId: id }, token);
      touch();
      setItems(previous => previous.filter(row => row.id !== id));
    } catch (reason) {
      if (reason instanceof ApiError && (reason.status === 404 || reason.status === 409)) setItems(previous => previous.filter(row => row.id !== id));
      else setError(reason instanceof ApiError ? reason.detail ?? reason.message : 'The resolve failed.');
    } finally { setBusy(''); }
  }
  if (items.length === 0) return null;
  return (
    <section aria-label="Needs Mason">
      <div className={styles.batch}><p className={styles.rowKind}>Needs Mason</p></div>
      {error && <p role="status">{error}</p>}
      {items.map(row => (
        <div key={row.id} className={styles.row}>
          <span className={styles.rule} aria-hidden="true" />
          <span className={styles.rowMain}>
            <span className={styles.rowTitle}>{row.text}</span>
            <input type="text" maxLength={500} aria-label={`Reply for ${row.text}`} placeholder="Optional one-line reply"
              value={replies[row.id] ?? ''} onChange={event => setReplies(previous => ({ ...previous, [row.id]: event.target.value }))} />
          </span>
          <Button size="sm" disabled={!hasHold || busy !== ''} title={!hasHold ? 'Unlock to resolve' : undefined}
            aria-label={`Resolve ${row.text}`} onClick={() => void resolve(row.id)}>{busy === row.id ? 'Resolving…' : 'Resolve'}</Button>
        </div>
      ))}
    </section>
  );
}

export function FleetNeedsYouRows({ split, nowMs, onResult }: {
  /** The drawer's current split; the group renders only on All and Fleet. */
  split: NeedsYouSplit;
  /** The drawer's ticking clock, so the stall rule ages while it is open. */
  nowMs: number;
  onResult: (report: FleetNeedsYouReport) => void;
}) {
  const [clipboard, setClipboard] = useState<Record<string, 'copied' | 'failed'>>({});
  const [confirmation, setConfirmation] = useState('');
  const read = useQuery(fleetRunsNeedsYouQuery);
  const refetch = useRefetch(fleetRunsNeedsYouQuery);
  const resetsRead = useQuery(usageResetsQuery);
  const refetchResets = useRefetch(usageResetsQuery);
  const refreshRuns = useRefresh(fleetRunsNeedsYouQuery);
  const refreshResets = useRefresh(usageResetsQuery);
  usePollWhileVisible(refetchResets, FLEET_NEEDS_YOU_POLL_MS);
  const phoneRead = useQuery(phonePendingQuery);
  const refetchPhone = useRefetch(phonePendingQuery);
  usePollWhileVisible(refetchPhone, FLEET_NEEDS_YOU_POLL_MS);
  const releaseRead = useQuery(releasePrQuery);
  const refetchRelease = useRefetch(releasePrQuery);
  usePollWhileVisible(refetchRelease, FLEET_NEEDS_YOU_POLL_MS, { enabled: releaseRead.data?.kind !== 'notInBuild' });
  const ciRead = useQuery(fleetCiRunsQuery, { freshMs: FLEET_CI_RUNS_POLL_MS });
  const laneStreaksRead = useQuery(laneStreaksQuery);
  const refetchLaneStreaks = useRefetch(laneStreaksQuery);
  usePollWhileVisible(refetchLaneStreaks, FLEET_NEEDS_YOU_POLL_MS, { enabled: laneStreaksRead.data?.kind !== 'notInBuild' });
  const mainHealthRead = useQuery(mainHealthQuery);
  const refetchMainHealth = useRefetch(mainHealthQuery);
  usePollWhileVisible(refetchMainHealth, FLEET_NEEDS_YOU_POLL_MS, { enabled: mainHealthRead.data?.kind !== 'notInBuild' });
  const strayRead = useQuery(straySlotsQuery);
  const refetchStrays = useRefetch(straySlotsQuery);
  usePollWhileVisible(refetchStrays, FLEET_NEEDS_YOU_POLL_MS, { enabled: strayRead.data !== null });
  const strayItems = useMemo(
    () => deriveStraySlotsNeedsYou(strayRead.status === 'error' ? undefined : strayRead.data, nowMs),
    [strayRead.data, strayRead.status, nowMs],
  );
  const selfTickRead = useQuery(selfTickQuery);
  const refetchSelfTick = useRefetch(selfTickQuery);
  const refreshSelfTick = useRefresh(selfTickQuery);
  usePollWhileVisible(refetchSelfTick, FLEET_NEEDS_YOU_POLL_MS, { enabled: selfTickRead.data?.kind !== 'notInBuild' });
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
  const ciItems = useMemo(() => deriveCiNeedsYou(ciRead.status === 'error' ? undefined : ciRead.data, nowMs),
    [ciRead.data, ciRead.status, nowMs]);
  const laneStreakItems = useMemo(
    () => deriveLaneStreakNeedsYou(laneStreaksRead.status === 'error' ? undefined : laneStreaksRead.data, isFleetRuns(read.data) ? read.data : null, nowMs),
    [laneStreaksRead.data, laneStreaksRead.status, read.data, nowMs],
  );
  const laneStallItems = useMemo(
    () => deriveLaneStallNeedsYou(isFleetRuns(read.data) ? read.data : null, nowMs),
    [read.data, nowMs],
  );
  const mainHealthItems = useMemo(
    () => deriveMainHealthNeedsYou(mainHealthRead.status === 'error' ? undefined : mainHealthRead.data),
    [mainHealthRead.data, mainHealthRead.status],
  );
  const selfTickItems = useMemo(
    () => selfTickNeedsYou(selfTickRead.status === 'error' || selfTickRead.data?.kind !== 'available' ? undefined : selfTickRead.data.data.last, nowMs),
    [selfTickRead.data, selfTickRead.status, nowMs],
  );
  const resetItems = useMemo(() => deriveResetNeedsYou(resetsRead.status === 'error' ? null : resetsRead.data, nowMs),
    [resetsRead.data, resetsRead.status, nowMs]);
  const phoneItems = useMemo(() => derivePhoneNeedsYou(phoneRead.status === 'error' ? undefined : phoneRead.data),
    [phoneRead.data, phoneRead.status]);
  // The stall row says more than the plain idle one for the same lane: it wins.
  const stalled = useMemo(() => new Set(laneStallItems.map(item => item.id)), [laneStallItems]);
  const combined = useMemo(() => mergeNeedsYou({ ...result, items: [...result.items.filter(item => !(item.id.startsWith('lane-idle:') && stalled.has(laneStallId(item.id.slice('lane-idle:'.length))))), ...strayItems, ...laneStallItems, ...releaseItems, ...laneStreakItems, ...mainHealthItems, ...selfTickItems, ...ciItems, ...phoneItems] }, resetItems),
    [result, stalled, strayItems, laneStallItems, releaseItems, laneStreakItems, mainHealthItems, selfTickItems, ciItems, phoneItems, resetItems]);
  const releaseUrls = useMemo(() => new Map<string, string | null>(releaseRead.data?.kind === 'available'
    ? releaseRead.data.data.repos.flatMap(({ repo, pr }) => pr?.blocked
      ? [[`release-blocked:${repo}:${pr.number}`, safeHref(pr.url, 'github.com')] as const] : []) : []), [releaseRead.data]);
  const silent: FleetNeedsYouReport['silent'] = result.answered ? null : read.error ? 'error' : 'unavailable';
  useEffect(() => {
    onResult({ ...combined, silent });
  }, [onResult, combined, silent]);

  if (split !== 'all' && split !== 'fleet') return null;
  if (combined.items.length === 0 && !confirmation) return <NeedsMasonRows />;

  return (
    <><section aria-label="Fleet on this Mac">
      <div className={styles.batch}>
        <p className={styles.rowKind}>Fleet on this Mac</p>
      </div>
      {confirmation && <p role="status">{confirmation}</p>}
      {combined.items.map((item) => {
        const severity = SEVERITY[item.severity];
        const destination = item.open;
        const paneId = destination?.kind === 'pane' ? normalizePaneId(destination.paneId) : null;
        const label = destination?.kind === 'copy'
          ? `Copy command${clipboard[item.id] === 'copied' ? ' · copied' : ''}`
          : destination?.kind === 'terminal'
          ? `Open Terminal${clipboard[item.id] === 'copied' ? ' · command copied' : ''}`
          : `Open ${paneId ? PANE_NAME[paneId] ?? paneId : SURFACE_NAME[item.target]}`;
        const open = async () => {
          if (destination?.kind === 'copy') {
            try {
              await navigator.clipboard.writeText(destination.command);
              setClipboard(previous => ({ ...previous, [item.id]: 'copied' }));
            } catch {
              setClipboard(previous => ({ ...previous, [item.id]: 'failed' }));
            }
          } else if (destination?.kind === 'terminal') {
            try {
              await navigator.clipboard.writeText(destination.command);
              setClipboard(previous => ({ ...previous, [item.id]: 'copied' }));
              closeVerseOverlay();
            } catch {
              // Keep the row visible so the operator can copy the command manually.
              setClipboard(previous => ({ ...previous, [item.id]: 'failed' }));
            }
            revealPane(TERMINAL_PANE_ID);
          } else if (paneId === PHONE_CONNECTION_PANE) {
            closeVerseOverlay();
            setVerseSection('settings', 'fleet-sources');
          } else if (paneId) {
            closeVerseOverlay();
            revealPane(paneId);
          } else {
            openSurface(item.target);
          }
        };
        const isRelease = releaseUrls.has(item.id);
        const href = releaseUrls.get(item.id);
        const mainRedRepo = mainHealthRead.data?.kind === 'available'
          ? mainHealthRead.data.data.repos.find(repo => item.id === `main-red-${repo.repo}`)
          : undefined;
        return (
          <div key={item.id} className={styles.row} data-severity={severity.tone} onClick={open}>
            <span className={styles.rule} aria-hidden="true" />
            <span className={styles.rowMain}>
              <span className={styles.rowTitle}>{item.title}</span>
              <span className={styles.runFacts}>{item.detail}</span>
              <span className={styles.runFacts}>Next: {item.nextStep}</span>
              {(destination?.kind === 'terminal' || destination?.kind === 'copy') && clipboard[item.id] === 'failed' && (
                <code onClick={event => event.stopPropagation()}>Copy command: {destination.command}</code>
              )}
              <span className={styles.rowMeta}>
                <span className={styles.severity} data-severity={severity.tone}>{severity.word}</span>
                <span>{SURFACE_NAME[item.target]}</span>
              </span>
            </span>
            <span onClick={(event) => event.stopPropagation()}>
              {(item.id === 'self-tick-stale' || item.id === 'self-tick-failed') && <SelfTickRunNowButton onRan={view => {
                setConfirmation(view.outcome === 'ran-ok' ? 'Self-tick ran, all steps ok'
                  : view.outcome === 'ran-failed' ? `Failed: ${view.failedSteps.join(', ') || 'a step'}`
                  : view.outcome === 'busy' ? 'Another tick is running'
                  : 'The self-tick request failed.');
                refreshSelfTick();
              }} />}
              {(() => {
                const draft = mainRedRepo ? mainRedFixDraft(mainRedRepo, nowMs) : null;
                return draft && <Button size="sm" onClick={() => {
                // 'kept' means an unsent draft owns the sheet — stay in the
                // drawer so the message explains why the fix was not applied.
                if (openDropJobSheet(draft) === 'kept') {
                  setConfirmation('You have an unsent draft; the fix draft was not applied.');
                  return;
                }
                closeVerseOverlay();
                revealPane('fleet-queue');
              }}>Draft fix job</Button>;
              })()}
              {item.id.startsWith('lane-reset:') && <ResetReleaseButton lane={item.id.slice('lane-reset:'.length)} onReleased={lane => {
                setConfirmation(`Released hold for ${lane}.`);
                refreshRuns();
                refreshResets();
              }} />}
              {isRelease && href && <a href={href} target="_blank" rel="noopener noreferrer" aria-label="Open release PR">Open</a>}
              {isRelease && <Button size="sm" variant="subtle" onClick={() => {
                closeVerseOverlay();
                setFocusMode(false);
                setVerseSection('chat');
                openDockPane('fleet-merges');
              }}>Open Merges</Button>}
              {item.id === 'claude-lane-down' && destination?.kind === 'terminal' && <Button size="sm" onClick={async () => {
                try {
                  await navigator.clipboard.writeText(destination.command);
                  setClipboard(previous => ({ ...previous, [item.id]: 'copied' }));
                } catch {
                  setClipboard(previous => ({ ...previous, [item.id]: 'failed' }));
                }
              }}>{clipboard[item.id] === 'copied' ? 'Copied' : 'Copy'}</Button>}
              {item.id === 'claude-lane-down' && destination?.kind === 'terminal' && <code>{destination.command}</code>}
              <Button size="sm" variant="subtle" aria-label={label} onClick={open}>
                {label}
              </Button>
              <Button size="sm" variant="ghost" aria-label={`Tell the leaders about ${item.title}`} onClick={event => {
                event.stopPropagation();
                closeVerseOverlay();
                openInterjectDialog({ prefill: tellLeadersPrefill(item) });
              }}>Tell the leaders</Button>
            </span>
          </div>
        );
      })}
    </section>
    <NeedsMasonRows /></>
  );
}
