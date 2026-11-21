/**
 * routes/verse/fleet-router/DecisionFlow.tsx: the recorded decisions as a flow. What was asked is
 * on the left (the kind of work, its difficulty or who asked), the seat the router chose on the
 * right, and a band joins each pair, as thick as the number of decisions it holds. Pointing at a
 * name, or walking the names with the arrow keys, lights its bands and says them in words; Enter
 * or a click keeps the name and holds the list under the diagram to its decisions.
 * Shaping lives in decision-flow-model.ts; this file only draws it.
 */
import { useState, type KeyboardEvent } from 'react';
import type { ShadowDecisionRecord } from '../../../../core/routing/budget-store.js';
import { BrandMark } from '../../../components/primitives/BrandMark.js';
import { Segmented } from '../../../components/primitives/Segmented.js';
import { FLOW_BY, decisionFlow, flowWords, linkTouches, nodeWords, ribbonPath, stepNode, type DecisionFlow as Flow, type FlowAt, type FlowBy, type FlowPin, type FlowSide } from './decision-flow-model.js';
import styles from './decision-flow.module.css';

export interface DecisionFlowProps {
  /** The decisions drawn: the whole log read, or the one column of it being read. */
  records: readonly ShadowDecisionRecord[];
  label: (seatId: string | null) => string;
  brand: (seatId: string) => string;
  pin: FlowPin | null;
  onPin: (pin: FlowPin | null) => void;
}

const SIDE_NAME: Record<FlowSide, (by: FlowBy) => string> = {
  from: by => FLOW_BY.find(option => option.value === by)!.label,
  to: () => 'Seat chosen',
};
const pinnedAt = (flow: Flow, by: FlowBy, pin: FlowPin | null): FlowAt | null => {
  if (!pin || (pin.side === 'from' && pin.by !== by)) return null;
  const index = flow[pin.side].findIndex(node => node.key === pin.key);
  return index < 0 ? null : { side: pin.side, index };
};

export function DecisionFlow({ records, label, brand, pin, onPin }: DecisionFlowProps) {
  const [by, setBy] = useState<FlowBy>('task');
  // The name being read: under the pointer, or holding focus.
  const [read, setRead] = useState<FlowAt | null>(null);
  const flow = decisionFlow(records, by, label);
  if (!flow) return null;
  const kept = pinnedAt(flow, by, pin);
  const lit = read && flow[read.side][read.index] ? read : kept;
  const stop = lit ?? { side: 'from' as const, index: 0 };
  const choose = (next: FlowBy) => { setBy(next); setRead(null); if (pin?.side === 'from') onPin(null); };
  const toggle = (at: FlowAt) => {
    const node = flow[at.side][at.index]!;
    onPin(kept && kept.side === at.side && kept.index === at.index ? null : { by, side: at.side, key: node.key, label: node.label });
  };
  const key = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      // Esc lets go of the kept name first; a second Esc is the pane's.
      if (pin) { event.stopPropagation(); onPin(null); }
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const from = (event.target as HTMLElement).closest<HTMLElement>('[data-flow-node]');
    if (!from) return;
    const [side, index] = from.dataset['flowNode']!.split('-') as [FlowSide, string];
    const next = stepNode(flow, { side, index: Number(index) }, event.key);
    if (!next) return;
    event.preventDefault();
    event.currentTarget.querySelector<HTMLElement>(`[data-flow-node="${next.side}-${next.index}"]`)?.focus();
  };
  const side = (which: FlowSide) => <ul className={styles.side} data-side={which} aria-label={SIDE_NAME[which](by)} style={{ height: `${flow.height}px` }}>
    {flow[which].map((node, index) => {
      const at = { side: which, index };
      const here = lit?.side === which && lit.index === index;
      const none = which === 'to' && node.key === null;
      return <li key={String(node.key)} style={{ top: `${node.y}px`, height: `${node.row}px` }}>
        <button type="button" className={styles.node} data-flow-node={`${which}-${index}`} data-lit={here || undefined} data-none={none || undefined}
          aria-pressed={kept?.side === which && kept.index === index} aria-label={nodeWords(flow, at)} tabIndex={stop.side === which && stop.index === index ? 0 : -1}
          onClick={() => toggle(at)} onMouseEnter={() => setRead(at)} onFocus={() => setRead(at)} onBlur={() => setRead(null)}>
          <i className={styles.bar} style={{ height: `${node.height}px` }} />
          <span className={styles.name}>{which === 'to' && node.key !== null ? <BrandMark brand={brand(node.key)} size={14} /> : null}<span className={styles.label}>{node.label}</span></span>
          <span className={styles.count}>{node.count}</span>
        </button>
      </li>;
    })}
  </ul>;
  return <div className={styles.flow}>
    <div className={styles.head}>
      <h3>What was asked, and the seat chosen</h3>
      <Segmented size="sm" aria-label="Group requests by" options={FLOW_BY} value={by} onChange={choose} />
    </div>
    <div className={styles.diagram} role="group" aria-label={`Recorded decisions from ${SIDE_NAME.from(by).toLowerCase()} to the seat chosen`} data-reading={lit ? '' : undefined}
      onKeyDown={key} onMouseLeave={event => { if (!event.currentTarget.contains(document.activeElement)) setRead(null); }}>
      {side('from')}
      <svg className={styles.bands} viewBox={`0 0 100 ${flow.height}`} preserveAspectRatio="none" aria-hidden="true" style={{ height: `${flow.height}px` }}>
        {flow.links.map(link => <path key={`${link.from}-${link.to}`} d={ribbonPath(link)} data-band={`${link.from}-${link.to}`}
          data-lit={(lit && linkTouches(link, lit)) || undefined} data-none={flow.to[link.to]!.key === null || undefined} />)}
      </svg>
      {side('to')}
    </div>
    <p className={styles.caption} data-flow-words={lit ? `${lit.side}-${lit.index}` : ''}>
      {lit ? nodeWords(flow, lit) : `${flowWords(flow, by)} Point at a name, or use the arrow keys, to read it; Enter keeps it and lists its decisions.`}
    </p>
  </div>;
}
