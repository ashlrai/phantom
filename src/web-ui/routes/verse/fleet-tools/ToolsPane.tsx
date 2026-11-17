/**
 * Tools pane: which lane has which tool (MCP servers, CLIs, skills, plugins,
 * GitHub, web search, browser, computer use), a parity score per lane and the
 * top 3 gaps with a fix. Built only on GET /api/verse/fleet/runs/tools, the
 * same matrix as `phm tools --json`. Read-only: it never changes a tool.
 * Wide: tools by lanes with gaps highlighted. Phone: one lane at a time as a list.
 */
import { useState } from 'react';
import type { ToolMatrix, ToolValue } from '../../../../core/fleet/tool-parity.js';
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
  const refresh = useRefetch(toolsQuery);
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
