import { describe, expect, it } from 'vitest';
import * as cli from '../src/cli/fleet-empty-why.js';
import { classifyEmptyLog, FLEET_EMPTY_WHY_REASONS } from '../src/core/fleet/empty-why-classify.js';

describe('empty-why classifier', () => {
  it('is re-exported unchanged by the CLI module', () => {
    expect(cli.classifyEmptyLog).toBe(classifyEmptyLog);
    expect(cli.FLEET_EMPTY_WHY_REASONS).toBe(FLEET_EMPTY_WHY_REASONS);
  });
  it.each([
    ['ESLint failed', 'lint-env'],
    ['process exited with code 130', 'interrupted'],
    ['job blocked on input', 'blocked'],
    ['You hit your usage limit', 'limit'],
    ['all quiet', 'other'],
    [null, 'other'],
  ])('tags %j as %s the same as the CLI', (log, reason) => {
    expect(classifyEmptyLog(log)).toBe(reason);
    expect(cli.classifyEmptyLog(log)).toBe(reason);
  });
  it('looks only at the last 60 lines', () => {
    expect(classifyEmptyLog(['usage limit', ...Array(60).fill('ok')].join('\n'))).toBe('other');
  });
});
