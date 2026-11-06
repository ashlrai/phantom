import { describe, expect, it } from 'vitest';

import { parseArgs, selectProjects } from '../scripts/typecheck-fast.mjs';

describe('parseArgs', () => {
  it('rejects an unknown option', () => {
    expect(() => parseArgs(['--bogus'])).toThrow('Unknown option: --bogus');
  });

  it('rejects an invalid --project value', () => {
    expect(() => parseArgs(['--project', 'unknown'])).toThrow('Invalid --project');
  });

  it('accepts valid --project values', () => {
    expect(parseArgs(['--project', 'backend']).project).toBe('backend');
    expect(parseArgs(['--project', 'web']).project).toBe('web');
    expect(parseArgs(['--project', 'all']).project).toBe('all');
  });

  it('sets seed to false when --no-seed is passed', () => {
    expect(parseArgs(['--no-seed']).seed).toBe(false);
  });

  it('sets json to true when --json is passed', () => {
    expect(parseArgs(['--json']).json).toBe(true);
  });

  it('throws when --slots 0 is passed', () => {
    expect(() => parseArgs(['--slots', '0'])).toThrow('Invalid slots');
  });
});

describe('selectProjects', () => {
  it('returns both projects when projectFlag is all', () => {
    expect(selectProjects([], 'all')).toEqual(['backend', 'web']);
  });

  it('returns only the requested project when explicitly specified', () => {
    expect(selectProjects([], 'web')).toEqual(['web']);
  });
});
