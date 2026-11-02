import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdCompletions, TOP_LEVEL_COMMANDS } from '../src/cli/completions.js';
import { cmdHelp } from '../src/cli/help.js';

afterEach(() => vi.restoreAllMocks());

describe('node CLI registration alongside existing commands', () => {
  it('retains both node and existing commands in completion output', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    expect(TOP_LEVEL_COMMANDS).toEqual(expect.arrayContaining(['node', 'worktrees', 'router-calibration']));
    expect(await cmdCompletions(['bash'])).toBe(0);
    const output = write.mock.calls.map(([chunk]) => String(chunk)).join('');
    expect(output).toContain('bootstrap');
    expect(output).toContain('router-calibration');
    expect(output).toContain('worktrees');
  });

  it('retains both node and worktrees in safety help', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdHelp(['safety'])).toBe(0);
    const output = log.mock.calls.flat().join('\n');
    expect(output).toContain('node bootstrap --dry-run');
    expect(output).toContain('worktrees report');
  });
});
