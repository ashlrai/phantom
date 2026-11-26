/**
 * BrandMark: the one component that draws a provider's logo, for every surface
 * that lists or sorts by company (fleet, roster, resources, composer, palette).
 * Geometry and name matching live in the brand registry
 * (src/core/brand/registry.ts); this file only renders it. Inline SVG, so the
 * mark needs no network, no image request and cannot break.
 *
 * `brand` is any lane, pool, engine or provider name ("claude-max", "OpenAI",
 * "local"). A name the registry does not know gets a monogram tile (outlined
 * square, one or two letters in currentColor), never a wrong logo, a broken
 * image or a blank. Marks draw in currentColor so they follow the theme in
 * light and dark; Claude and Gemini keep their brand hue.
 *
 * Decorative by default (aria-hidden): the provider NAME is rendered as text
 * beside the mark. Pass `title` only where the mark stands alone.
 */
import type { CSSProperties } from 'react';
import { BRANDS, isCustomLogo, monogramOf, resolveBrand } from '../../../core/brand/registry.js';

export interface BrandMarkProps {
  /** Lane, pool, engine or provider name; unknown names get a monogram. */
  brand: string | null | undefined;
  logo?: string;
  size?: number;
  /** Position when nested inside an SVG chart (e.g. a lane label). */
  x?: number;
  y?: number;
  className?: string;
  style?: CSSProperties;
  /** Accessible name; omit when the provider's name is shown as text nearby. */
  title?: string;
  /**
   * Set in a line of text, before the name it identifies: sits on the text's
   * centre line with a gap after it, and wraps with the name. One treatment,
   * so a name reads the same in a card head, a table cell and a list row.
   */
  inline?: boolean;
}

/** In ems, so the nudge and the gap follow the text the mark is set in. */
const INLINE_STYLE: CSSProperties = { verticalAlign: '-0.16em', marginInlineEnd: '0.4em' };

export function BrandMark({ brand, logo, size = 16, className, style, title, x, y, inline = false }: BrandMarkProps) {
  const id = resolveBrand(brand);
  const common = {
    x,
    y,
    width: size,
    height: size,
    className,
    'data-inline': inline ? ('true' as const) : undefined,
    style: { flex: 'none', ...(inline ? INLINE_STYLE : null), ...style } as CSSProperties,
    role: title ? ('img' as const) : undefined,
    'aria-hidden': title ? undefined : (true as const),
    'aria-label': title,
    focusable: 'false' as const,
  };
  if (isCustomLogo(logo)) {
    return <svg viewBox="0 0 24 24" {...common} data-provider="custom"><image href={logo} width="24" height="24" /></svg>;
  }
  if (!id) {
    const letters = monogramOf(brand);
    return (
      <svg viewBox="0 0 24 24" {...common} data-provider="unknown">
        <rect x="2.5" y="2.5" width="19" height="19" rx="5" fill="none" stroke="currentColor" strokeWidth="1.6" opacity="0.7" />
        <text
          x="12"
          y="12.2"
          textAnchor="middle"
          dominantBaseline="central"
          fill="currentColor"
          fontSize={letters.length > 1 ? 9 : 11}
          fontWeight={700}
          fontFamily="inherit"
        >
          {letters}
        </text>
      </svg>
    );
  }
  const spec = BRANDS[id];
  return (
    <svg viewBox={spec.viewBox} {...common} data-provider={id}>
      {spec.layers.map((layer, i) => (
        <path key={i} d={layer.d} fill={layer.fill ?? 'currentColor'} fillRule={layer.rule} opacity={layer.opacity} />
      ))}
    </svg>
  );
}
