import { describe, expect, it, vi } from 'vitest';
import { cmdCompletions } from '../src/cli/completions.js';

async function completion(shell: 'bash' | 'zsh'): Promise<string> {
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

describe('apps request completion preserved from #5897', () => {
  it.each(['bash', 'zsh'] as const)('%s offers apps verbs in the second-word branch', async (shell) => {
    const text = await completion(shell);
    const section = shell === 'bash'
      ? /if \[ "\$COMP_CWORD" -eq 2 \]; then\s*case "\$\{COMP_WORDS\[1\]\}" in([\s\S]*?)\besac/.exec(text)
      : /elif \(\( CURRENT == 3 \)\); then\s*case "\$\{words\[2\]\}" in([\s\S]*?)\besac/.exec(text);
    expect(section).not.toBeNull();
    const branch = shell === 'bash'
      ? /^\s*apps\) COMPREPLY=\( \$\(compgen -W "([^"]*)"/m.exec(section![1]!)
      : /^\s*apps\) _values 'subcommand' ([^\n;]*)/m.exec(section![1]!);
    expect(branch).not.toBeNull();
    const offered = shell === 'bash'
      ? branch![1]!.split(' ')
      : [...branch![1]!.matchAll(/'([^']+)'/g)].map((match) => match[1]!);
    for (const verb of ['list', 'log', 'open', 'quit', 'restart', 'focus', 'status', 'suggest', 'request']) {
      expect(offered, `phm apps ${verb}`).toContain(verb);
    }
  });
});
