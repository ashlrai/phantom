import { useEffect, useRef, useState } from 'react';
import { useQuery, useRefetch, useRefresh } from '../../../data/hooks.js';
import { opsRunsQuery } from '../ops/ops-runs-queries.js';
import { opsReleasesQuery } from '../fleet-releases/fleet-releases-queries.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { useDocumentVisible, usePollWhileVisible, useSectionVisible } from '../shell/section-visibility.js';
import { markFromRuns, visitDelta, type VisitMark } from '../fleet/visit-delta.js';
import { fleetBriefWithRelease, sinceVisitLine } from './fleet-brief-model.js';
import styles from './fleet-brief.module.css';

const visitKey = 'phantom.fleet-brief.visit.v1';

function readVisit(): VisitMark | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(visitKey) ?? 'null');
    if (!value || typeof value !== 'object') return null;
    const mark = value as Record<string, unknown>;
    const number = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
    if (!number(mark.at) || !number(mark.inboxCount) || !number(mark.workers)
      || !(mark.merged24h === null || number(mark.merged24h))
      || !(mark.personalPct === null || number(mark.personalPct))) return null;
    return value as VisitMark;
  } catch { return null; }
}

export function FleetBriefPane({ visible }: Pick<PaneProps, 'visible'>) {
  const sectionVisible = useSectionVisible();
  const documentVisible = useDocumentVisible();
  const active = visible && sectionVisible && documentVisible;
  const read = useQuery(opsRunsQuery, { enabled: active, freshMs: 0 });
  const releases = useQuery(opsReleasesQuery, { enabled: active, freshMs: 0 });
  const refetch = useRefetch(opsRunsQuery);
  const refetchReleases = useRefetch(opsReleasesQuery);
  const refresh = useRefresh(opsRunsQuery);
  const refreshReleases = useRefresh(opsReleasesQuery);
  const [notice, setNotice] = useState('');
  const [previous, setPrevious] = useState<VisitMark | null>(readVisit);
  const latest = useRef<VisitMark | null>(null);
  const dirty = useRef(false);
  const wasActive = useRef(active);
  if (active && read.data) {
    latest.current = markFromRuns({ ...read.data, host: read.data.host ?? null }, Date.now());
    dirty.current = true;
  }
  useEffect(() => {
    const save = () => {
      if (!dirty.current || !latest.current) return;
      try { localStorage.setItem(visitKey, JSON.stringify(latest.current)); } catch { /* Storage can be unavailable. */ }
      dirty.current = false;
    };
    const onVisibilityChange = () => { if (document.visibilityState === 'hidden') save(); };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => { document.removeEventListener('visibilitychange', onVisibilityChange); save(); };
  }, []);
  useEffect(() => {
    if (wasActive.current && !active && dirty.current && latest.current) {
      try { localStorage.setItem(visitKey, JSON.stringify(latest.current)); } catch { /* Storage can be unavailable. */ }
      dirty.current = false;
    } else if (!wasActive.current && active) {
      setPrevious(readVisit());
    }
    wasActive.current = active;
  }, [active]);
  usePollWhileVisible(refetch, 10_000, { enabled: visible, refreshOnShow: false });
  usePollWhileVisible(refetchReleases, 60_000, { enabled: visible, refreshOnShow: false });
  const text = read.data ? fleetBriefWithRelease(read.data, releases.data, Date.now()) : '';
  const since = read.data ? sinceVisitLine(visitDelta(previous, markFromRuns({ ...read.data, host: read.data.host ?? null }, Date.now())), Date.now()) : null;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(since ? `${since}\n${text}` : text);
      setNotice('Copied');
    } catch {
      setNotice('Copy failed');
    }
  };
  return <div className={styles.pane} aria-label="Fleet brief">
    <div className={styles.actions}>
      <button type="button" onClick={() => void copy()} disabled={!text}>Copy</button>
      <button type="button" onClick={() => { refresh(); refreshReleases(); }}>Refresh</button>
      <span role="status">{notice}</span>
    </div>
    {read.data === null ? <p>The fleet runs API has not landed in this build yet.</p>
      : !read.data ? <p role="status">{read.status === 'error' ? 'Fleet runs are unavailable.' : 'Reading fleet runs…'}</p>
      : <>
        {read.status === 'error' ? <p role="status">Fleet runs could not refresh. Showing the last reading.</p> : null}
        {since ? <p role="status">{since}</p> : null}
        <textarea aria-label="Fleet brief text" readOnly value={text} rows={12} />
      </>}
  </div>;
}
