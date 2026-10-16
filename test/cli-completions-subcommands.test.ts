/**
 * Shell completion offers the verbs each command really dispatches.
 *
 * `phm completions bash|zsh` lists second-word verbs per command. Several
 * dispatched verbs were missing (`mirror release`, `devin seat`,
 * `inbox submit`, `authority resident`, `daemon pause|resume|doctor`,
 * `universe controller|console|resources|firm|preparation-measurement*`,
 * `mcp ecosystem|run`, `models list`, `notify session`), so tab completion hid
 * them. Where a CLI module keeps an explicit `known` verb list, this test reads
 * it straight from the source so the two cannot drift again.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { cmdCompletions } from '../src/cli/completions.js';

const CLI_DIR = join(__dirname, '..', 'src', 'cli');

async function script(shell: 'bash' | 'zsh'): Promise<string> {
  const chunks: string[] = [];
  const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  });
  try {
    expect(await cmdCompletions([shell])).toBe(0);
  } finally {
    write.mockRestore();
  }
  return chunks.join('');
}

/** The verbs bash completion offers after `phm <cmd>`. */
function bashVerbs(text: string, cmd: string): string[] {
  const escaped = cmd.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
  const match = new RegExp(`^\\s+${escaped}\\) COMPREPLY=\\( \\$\\(compgen -W "([^"]*)"`, 'm').exec(text);
  return match ? match[1]!.split(' ') : [];
}

/** The `const known = [...]` verb list of a CLI module. */
function knownVerbs(file: string): string[] {
  const source = readFileSync(join(CLI_DIR, file), 'utf8');
  const match = /const known = \[([^\]]*)\]/.exec(source);
  expect(match, `${file} has no \`const known = [...]\` list`).not.toBeNull();
  return [...match![1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('completions offer every dispatched verb', () => {
  const expected: Record<string, string[]> = {
    mirror: ['release'],
    devin: ['seat'],
    inbox: ['submit'],
    authority: ['resident'],
    daemon: ['pause', 'resume', 'doctor'],
    universe: [
      'controller', 'console', 'resources', 'firm', 'preparation-measurement',
      'preparation-measurement-capture', 'preparation-measurement-compare',
      'preparation-measurement-calibrate',
    ],
    mcp: ['ecosystem', 'run'],
    models: ['list'],
    notify: ['session'],
  };

  it.each(Object.entries(expected))('bash completes `phm %s` verbs', async (cmd, verbs) => {
    const offered = bashVerbs(await script('bash'), cmd);
    for (const verb of verbs) expect(offered, `phm ${cmd} ${verb}`).toContain(verb);
  });

  it('zsh offers the same verbs', async () => {
    const text = await script('zsh');
    expect(text).toMatch(/mirror\) _values 'subcommand' [^;]*'release'/);
    expect(text).toMatch(/devin\) _values 'subcommand' [^;]*'seat'/);
    expect(text).toMatch(/inbox\) _values 'subcommand' [^;]*'submit'/);
  });

  it.each([
    ['devin', 'devin.ts'],
    ['cloud', 'cloud.ts'],
  ])('`phm %s` completion matches the verbs %s accepts', async (cmd, file) => {
    const offered = bashVerbs(await script('bash'), cmd);
    // `ls` is an undocumented alias of `list`; completing both adds noise.
    const missing = knownVerbs(file).filter((verb) => verb !== 'ls' && !offered.includes(verb));
    expect(missing, `completions.ts is missing ${cmd} verbs`).toEqual([]);
  });
});
