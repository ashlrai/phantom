/**
 * Live lane rows for the rail resource bar.
 *
 * The world snapshot has no SSE event. The bar polls GET /api/verse/world
 * at the snapshot's own cache window while it is visible — a warm read, not
 * a new network service. Rows are memoized and keep their identity until a
 * displayed field changes, so a quiet refresh does not repaint every lane.
 */
import { memo, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { WORLD_CACHE_TTL_MS } from '../../../../core/world/types.js';
import { ProviderLogo } from '../../../components/primitives/ProviderLogo.js';
import { Tooltip } from '../../../components/primitives/Tooltip.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { useDocumentVisible, usePollWhileVisible, useSectionVisible } from '../shell/section-visibility.js';
import { openResources } from './resources-store.js';
import { worldModelQuery } from './world-query.js';
import { sameWorldLaneRow, WORLD_LANE_STALE_MS, worldLaneRows, type LaneEngine, type WorldLaneRow } from './world-lane-rows.js';
import styles from './WorldLaneRows.module.css';

const AGE_CLOCK_MS = 60_000;

function useLiveNow(enabled: boolean, stamps: string, fixedNow: number | undefined): number {
  const [now, setNow] = useState(() => fixedNow ?? Date.now());
  useEffect(() => {
    if (fixedNow !== undefined) setNow(fixedNow);
  }, [fixedNow]);
  usePollWhileVisible(() => { if (fixedNow === undefined) setNow(Date.now()); }, AGE_CLOCK_MS, { enabled: enabled && fixedNow === undefined });
  useEffect(() => {
    if (!enabled || fixedNow !== undefined) return;
    const next = stamps.split('|').reduce((soon, value) => {
      const at = value ? Date.parse(value) + WORLD_LANE_STALE_MS : NaN;
      return Number.isFinite(at) && at > Date.now() ? Math.min(soon, at) : soon;
    }, Number.POSITIVE_INFINITY);
    if (!Number.isFinite(next)) return;
    const id = setTimeout(() => setNow(Date.now()), Math.max(1, next - Date.now()));
    return () => clearTimeout(id);
  }, [enabled, fixedNow, stamps, now]);
  return fixedNow ?? now;
}

function fillPercent(row: WorldLaneRow): number | null {
  if (row.forecast === 'unknown') return null;
  if (row.exhaustFraction !== null) return Math.max(0, Math.min(100, row.exhaustFraction * 100));
  switch (row.forecast) {
    case 'early':
      return 62;
    case 'on-pace':
      return 100;
    case 'underuse':
      return 100;
    default: {
      const never: never = row.forecast;
      return never;
    }
  }
}

function Mark({ engine }: { engine: LaneEngine }) {
  switch (engine) {
    case 'claude':
    case 'codex':
    case 'grok':
    case 'local':
    case 'devin':
      return <ProviderLogo engine={engine} size={14} />;
    case 'cursor':
      return <span className={styles.monogram} aria-hidden="true">Cu</span>;
    case 'dot':
      return <span className={styles.monogram} aria-hidden="true">Dt</span>;
    case 'other':
      return <span className={styles.monogram} aria-hidden="true">•</span>;
    default: {
      const never: never = engine;
      return never;
    }
  }
}

function Gauge({ row, expanded }: { row: WorldLaneRow; expanded: boolean }) {
  const timed = row.exhaustFraction !== null;
  const fill = fillPercent(row);
  const mark = timed ? Math.max(0, Math.min(100, row.exhaustFraction! * 100)) : null;
  return (
    <span
      className={styles.gauge}
      data-forecast={row.forecast}
      data-gauge={row.forecast === 'unknown' && !timed ? 'unknown' : timed ? 'timed' : 'qualitative'}
      style={{ '--fill': fill === null ? '0%' : `${fill}%` } as CSSProperties}
      role="img"
      aria-label={`Exhaustion versus reset: ${row.forecastText}`}
    >
      <span className={styles.track}>
        {fill === null ? null : <span className={styles.fill} />}
        {mark === null ? null : <span className={styles.mark} style={expanded ? { left: `${mark}%` } : { bottom: `${mark}%` }} />}
        {row.resetAt ? <span className={styles.resetMark} /> : null}
      </span>
    </span>
  );
}

const LaneButton = memo(function LaneButton({ row, expanded }: { row: WorldLaneRow; expanded: boolean }) {
  const badge = !expanded
    ? row.freshness === 'fresh' ? (row.age === 'just now' ? 'now' : row.age.replace(' ago', '')) : row.freshness === 'stale' ? 'stale' : '?'
    : row.observedAt ? `${row.freshness} · ${row.age}` : row.freshness;
  return (
    <Tooltip placement="right" content={
      <div className={styles.tip}>
        <div className={styles.tipHead}><Mark engine={row.engine} /><strong>{row.label}</strong></div>
        <div className={styles.tipLine}>Usage {row.usage}</div>
        <div className={styles.tipLine}>Remaining {row.remaining}</div>
        <div className={styles.tipLine}>Reset {row.reset}</div>
        <div className={styles.tipLine}>Burn {row.burn}</div>
        <div className={styles.tipLine}>Forecast {row.forecastText}</div>
        <div className={styles.tipLine}>Source {row.source}</div>
        <div className={styles.tipLine}>Observed {row.observedAt ? <time dateTime={row.observedAt}>{row.freshness} · {row.age}</time> : row.freshness}</div>
      </div>
    }>
      <button
        type="button"
        className={styles.row}
        data-world-lane={row.lane}
        data-freshness={row.freshness}
        aria-label={`${row.summary} Open Resources`}
        onClick={() => openResources()}
      >
        <span className={styles.line}>
          <Mark engine={row.engine} />
          {expanded ? <span className={styles.name}>{row.label}</span> : null}
          {expanded ? null : <time className={styles.badge} data-freshness={row.freshness} dateTime={row.observedAt ?? undefined}>{badge}</time>}
        </span>
        <span className={styles.line}>
          <Gauge row={row} expanded={expanded} />
          {expanded ? <span className={styles.forecast}>{row.forecastText}</span> : null}
        </span>
        {expanded ? <span className={styles.meta}>Used {row.usage} · left {row.remaining}</span> : null}
        {expanded ? <span className={styles.meta}>Burn {row.burn} · reset {row.reset}</span> : null}
        {expanded ? <span className={styles.source}>Source {row.source} · <time className={styles.badge} data-freshness={row.freshness} dateTime={row.observedAt ?? undefined}>{badge}</time></span> : null}
      </button>
    </Tooltip>
  );
}, (prev, next) => prev.expanded === next.expanded && sameWorldLaneRow(prev.row, next.row));

export function WorldLaneRows({ expanded, enabled = true, now: fixedNow, onLive, snapshot }: {
  expanded: boolean;
  enabled?: boolean;
  now?: number;
  onLive?: (live: boolean) => void;
  /** When set, skip the network and render this document. Tests and fixtures use it. */
  snapshot?: unknown;
}) {
  const provided = snapshot !== undefined;
  const sectionVisible = useSectionVisible();
  const documentVisible = useDocumentVisible();
  const visible = sectionVisible && documentVisible;
  const read = useQuery(worldModelQuery, { enabled: enabled && visible && !provided, freshMs: WORLD_CACHE_TTL_MS });
  const refresh = useRefetch(worldModelQuery);
  usePollWhileVisible(refresh, WORLD_CACHE_TTL_MS, { enabled: enabled && !provided });
  const source = provided ? snapshot : read.data;
  const live = provided || source !== undefined || read.error !== undefined;
  useEffect(() => { onLive?.(live); }, [live, onLive]);
  const hold = useRef<WorldLaneRow[]>([]);
  const preliminary = useMemo(() => (live ? worldLaneRows(source ?? null, fixedNow ?? Date.now()) : []), [live, source, fixedNow]);
  const stamps = preliminary.map((row) => row.observedAt ?? '').join('|');
  const now = useLiveNow(live && visible, stamps, fixedNow);
  const rows = useMemo(() => {
    if (!live) return hold.current;
    const next = worldLaneRows(source ?? null, now);
    const prev = hold.current;
    const stable = next.map((row, index) => prev[index] && sameWorldLaneRow(prev[index], row) ? prev[index] : row);
    hold.current = stable.length === prev.length && stable.every((row, index) => row === prev[index]) ? prev : stable;
    return hold.current;
  }, [live, source, now]);
  if (!live || rows.length === 0) return null;
  return (
    <div className={styles.group} data-expanded={expanded || undefined} data-world-lanes role="group" aria-label="Lane resources">
      {rows.map((row) => <LaneButton key={row.key} row={row} expanded={expanded} />)}
    </div>
  );
}
