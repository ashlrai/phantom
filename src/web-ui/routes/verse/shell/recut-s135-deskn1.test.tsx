import { readFileSync } from 'node:fs';
import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { CompactNavStrip } from './CompactNavStrip.js';

it('keeps the expanded compact navigation labels on one line', () => {
  render(<CompactNavStrip active="leader" needsYouCount={null} onSelect={() => {}} />);
  expect(screen.getByRole('button', { name: 'Needs you' })).toBeTruthy();
  const css = readFileSync('src/web-ui/routes/verse/shell/CompactNavStrip.module.css', 'utf8');
  expect(css).toMatch(/\.item\s*\{[^}]*white-space:\s*nowrap\s*;/s);
});
