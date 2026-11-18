/**
 * Tools pane: which lane has which tool (MCP servers, CLIs, skills, plugins,
 * GitHub, web search, browser, computer use), a parity score per lane and the
 * top 3 gaps with a fix. Built only on GET /api/verse/fleet/runs/tools, the
 * same matrix as `phm tools --json`. Read-only: it never changes a tool.
 * The Tool parity card on top is `phm tools parity --json`: lanes by tool family.
 * Wide: tools by lanes with gaps highlighted. Phone: one lane at a time as a list.
 */
import { useCallback, useState } from 'react';
import type { LaneParityMatrix, ParityState, ToolMatrix, ToolValue } from '../../../../core/fleet/tool-parity.js';
import { apiGet } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import type { QueryDef } from '../../../data/queries.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { useViewport } from '../shell/viewport.js';
import styles from './fleet-tools.module.css';

export const TOOLS_PATH = '/api/verse/fleet/runs/tools';
const toolsQuery: QueryDef<unknown> = { key: 'fleet-tools-matrix', fetch: signal => apiGet(TOOLS_PATH, signal) };

function asMatrix(value: unknown): ToolMatrix | null {
  const m = value as Partial<ToolMatrix> | null;
  return m && m.schema === 'tools.matrix.v1' && Array.isArray(m.lanes) && Array.isArray(m.rows) && Array.isArray(m.scores)
    && Array.isArray(m.topGaps) && Array.isArray(m.sources) ? m as ToolMatrix : null;
}

export const PARITY_PATH = `${TOOLS_PATH}/parity`;
const parityQuery: QueryDef<unknown> = { key: 'fleet-tools-parity', fetch: signal => apiGet(PARITY_PATH, signal) };

function asParity(value: unknown): LaneParityMatrix | null {
  const m = value as Partial<LaneParityMatrix> | null;
  return m && m.schema === 'tools.parity.v2' && Array.isArray(m.families) && Array.isArray(m.lanes) && !!m.counts ? m as LaneParityMatrix : null;
}
const stateClass = (s: ParityState): string | undefined => (s === 'missing' ? styles.no : s === 'unknown' ? styles.unknown : undefined);

/** Lanes by tool family, with one fix per missing cell. Same table style as the matrix below. */
function ParityCard({ data, failed }: { data: unknown; failed: boolean }) {
  const m = asParity(data);
  const fixes = m?.lanes.flatMap(l => m.families.filter(f => l.cells[f.id].fix).map(f => ({ key: `${l.lane} ${f.id}`, what: `${l.lane}: ${f.label}`, fix: l.cells[f.id].fix! }))) ?? [];
  return <section className={styles.card} aria-label="Tool parity">
    <h4 className={styles.title}>Tool parity</h4>
    {!m ? <p className={styles.note}>{failed || data !== undefined ? 'Tool parity: unknown (could not load).' : 'Reading tool parity…'}</p> : <>
      <p className={styles.note}>{m.counts.present} present, {m.counts.missing} missing, {m.counts.unknown} unknown. Agents read this with <code>phm tools parity --json</code>.</p>
      <div className={styles.scroll}>
        <table className={styles.table} aria-label="Tool parity by lane">
          <thead><tr><th scope="col">Lane</th>{m.families.map(f => <th scope="col" key={f.id}>{f.label}</th>)}</tr></thead>
          <tbody>{m.lanes.map(l => <tr key={l.lane}>
            <th scope="row">{l.lane}</th>
            {m.families.map(f => { const c = l.cells[f.id]; return <td key={f.id} className={stateClass(c.state)} title={c.source ? `${c.state}, from ${c.source}` : 'not declared by any source'}>{c.state}</td>; })}
          </tr>)}</tbody>
        </table>
      </div>
      {fixes.length > 0 && <ul className={styles.gaps} aria-label="Parity fixes">
        {fixes.map(x => <li key={x.key}><strong className={styles.no}>{x.what}</strong><span className={styles.fix}>{x.fix}</span></li>)}
      </ul>}
    </>}
  </section>;
}

const MARK: Record<ToolValue, string> = { yes: 'yes', no: 'no', unknown: '?' };
const cellClass = (v: ToolValue): string | undefined => (v === 'no' ? styles.no : v === 'unknown' ? styles.unknown : undefined);
const cellTitle = (v: ToolValue, source: string | null): string => (source ? `${v}, from ${source}` : 'not declared by any source');

function TopGaps({ matrix }: { matrix: ToolMatrix }) {
  if (!matrix.topGaps.length) return <p className={styles.note}>No gaps: every lane has every tool.</p>;
  return <ol className={styles.gaps} aria-label="Top gaps">
    {matrix.topGaps.map(g => <li key={g.need}>
      <strong className={g.state === 'missing' ? styles.no : undefined}>{g.label} {g.state} on {g.lanes.join(', ')}</strong>
      <span className={styles.fix}>{g.fix}</span>
    </li>)}
  </ol>;
}

function MatrixTable({ matrix }: { matrix: ToolMatrix }) {
  return <div className={styles.scroll}>
    <table className={styles.table} aria-label="Tools by lane">
      <thead><tr><th scope="col">Tool</th>{matrix.scores.map(s => <th scope="col" key={s.lane}>{s.lane}<span className={styles.score}>{s.score}%</span></th>)}</tr></thead>
      <tbody>{matrix.rows.map(row => <tr key={row.need}>
        <th scope="row">{row.label}</th>
        {matrix.lanes.map(lane => { const c = row.cells[lane]!; return <td key={lane} className={cellClass(c.value)} title={cellTitle(c.value, c.source)}>{MARK[c.value]}</td>; })}
      </tr>)}</tbody>
    </table>
  </div>;
}

function LaneList({ matrix }: { matrix: ToolMatrix }) {
  const [picked, setPicked] = useState<string | null>(null);
  const lane = picked && matrix.lanes.includes(picked) ? picked : matrix.lanes[0]!;
  return <>
    <label className={styles.note}>Lane{' '}
      <select value={lane} onChange={e => setPicked(e.target.value)}>
        {matrix.scores.map(s => <option key={s.lane} value={s.lane}>{s.lane} · {s.score}%</option>)}
      </select>
    </label>
    <ul className={styles.list} aria-label={`${lane} tools`}>
      {matrix.rows.map(row => { const c = row.cells[lane]!; return <li key={row.need}>
        <span>{row.label}{c.source && <span className={styles.source}> · {c.source}</span>}</span>
        <strong className={cellClass(c.value)}>{MARK[c.value]}</strong>
      </li>; })}
    </ul>
  </>;
}

export function ToolsPane({ visible }: PaneProps) {
  const read = useQuery(toolsQuery, { enabled: visible, freshMs: 0 });
  const parity = useQuery(parityQuery, { enabled: visible, freshMs: 0 });
  const refreshTools = useRefetch(toolsQuery);
  const refreshParity = useRefetch(parityQuery);
  const refresh = useCallback(() => { refreshTools(); refreshParity(); }, [refreshTools, refreshParity]);
  usePollWhileVisible(refresh, 60_000, { enabled: visible });
  const { compact } = useViewport();
  const matrix = asMatrix(read.data);
  const unread = matrix?.sources.filter(s => s.state === 'degraded').map(s => s.name) ?? [];
  return <section className={styles.root} aria-label="Tools">
    <div className={styles.head}>
      <h3 className={styles.title}>Tools</h3>
      <button type="button" onClick={() => refresh()}>Refresh tools</button>
    </div>
    <p className={styles.note}>Which lane has which tool. ? means no source says. Agents read the same view with <code>phm tools --json</code>.</p>
    <ParityCard data={parity.data} failed={parity.status === 'error'} />
    {!matrix ? (read.status === 'error' || read.data !== undefined
      ? <p role="alert">Tools: unknown (could not load). Refresh to try again.</p>
      : <p role="status">Reading tools…</p>)
      : !matrix.lanes.length ? <p>No lanes found.</p>
        : <>
          <TopGaps matrix={matrix} />
          {compact ? <LaneList matrix={matrix} /> : <MatrixTable matrix={matrix} />}
          {unread.length > 0 && <p className={styles.note}>Could not read: {unread.join(', ')}.</p>}
        </>}
  </section>;
}
