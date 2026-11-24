import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { BRAND_IDS, BRANDS } from '../../../core/brand/registry.js';
import { BrandMark } from './BrandMark.js';

afterEach(cleanup);

const svgOf = (c: HTMLElement) => c.querySelector('svg')!;

describe('BrandMark', () => {
  it('draws a real logo for every registered brand, in currentColor unless it has a brand hue', () => {
    for (const id of BRAND_IDS) {
      const { container, unmount } = render(<BrandMark brand={id} />);
      const svg = svgOf(container);
      expect(svg.getAttribute('data-provider')).toBe(id);
      expect(svg.getAttribute('viewBox')).toBe(BRANDS[id].viewBox);
      const paths = svg.querySelectorAll('path');
      expect(paths).toHaveLength(BRANDS[id].layers.length);
      paths.forEach((p, i) => expect(p.getAttribute('fill')).toBe(BRANDS[id].layers[i]!.fill ?? 'currentColor'));
      expect(svg.querySelector('text')).toBeNull();
      unmount();
    }
  });

  it('resolves lane, pool and vendor names to the right logo', () => {
    for (const [name, id] of [['claude-max', 'claude'], ['codex-personal', 'codex'], ['xAI', 'grok'], ['Cognition', 'devin'], ['gemini', 'gemini'], ['cursor', 'cursor'], ['ollama', 'local']]) {
      const { container, unmount } = render(<BrandMark brand={name} />);
      expect(svgOf(container).getAttribute('data-provider'), name).toBe(id);
      unmount();
    }
  });

  it('gives unknown providers a monogram tile, never blank or an image', () => {
    for (const name of ['zai', 'agy-lane', '', null, undefined]) {
      const { container, unmount } = render(<BrandMark brand={name} />);
      const svg = svgOf(container);
      expect(svg.getAttribute('data-provider')).toBe('unknown');
      expect(svg.querySelector('text')!.textContent).toMatch(/^[A-Z?]{1,2}$/);
      expect(svg.querySelector('rect')).not.toBeNull();
      unmount();
    }
  });

  it('is decorative by default and labelled when given a title', () => {
    const decorative = render(<BrandMark brand="claude" />);
    expect(svgOf(decorative.container).getAttribute('aria-hidden')).toBe('true');
    expect(svgOf(decorative.container).getAttribute('role')).toBeNull();
    decorative.unmount();
    const { getByRole } = render(<BrandMark brand="zai" title="Zai" />);
    expect(getByRole('img', { name: 'Zai' })).toBeTruthy();
  });

  it('applies size, position and class for SVG chart labels', () => {
    const { container } = render(<svg><BrandMark brand="grok" x={5} y={7} size={12} className="c" /></svg>);
    const mark = container.querySelector('svg svg')!;
    expect(mark.getAttribute('width')).toBe('12');
    expect(mark.getAttribute('x')).toBe('5');
    expect(mark.getAttribute('y')).toBe('7');
    expect(mark.getAttribute('class')).toBe('c');
  });

  it('sets inline before a name: on the text centre line with a gap after it, a logo or a monogram alike', () => {
    for (const name of ['claude', 'zai']) {
      const { container, unmount } = render(<span><BrandMark brand={name} size={14} inline />{name}</span>);
      const mark = svgOf(container);
      expect(mark.getAttribute('data-inline')).toBe('true');
      expect(mark.style.verticalAlign).toBe('-0.16em');
      expect(mark.style.marginInlineEnd).toBe('0.4em');
      expect(mark.getAttribute('aria-hidden')).toBe('true');
      unmount();
    }
    // Without it nothing is nudged, and a caller's style still wins over the inline one.
    const plain = svgOf(render(<BrandMark brand="claude" />).container);
    expect(plain.hasAttribute('data-inline')).toBe(false);
    expect(plain.style.verticalAlign).toBe('');
    const own = svgOf(render(<BrandMark brand="claude" inline style={{ marginInlineEnd: '1em' }} />).container);
    expect(own.style.marginInlineEnd).toBe('1em');
  });

  it('loads no asset over the network: inline markup only, no fetch, no image or external reference', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const html = [...BRAND_IDS, 'zai'].map(id => render(<BrandMark brand={id} />).container.innerHTML).join('');
    vi.unstubAllGlobals();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(html).not.toMatch(/<img|<image|<use|href=|src=|url\(|https?:/i);
  });
});
