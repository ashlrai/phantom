import { providerFor } from '../../../core/fleet/provider.js';
import { BrandMark } from './BrandMark.js';

/**
 * The provider behind a map node or connection: its mark, then its name.
 * `of` is a model id, lane or provider name; `lane` is the fallback when `of`
 * is not recognised. Unknown draws a neutral "?" tile, never a guessed logo.
 * Pass `iconOnly` where the name would crowd the line; the mark then carries the name.
 */
export function ProviderBadge({ of, lane, size = 14, iconOnly = false, className }: {
  of: string | null | undefined; lane?: string | null; size?: number; iconOnly?: boolean; className?: string;
}) {
  const provider = providerFor(of, lane);
  const label = provider.name === 'unknown' ? 'Provider unknown' : provider.name;
  return <span className={className} data-provider-badge={provider.name} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3em', verticalAlign: 'middle' }}>
    <BrandMark brand={provider.brand ?? provider.letter} size={size} title={iconOnly ? label : undefined}
      style={provider.brand ? undefined : { color: provider.color }} />
    {!iconOnly && provider.name}
  </span>;
}
