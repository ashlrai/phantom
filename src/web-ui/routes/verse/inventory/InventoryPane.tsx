/**
 * Inventory pane: everything this install can use (channels, connectors,
 * plugins, skills, tools), each with its state and one next step. Built only
 * on GET /api/verse/fleet/runs/inventory, the same list as
 * `phm inventory --json`. One fetch for the whole inventory; the kind chips
 * and the search filter it in the browser. Read-only: it never changes anything.
 * Lists, not tables, so a phone never scrolls sideways.
 */
import { useMemo, useState } from 'react';
import {
  INVENTORY_KINDS, INVENTORY_KIND_LABELS, INVENTORY_PATH, INVENTORY_SCHEMA, INVENTORY_STATES,
  type Inventory, type InventoryCounts, type InventoryItem, type InventoryKind, type InventoryParity,
} from '../../../../core/fleet/inventory-schema.js';
import { copyText } from '../../../components/primitives/clipboard.js';
import { apiGet } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import type { QueryDef } from '../../../data/queries.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import styles from './inventory.module.css';

const inventoryQuery: QueryDef<unknown> = { key: 'fleet-inventory', fetch: signal => apiGet(INVENTORY_PATH, signal) };
/** Rows drawn at once; past this the pane asks for a search instead of a long scroll. */
export const MAX_SHOWN = 200;

function asInventory(value: unknown): Inventory | null {
  const m = value as Partial<Inventory> | null;
  return m && m.schema === INVENTORY_SCHEMA && Array.isArray(m.items) && Array.isArray(m.kinds) && !!m.counts
    && !!m.parity && Array.isArray(m.parity.lanes) ? m as Inventory : null;
}

function lanesText(lanes: InventoryItem['usedByLanes']): string {
  if (lanes === 'all') return 'all lanes';
  if (lanes === 'unknown') return 'unknown';
  return lanes.length ? lanes.join(', ') : 'none';
}

const countsText = (counts: InventoryCounts): string => INVENTORY_STATES.map(s => `${counts[s] ?? 0} ${s}`).join(' · ');

/** Only for a kind the payload sent no summary for. */
function countOf(items: readonly InventoryItem[]): InventoryCounts {
  const counts: InventoryCounts = { ready: 0, 'needs setup': 0, off: 0, error: 0, unknown: 0 };
  for (const item of items) counts[item.state] = (counts[item.state] ?? 0) + 1;
  return counts;
}

function Item({ item }: { item: InventoryItem }) {
  const [copied, setCopied] = useState<'copied' | 'failed' | null>(null);
  const command = item.next?.command ?? null;
  return <li className={styles.item}>
    <div className={styles.line}>
      <strong className={styles.name}>{item.name}</strong>
      <span className={styles.state} data-state={item.state}>{item.state}</span>
    </div>
    <p className={styles.note}>{item.detail}</p>
    <p className={styles.note}>Lanes: {lanesText(item.usedByLanes)}</p>
    {item.next && <p className={styles.next}>Next: {item.next.text}</p>}
    {command !== null && <div className={styles.command}>
      <code>{command}</code>
      <button type="button" aria-label={`Copy command for ${item.name}`}
        onClick={() => { void copyText(command).then(ok => setCopied(ok ? 'copied' : 'failed')); }}>Copy</button>
      {copied && <span className={styles.note} role="status">{copied === 'copied' ? 'Copied' : 'Copy failed'}</span>}
    </div>}
  </li>;
}

function LaneGap({ parity, names }: { parity: InventoryParity; names: ReadonlyMap<string, string> }) {
  return <section className={styles.card} aria-label="Lane tool gap">
    <h4 className={styles.title}>Tool gap between lanes: {parity.widestGap}</h4>
    <p className={styles.note}>Each lane against {parity.compared} tools and connectors. Unknown is never counted as lacking.</p>
    {!parity.lanes.length ? <p className={styles.note}>No lanes known.</p> : <ul className={styles.list} aria-label="Lanes">
      {parity.lanes.map(l => <li key={l.lane} className={styles.item}>
        <div className={styles.line}>
          <strong className={styles.name}>{l.lane}</strong>
          <span>can use {l.has.length}</span>
          <span className={l.gap > 0 ? styles.lacks : undefined}>lacks {l.gap}</span>
          <span className={styles.quiet}>unknown {l.unknown}</span>
        </div>
        {l.gap > 0 && <details className={styles.note}>
          <summary>What {l.lane} lacks</summary>
          <ul className={styles.lacking}>{l.lacks.map(id => <li key={id}>{names.get(id) ?? id}</li>)}</ul>
        </details>}
      </li>)}
    </ul>}
  </section>;
}

function Loaded({ inventory }: { inventory: Inventory }) {
  const [picked, setPicked] = useState<InventoryKind | null>(null);
  const [query, setQuery] = useState('');
  const names = useMemo(() => new Map(inventory.items.map(i => [i.id, i.name])), [inventory.items]);
  const summary = picked ? inventory.kinds.find(k => k.kind === picked) : undefined;
  const inKind = picked ? inventory.items.filter(i => i.kind === picked) : inventory.items;
  const total = (kind: InventoryKind): number => inventory.kinds.find(k => k.kind === kind)?.total ?? inventory.items.filter(i => i.kind === kind).length;
  const counts = picked ? summary?.counts ?? countOf(inKind) : inventory.counts;
  const needle = query.trim().toLowerCase();
  const matched = needle ? inKind.filter(i => `${i.name}\n${i.detail}\n${i.state}`.toLowerCase().includes(needle)) : inKind;
  const shown = matched.slice(0, MAX_SHOWN);
  const chip = (kind: InventoryKind | null, label: string, count: number) =>
    <button type="button" key={kind ?? 'all'} className={styles.chip} aria-pressed={picked === kind} onClick={() => setPicked(kind)}>{label} {count}</button>;
  return <>
    <div className={styles.chips} role="group" aria-label="Kind">
      {chip(null, 'All', inventory.items.length)}
      {INVENTORY_KINDS.map(kind => chip(kind, INVENTORY_KIND_LABELS[kind], total(kind)))}
    </div>
    <p className={styles.note} aria-label="State counts">{countsText(counts)}</p>
    <label className={styles.search}>Search inventory
      <input type="search" value={query} onChange={e => setQuery(e.target.value)} />
    </label>
    {!inKind.length ? <p>No {picked ? INVENTORY_KIND_LABELS[picked].toLowerCase() : 'items'} found.</p>
      : !matched.length ? <p>Nothing matches “{query.trim()}”.</p>
        : <>
          <ul className={styles.list} aria-label="Inventory items">{shown.map(item => <Item key={item.id} item={item} />)}</ul>
          {matched.length > MAX_SHOWN && <p className={styles.note}>Showing {MAX_SHOWN} of {matched.length}. Search to narrow.</p>}
        </>}
    <LaneGap parity={inventory.parity} names={names} />
  </>;
}

export function InventoryPane({ visible }: PaneProps) {
  const read = useQuery(inventoryQuery, { enabled: visible, freshMs: 0 });
  const refresh = useRefetch(inventoryQuery);
  usePollWhileVisible(refresh, 60_000, { enabled: visible });
  const inventory = asInventory(read.data);
  return <section className={styles.root} aria-label="Inventory">
    <div className={styles.head}>
      <h3 className={styles.title}>Inventory</h3>
      <button type="button" onClick={() => refresh()}>Refresh</button>
    </div>
    <p className={styles.note}>Everything this install can use. Agents read the same list with <code>phm inventory --json</code>.</p>
    {inventory ? <Loaded inventory={inventory} />
      : read.status === 'error' || read.data !== undefined
        ? <p role="alert">Inventory: unknown (could not load). Refresh to try again.</p>
        : <p role="status">Reading inventory…</p>}
  </section>;
}
