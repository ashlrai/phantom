/**
 * design/appearance-contrast-matrix.test.ts — Settings ▸ Appearance promises
 * that any theme with any offered accent stays readable. This walks every
 * theme the operator can get (light, dark by toggle, dark by OS preference,
 * high contrast) against every accent preset, and checks the text that a
 * theme/accent pick actually recolors:
 *
 *   - body text (primary + secondary) on every ground it sits on;
 *   - link text (accent-derived) on the canvas and surface;
 *   - the label of a primary button on its accent fill.
 *
 * The accent channels are applied AFTER the theme block, as the appearance
 * store does with an inline style on <html> (inline beats any :root rule).
 * Everything is resolved from tokens.css, so a token retune or a new preset
 * that drops a pair under 4.5:1 fails here instead of shipping.
 */
import { describe, expect, it } from 'vitest';
import { ACCENT_PRESETS } from '../data/appearance-presets.js';
import { defaultAppearance } from '../data/appearance-store.js';
import { contrastRatio } from './contrast.js';
import { darkScope, lightScope, mediaDarkDecls, resolveToken, scopeWith, type TokenScope } from './token-probe.test-support.js';

const AA_TEXT = 4.5;

function osDarkScope(): TokenScope {
  const scope = lightScope();
  for (const [prop, value] of mediaDarkDecls()) scope.set(prop, value);
  return scope;
}

const THEMES: Array<[string, () => TokenScope]> = [
  ['light', () => lightScope()],
  ['dark', () => darkScope()],
  ['system (OS dark)', osDarkScope],
  ['high contrast', () => scopeWith([':root[data-theme="high-contrast"]'])],
];

const base = defaultAppearance();
const ACCENTS = [
  { id: 'default', h: base.accentH, s: base.accentS, l: base.accentL },
  ...ACCENT_PRESETS,
];

function withAccent(make: () => TokenScope, accent: { h: number; s: number; l: number }): TokenScope {
  const scope = make();
  scope.set('--accent-h', String(accent.h));
  scope.set('--accent-s', `${accent.s}%`);
  scope.set('--accent-l', `${accent.l}%`);
  return scope;
}

function ratio(scope: TokenScope, fg: string, bg: string): number {
  const fgValue = resolveToken(scope, fg);
  const bgValue = resolveToken(scope, bg);
  const backdrop = resolveToken(scope, '--bg-canvas') ?? '#ffffff';
  expect(fgValue, `${fg} resolves`).not.toBeNull();
  expect(bgValue, `${bg} resolves`).not.toBeNull();
  const value = contrastRatio(fgValue!, bgValue!, backdrop);
  expect(value, `${fg} on ${bg} is measurable (${fgValue} on ${bgValue})`).not.toBeNull();
  return value!;
}

const PAIRS: Array<[string, string]> = [
  ['--text-primary', '--bg-canvas'],
  ['--text-primary', '--bg-surface'],
  ['--text-primary', '--bg-surface-raised'],
  ['--text-primary', '--bg-hover'],
  ['--text-primary', '--bg-selected'],
  ['--text-secondary', '--bg-canvas'],
  ['--text-secondary', '--bg-surface'],
  ['--text-secondary', '--bg-surface-raised'],
  ['--text-link', '--bg-canvas'],
  ['--text-link', '--bg-surface'],
  // Primary button: label in --text-on-accent on an --accent-600 fill (Button.module.css).
  ['--text-on-accent', '--accent-600'],
];

describe('every theme × accent keeps text at or above 4.5:1', () => {
  it('covers the offered accents (default plus every preset)', () => {
    expect(ACCENTS.length).toBe(ACCENT_PRESETS.length + 1);
  });

  for (const [themeName, make] of THEMES) {
    describe(themeName, () => {
      for (const accent of ACCENTS) {
        it(`accent ${accent.id}`, () => {
          const scope = withAccent(make, accent);
          const failures: string[] = [];
          for (const [fg, bg] of PAIRS) {
            const value = ratio(scope, fg, bg);
            if (value < AA_TEXT) failures.push(`${fg} on ${bg} = ${value.toFixed(2)}:1`);
          }
          expect(failures).toEqual([]);
        });
      }
    });
  }
});
