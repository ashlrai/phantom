/** The Throughput board's share bar: the window's merged PRs as one bar cut by lane, repo or tier, with each part named under it.
 * Shaping lives in throughput-share-model.ts. Nothing is drawn when a count is unknown or nothing merged. */
import type { CSSProperties } from 'react';
import type { ThroughputBy, ThroughputGroup } from '../../../../core/fleet/throughput.js';
import { seriesColor } from '../../../components/charts/colors.js';
import { BrandMark } from '../../../components/primitives/BrandMark.js';
import { groupWords, mergedShare, type ShareSegment } from './throughput-share-model.js';
import styles from './throughput-share.module.css';

const key = (segment: ShareSegment): string => `${segment.kind}:${segment.name ?? ''}`;
// The unnamed part is hatched by the stylesheet; the folded tail takes the neutral colour seriesColor gives past its slots.
const tint = (segment: ShareSegment): CSSProperties | undefined => segment.kind === 'unnamed' ? undefined : { background: seriesColor(segment.slot ?? -1) };

export function ThroughputShare({ groups, by }: { groups: readonly ThroughputGroup[]; by: ThroughputBy | undefined }) {
  const share = mergedShare(groups, by);
  if (!share) return null;
  const words = groupWords(by);
  return <div className={styles.share} data-share={by ?? 'lane'}>
    <p className={styles.lead}><strong>{share.total}</strong> merged {share.total === 1 ? 'PR' : 'PRs'}, by {words.one}</p>
    {/* The sentence carries every count; the legend under the bar repeats them for the eye. */}
    <div className={styles.bar} role="img" aria-label={share.words}>
      {share.segments.map(segment => <span key={key(segment)} className={styles.part} data-kind={segment.kind} style={{ ...tint(segment), flexGrow: segment.merged }} />)}
    </div>
    <ul className={styles.legend} aria-hidden="true">
      {share.segments.map(segment => <li key={key(segment)} data-kind={segment.kind}>
        <span className={styles.swatch} data-kind={segment.kind} style={tint(segment)} />
        {by === 'lane' && segment.kind === 'named' ? <BrandMark brand={segment.name} size={14} /> : null}
        <span className={styles.name}>{segment.label}</span>
        <span className={styles.count}>{segment.merged}</span>
        <span className={styles.percent}>{segment.percent}</span>
      </li>)}
    </ul>
  </div>;
}
