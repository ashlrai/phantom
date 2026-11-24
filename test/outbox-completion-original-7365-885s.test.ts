import { execFileSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
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

describe('outbox completion recovered from #7365', () => {
  it('generates bash completion and completes the prefix in bash', async () => {
    const output = await script('bash');
    const top = /compgen -W "([^"]*)" -- "\$cur"/.exec(output)?.[1]?.split(' ');
    expect(top?.filter((word) => word === 'outbox')).toEqual(['outbox']);
    expect(output).toMatch(/docs\) COMPREPLY=/);
    const result = execFileSync('bash', ['--noprofile', '--norc', '-c',
      `${output}\nCOMP_WORDS=(phm outbox fr); COMP_CWORD=2; _ashlr_completions; printf '%s\\n' "\${COMPREPLY[@]}"`],
    { encoding: 'utf8', timeout: 5000 });
    expect(result.trim()).toBe('from-log');
  });

  it('generates zsh completion alongside existing commands', async () => {
    const output = await script('zsh');
    const top = /_ashlr_cmds=\(([^\n]*)\)/.exec(output)?.[1]?.match(/'[^']*'/g);
    expect(top?.filter((word) => word === "'outbox'")).toEqual(["'outbox'"]);
    expect(output).toMatch(/outbox\) _values 'subcommand' 'from-log' '--help' ;;/);
    expect(output).toMatch(/docs\) _values 'subcommand'/);
  });
});
