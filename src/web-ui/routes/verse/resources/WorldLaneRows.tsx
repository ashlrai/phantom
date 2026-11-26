/**
 * Live lane rows for the rail resource bar.
 *
 * The world snapshot has no SSE event. The bar polls GET /api/verse/world
 * at the snapshot's own cache window while it is visible — a warm read, not
 * a new network service. Rows are memoized and keep their identity until a
 * displayed field changes, so a quiet refresh does not repaint every lane.
 */
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { WORLD_CACHE_TTL_MS } from '../../../../core/world/types.js';
import { BrandMark } from '../../../components/primitives/BrandMark.js';
import { WindowBar, WindowBarSwatch } from '../../../components/primitives/WindowBar.js';
import { Tooltip } from '../../../components/primitives/Tooltip.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { useDocumentVisible, usePollWhileVisible, useSectionVisible } from '../shell/section-visibility.js';
import { openResources } from './resources-store.js';
import { worldModelQuery } from './world-query.js';
import { sameWorldLaneRow, WORLD_LANE_STALE_MS, worldLaneRows, type LaneEngine, type WorldLaneRow } from './world-lane-rows.js';
import styles from './WorldLaneRows.module.css';
import { BurnSparkline } from './BurnSparkline.js';

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

function Mark({ engine }: { engine: LaneEngine }) {
  switch (engine) {
    case 'claude':
    case 'codex':
    case 'grok':
    case 'local':
    case 'devin':
    case 'cursor':
    case 'gemini':
      return <BrandMark brand={engine} size={14} />;
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

function Bar({ row, expanded }: { row: WorldLaneRow; expanded: boolean }) {
  const { bar } = row;
  return <WindowBar className={styles.bar} size={expanded ? 'bar' : 'edge'} label={`${row.label} used`} valueText={bar.text}
    valueNow={bar.used} used={bar.used} more={bar.more} unused={bar.unused} ending={bar.ending} />;
}

const PROVIDER: Record<LaneEngine, string> = {
  claude: 'Claude', codex: 'Codex', devin: 'Devin', grok: 'Grok', cursor: 'Cursor', gemini: 'Gemini', dot: 'Dot', local: 'Local', other: 'Other',
};

/** The one state chip an expanded row shows: live, stale with its age, or not connected. */
export function laneStateChip(row: WorldLaneRow): string {
  if (row.freshness === 'fresh') return `live · ${row.age === 'just now' ? 'now' : row.age.replace(' ago', '')}`;
  if (row.freshness === 'stale') return row.age === 'unknown' ? 'stale' : `stale · ${row.age}`;
  return 'not connected';
}

/** Measured facts only; an unmeasured field is left out instead of printed as unknown. */
function measuredLine(row: WorldLaneRow): string | null {
  const parts = [
    row.usage === 'unknown' ? null : `Used ${row.usage}`,
    row.remaining === 'unknown' ? null : `${row.remaining} left`,
    row.forecast === 'unknown' ? null : row.forecastText,
  ].filter((part): part is string => part !== null);
  return parts.length ? parts.join(' · ') : null;
}

const LaneButton = memo(function LaneButton({ row, expanded, now }: { row: WorldLaneRow; expanded: boolean; now: number }) {
  const badge = !expanded
    ? row.freshness === 'fresh' ? (row.age === 'just now' ? 'now' : row.age.replace(' ago', '')) : row.freshness === 'stale' ? 'stale' : '?'
    : laneStateChip(row);
  const measured = measuredLine(row);
  const metered = row.bar.used !== null || row.forecast !== 'unknown' || row.resetAt !== null;
  return (
    <Tooltip placement="right" content={
      <div className={styles.tip}>
        <div className={styles.tipHead}><Mark engine={row.engine} /><strong>{row.label}</strong></div>
        <div className={styles.tipLine}>Usage {row.usage}</div>
        <div className={styles.tipLine}>Window {row.bar.text}</div>
        <div className={styles.tipLine}>Remaining {row.remaining}</div>
        <div className={styles.tipLine}>Reset {row.reset}</div>
        <div className={styles.tipLine}>Burn {row.burn}</div>
        <div className={styles.tipLine}>Forecast {row.forecastText}</div>
        <div className={styles.tipLine}>Source {row.source}</div>
        <div className={styles.tipLine}>Observed {row.observedAt ? <time dateTime={row.observedAt} title={row.observedAt}>{row.freshness} · {row.age}</time> : row.freshness}</div>
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
          {expanded && row.bar.figure ? <span className={styles.figure} data-figure>{row.bar.figure}</span> : null}
          <time className={styles.badge} data-freshness={row.freshness} dateTime={row.observedAt ?? undefined} title={row.observedAt ?? undefined}>{badge}</time>
        </span>
        <Bar row={row} expanded={expanded} />
        {expanded && row.bar.used !== null ? <span className={styles.note} data-ending={row.bar.ending}>{row.bar.note}</span> : null}
        {expanded && row.resetIn ? <span className={styles.forecast}>{row.resetIn}</span> : null}
        {expanded && measured ? <span className={styles.meta}>{measured}</span> : null}
        {expanded ? <BurnSparkline history={row.history} now={now} /> : null}
        {expanded && row.freshness === 'unknown' && !measured && !metered ? <span className={`${styles.meta} ${styles.unmeasured}`}>Not measured yet · connect</span> : null}
      </button>
    </Tooltip>
  );
}, (prev, next) => prev.expanded === next.expanded && prev.now === next.now && sameWorldLaneRow(prev.row, next.row));

function providerGroups(rows: readonly WorldLaneRow[]): Array<{ engine: LaneEngine; rows: WorldLaneRow[] }> {
  const groups: Array<{ engine: LaneEngine; rows: WorldLaneRow[] }> = [];
  for (const row of rows) {
    const group = groups.find((entry) => entry.engine === row.engine);
    if (group) group.rows.push(row);
    else groups.push({ engine: row.engine, rows: [row] });
  }
  return groups;
}

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
      {expanded ? providerGroups(rows).map((group) => (
        <div key={group.engine} className={styles.provider} role="group" aria-label={`${PROVIDER[group.engine]} resources`}>
          <span className={styles.providerName} aria-hidden="true"><Mark engine={group.engine} /> {PROVIDER[group.engine]}</span>
          {group.rows.map((row) => <LaneButton key={row.key} row={row} expanded now={now} />)}
        </div>
      )) : rows.map((row) => <LaneButton key={row.key} row={row} expanded={false} now={now} />)}
      {expanded && rows.some((row) => row.bar.more !== null) ? <p className={styles.key} data-lane-key>
        <span><WindowBarSwatch part="used" />used</span>
        <span><WindowBarSwatch part="more" />more by the reset</span>
        <span><WindowBarSwatch part="unused" />unused then</span>
      </p> : null}
    </div>
  );
}
