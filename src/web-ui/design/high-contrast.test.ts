import { expect, it } from 'vitest';
import { contrastRatio } from './contrast.js';
import { resolveToken, scopeWith } from './token-probe.test-support.js';

it('snapshots high contrast text, controls and focus against every interactive ground', () => {
  const scope = scopeWith([':root[data-theme="high-contrast"]']);
  const ratios: Record<string, number> = {};
  for (const background of ['--bg-canvas', '--bg-surface', '--bg-surface-raised', '--bg-input', '--bg-hover', '--bg-active', '--bg-selected', '--bg-code']) {
    for (const foreground of ['--text-primary', '--text-secondary', '--text-tertiary', '--text-link', '--border-default', '--border-focus']) {
      const ratio = contrastRatio(resolveToken(scope, foreground)!, resolveToken(scope, background)!)!;
      expect(ratio, `${foreground} on ${background}`).toBeGreaterThanOrEqual(foreground.startsWith('--text') ? 7 : 3);
      ratios[`${foreground} on ${background}`] = Number(ratio.toFixed(2));
    }
  }
  expect(ratios).toMatchSnapshot();
});
