import type { CSSProperties } from 'react';
import { gearUpdateSpoken, gearUpdateTone } from './gear-update-dot.js';
import { RailBadgeMark } from './RailStatus.js';
import { useSelfUpdateBadge } from './self-update-badge.js';

export function GearUpdateDot() {
  const label = useSelfUpdateBadge()?.label ?? null;
  const tone = gearUpdateTone(label);
  if (label === null || tone === null) return null;
  const warningStyle = { '--status-info-solid': 'var(--status-warning-solid)' } as CSSProperties;
  return (
    <span data-testid="gear-update-dot" title={label} style={tone === 'warning' ? warningStyle : undefined}>
      <RailBadgeMark badge={{ kind: 'dot', tone, spoken: gearUpdateSpoken(label) }} />
    </span>
  );
}
