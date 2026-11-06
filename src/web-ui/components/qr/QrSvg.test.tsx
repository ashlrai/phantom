import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { QrSvg } from './QrSvg.js';

it('renders a labeled, sized SVG with a quiet zone and module path', () => {
  render(<QrSvg value="https://example.com" size={240} label="Scan to connect" />);
  const svg = screen.getByRole('img', { name: 'Scan to connect' });
  expect(svg).toHaveAttribute('width', '240');
  expect(svg).toHaveAttribute('height', '240');
  expect(svg).toHaveAttribute('viewBox', '0 0 33 33');
  expect(svg.querySelector('path')).toHaveAttribute('fill', 'currentColor');
  expect(svg.querySelector('path')?.getAttribute('d')).toMatch(/^M/);
});
