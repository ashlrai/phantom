import { laneCapBadges, type LaneCaps } from './lane-caps.js';

/** Small plain-word capability badges; hover/focus shows a one-sentence reason (title). */
export function LaneCapBadges({ caps, lane }: { caps: LaneCaps | null | undefined; lane: string }) {
  return (
    <span role="list" aria-label={`${lane} capabilities`} style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 4 }}>
      {laneCapBadges(caps).map((b) => (
        <span key={b.key} role="listitem" data-cap={b.key} data-state={b.state} title={b.hint} aria-label={b.hint}
          style={{ fontSize: 'var(--text-xs-size)', padding: '0 6px', borderRadius: 999, border: '1px solid var(--border-subtle)', opacity: b.state === 'yes' ? 1 : 0.7, textDecoration: b.state === 'no' ? 'line-through' : undefined }}>
          {b.text}
        </span>
      ))}
    </span>
  );
}
