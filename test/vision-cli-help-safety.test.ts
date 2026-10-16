import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const effects = vi.hoisted(() => ({
  applyEvolution: vi.fn(),
  adoptBriefing: vi.fn(),
  readLatestBriefingDetailed: vi.fn(),
  loadConfig: vi.fn(() => ({})),
}));

vi.mock('../src/core/config.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/core/config.js')>(),
  loadConfig: effects.loadConfig,
}));

vi.mock('../src/core/vision/spec.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/core/vision/spec.js')>(),
  applyEvolution: effects.applyEvolution,
}));

vi.mock('../src/core/vision/strategist.js', () => ({
  readLatestBriefingDetailed: effects.readLatestBriefingDetailed,
  adoptBriefing: effects.adoptBriefing,
}));

import { cmdVision } from '../src/cli/vision.js';

let stdout = '';
let stderr = '';

beforeEach(() => {
  effects.applyEvolution.mockReset();
  effects.applyEvolution.mockImplementation((id: string) => ({ id, version: 2, northStar: 'x' }));
  effects.adoptBriefing.mockReset();
  effects.readLatestBriefingDetailed.mockReset();
  effects.readLatestBriefingDetailed.mockReturnValue({ sourceState: 'ready', briefing: null });
  stdout = '';
  stderr = '';
  vi.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => { stdout += parts.join(' ') + '\n'; });
  vi.spyOn(console, 'error').mockImplementation((...parts: unknown[]) => { stderr += parts.join(' ') + '\n'; });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('vision <verb> --help never runs the verb', () => {
  it.each([
    [['approve', '--help']],
    [['reconcile', '-h']],
    [['set', '--north-star', 'New north star', '--help']],
    [['set', '--north-star', '--help']],
    [['show', '--help']],
    [['-h']],
  ])('%j prints usage without touching the spec or briefings', async (args) => {
    await expect(cmdVision(args)).resolves.toBe(0);
    expect(effects.applyEvolution).not.toHaveBeenCalled();
    expect(effects.readLatestBriefingDetailed).not.toHaveBeenCalled();
    expect(effects.adoptBriefing).not.toHaveBeenCalled();
    expect(stdout).toContain('Usage: phm vision <subcommand>');
  });
});

describe('vision mutations refuse unknown arguments', () => {
  it('set refuses an unknown flag instead of editing the spec', async () => {
    await expect(cmdVision(['set', '--north-star', 'Ship it', '--dry-run'])).resolves.toBe(2);
    expect(effects.applyEvolution).not.toHaveBeenCalled();
    expect(stderr).toContain("unknown argument '--dry-run'");
  });

  it('set refuses a flag value that is another flag', async () => {
    await expect(cmdVision(['set', '--north-star', '--end-state', 'x'])).resolves.toBe(2);
    expect(effects.applyEvolution).not.toHaveBeenCalled();
  });

  it.each([['approve'], ['reconcile'], ['preview']])('%s refuses stray arguments', async (sub) => {
    await expect(cmdVision([sub, '--yes'])).resolves.toBe(2);
    expect(effects.readLatestBriefingDetailed).not.toHaveBeenCalled();
    expect(effects.adoptBriefing).not.toHaveBeenCalled();
  });

  it('a well-formed set still edits the spec', async () => {
    await expect(cmdVision(['set', '--north-star', 'Ship it', '--id', 'ecosystem'])).resolves.toBe(0);
    expect(effects.applyEvolution).toHaveBeenCalledWith(
      'ecosystem', { northStar: 'Ship it' }, 'mason', expect.any(String),
    );
  });
});
