/**
 * `phm queue stuck` is dispatched in src/cli/queue.ts but was missing from the
 * queue verb list in src/cli/completions.ts, so neither bash nor zsh offered
 * it. This pins that one recovered word (from PR #5897) against the generated
 * scripts, and checks the neighbouring job-queue verbs still replay.
 *
 * Read-only: captures output from cmdCompletions and reads queue.ts as text.
 * It never imports queue state, launches a process, or touches a real home.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { cmdCompletions } from '../src/cli/completions.js';

const QUEUE_SOURCE = join(__dirname, '..', 'src', 'cli', 'queue.ts');

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

/** Verbs bash offers after `phm queue`: `queue) COMPREPLY=( $(compgen -W "..." ...`. */
function bashQueueVerbs(text: string): string[] {
  const match = /^\s+queue\) COMPREPLY=\( \$\(compgen -W "([^"]*)"/m.exec(text);
  expect(match, 'bash script has no queue) compgen entry').not.toBeNull();
  return match![1]!.split(' ');
}

/** Verbs zsh offers after `phm queue`: `queue) _values 'subcommand' 'a' 'b' ;;`. */
function zshQueueVerbs(text: string): string[] {
  const match = /^\s+queue\) _values 'subcommand' ([^;]*);;/m.exec(text);
  expect(match, 'zsh script has no queue) _values entry').not.toBeNull();
  return [...match![1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('phm queue stuck completion', () => {
  it('queue.ts still dispatches `stuck` before the job-queue fallthrough', () => {
    const source = readFileSync(QUEUE_SOURCE, 'utf8');
    expect(source).toMatch(/if \(args\[0\] === 'stuck'\)/);
  });

  it('bash offers `stuck` after `phm queue`', async () => {
    const verbs = bashQueueVerbs(await script('bash'));
    expect(verbs).toContain('stuck');
  });

  it('zsh offers `stuck` after `phm queue`', async () => {
    const verbs = zshQueueVerbs(await script('zsh'));
    expect(verbs).toContain('stuck');
  });

  it.each(['replay', 'spawn', 'promote', 'serve'])(
    'keeps the existing `%s` verb in both bash and zsh',
    async (verb) => {
      expect(bashQueueVerbs(await script('bash'))).toContain(verb);
      expect(zshQueueVerbs(await script('zsh'))).toContain(verb);
    },
  );

  it('keeps `--help` in the queue list and does not duplicate `stuck`', async () => {
    const bash = bashQueueVerbs(await script('bash'));
    const zsh = zshQueueVerbs(await script('zsh'));
    expect(bash).toContain('--help');
    expect(zsh).toContain('--help');
    expect(bash.filter((verb) => verb === 'stuck')).toHaveLength(1);
    expect(zsh.filter((verb) => verb === 'stuck')).toHaveLength(1);
  });
});
