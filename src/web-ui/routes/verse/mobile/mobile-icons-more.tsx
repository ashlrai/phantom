/**
 * routes/verse/mobile/mobile-icons-more.tsx — glyphs only screens past the
 * first paint draw (list rows, the voice button). Split from mobile-icons.tsx,
 * whose glyphs the phone's first paint loads.
 */
import { Icon, type IconProps } from '../../../components/primitives/icon-base.js';

export function ChevronGlyph(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m6 3.5 4.5 4.5L6 12.5" />
    </Icon>
  );
}

export function MicGlyph(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="5.75" y="1.75" width="4.5" height="8" rx="2.25" />
      <path d="M3.5 7.5a4.5 4.5 0 0 0 9 0M8 12v2.25" />
    </Icon>
  );
}

