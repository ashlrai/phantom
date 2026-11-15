/**
 * Regression test for RQ-PHX-REDTYPEFIXN1C152 (fix of PR #4219).
 *
 * #4219 added the `verify` subcommand entry to SUBCOMMANDS in
 * src/cli/completions.ts but also re-added a `chain` key that already
 * existed in the same object literal — TS1117. The fix keeps the single
 * pre-existing `chain` entry and adds only `verify`.
 *
 * This test exercises the fixed export through the public module path:
 * `cmdCompletions` renders SUBCOMMANDS into the emitted shell scripts, so a
 * broken table (or a lost verb) shows up in the generated script.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { cmdCompletions } from '../src/cli/completions.js';

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

afterEach(() => {
  vi.restoreAllMocks();
});

describe('completions after the TS1117 fix (RQ-PHX-REDTYPEFIXN1C152)', () => {
  it('bash completion offers verify change|done plus the new flags', async () => {
    const text = await script('bash');
    const match = /^\s+verify\) COMPREPLY=\( \$\(compgen -W "([^"]*)"/m.exec(text);
    expect(match, 'no verify) case in bash script').not.toBeNull();
    const offered = match![1]!.split(' ');
    for (const word of ['change', 'done', '--worktree', '--checks', '--contract', '--plan']) {
      expect(offered, `phm verify ${word}`).toContain(word);
    }
  });

  it('zsh completion offers the same verify verbs', async () => {
    const text = await script('zsh');
    expect(text).toMatch(/verify\) _values 'subcommand' [^;]*'change'[^;]*'done'/);
  });

  it('the pre-existing chain entry survives (single key, still completes verify)', async () => {
    const text = await script('bash');
    const match = /^\s+chain\) COMPREPLY=\( \$\(compgen -W "([^"]*)"/m.exec(text);
    expect(match, 'no chain) case in bash script').not.toBeNull();
    expect(match![1]!.split(' ')).toContain('verify');
  });
});
