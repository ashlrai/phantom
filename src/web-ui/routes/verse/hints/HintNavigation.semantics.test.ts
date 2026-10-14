import { describe, expect, it } from 'vitest';
import { contrastRatio } from '../../../design/contrast.js';
import { darkScope, lightScope, moduleColor, type TokenScope } from '../../../design/token-probe.test-support.js';

const MODULE = 'routes/verse/hints/HintNavigation.module.css';
const THEMES: Array<[string, TokenScope]> = [['light', lightScope()], ['dark', darkScope()]];

describe.each(THEMES)('independent hint readability — %s theme', (_theme, scope) => {
  it.each(['.hint', '.status'])('%s small text clears the design language contrast floor', (selector) => {
    const foreground = moduleColor(scope, MODULE, selector, 'color');
    const background = moduleColor(scope, MODULE, selector, 'background');
    expect(foreground).not.toBeNull();
    expect(background).not.toBeNull();
    // Badge/status text is 12px by default, including the bold badge. It must
    // meet the normal-text floor; bold alone does not make it large text.
    expect(contrastRatio(foreground!, background!)).toBeGreaterThanOrEqual(4.5);
  });
});
