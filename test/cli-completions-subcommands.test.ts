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
    app: ['update', 'status', 'steer', '--text', 'restart', '--json'],
    desktop: ['install', '--upgrade', '--rollback', '--require-app', '--to', '--apply'],
    mirror: ['release'],
    devin: ['seat'],
    inbox: ['submit'],
    authority: ['resident'],
    daemon: ['pause', 'resume', 'doctor'],
    fleet: ['stray-slots', 'stray-stop'],
    nodes: ['plan', 'doctor', 'pool', 'offload'],
    org: ['show', 'join', 'plan', 'init'],
    team: ['list', 'show', 'add', 'view', 'invite', 'role', 'link', 'remove', 'join', 'approve', 'deny', 'claim', 'release', 'say'],
    improve: ['propose', 'register', 'measure', 'outcomes', 'sync-backlog', 'observe', 'discover', 'promote', 'lessons', 'nightly'],
    universe: [
      'controller', 'console', 'resources', 'firm', 'preparation-measurement',
      'preparation-measurement-capture', 'preparation-measurement-compare',
      'preparation-measurement-calibrate',
    ],
    mcp: ['ecosystem', 'run'],
    models: ['list'],
    notify: ['session'],
    // onboard is flag-driven; completion offers its flags, not verbs.
    onboard: ['--ecosystem', '--grant', '--plan', '--select', '--locus-firm', '--yes', '--json', '--rollback', '--kill'],
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

describe('help tables name every dispatched `phm node` verb', () => {
  /** Every verb src/cli/node.ts dispatches: literal `args[0] ===` checks, the pool verb array and NODE_FLEET_VERBS. */
  function dispatchedNodeVerbs(): Set<string> {
    const source = readFileSync(join(CLI_DIR, 'node.ts'), 'utf8');
    const verbs = new Set<string>();
    for (const match of source.matchAll(/args\[0\] === '([^']+)'/g)) verbs.add(match[1]!);
    const poolList = /\[([^\]]*)\]\.includes\(args\[0\]/.exec(source);
    expect(poolList, 'node.ts has no pool-verb includes list').not.toBeNull();
    for (const match of poolList![1]!.matchAll(/'([^']+)'/g)) verbs.add(match[1]!);
    return verbs;
  }

  /** The verbs a `node ...`/`phm node ...` usage cell names, pipe lists flattened. */
  function verbsInUsage(usage: string): Set<string> {
    const verbs = new Set<string>();
    for (const token of usage.replace(/^phm /, '').split(' ')) {
      if (token.startsWith('-') || token.includes('<') || token.includes('[')) continue;
      for (const verb of token.split('|')) if (/^[a-z][a-z0-9-]*$/.test(verb)) verbs.add(verb);
    }
    return verbs;
  }

  it('HELP_ENTRIES and AGENT_COMMANDS cover the dispatch surface', async () => {
    const { AGENT_COMMANDS, HELP_ENTRIES } = await import('../src/cli/help.js');
    const { NODE_FLEET_VERBS } = await import('../src/cli/node-fleet-usage.js');
    const dispatched = new Set([...dispatchedNodeVerbs(), ...NODE_FLEET_VERBS]);
    expect(dispatched.size).toBeGreaterThanOrEqual(20);

    const helpVerbs = new Set(HELP_ENTRIES.filter((e) => e.cmd.startsWith('node ')).flatMap((e) => [...verbsInUsage(e.cmd)]));
    const agentVerbs = new Set(AGENT_COMMANDS.filter((c) => c.usage.startsWith('phm node ')).flatMap((c) => [...verbsInUsage(c.usage)]));
    for (const verb of dispatched) {
      expect(helpVerbs.has(verb), `HELP_ENTRIES is missing phm node ${verb}`).toBe(true);
      expect(agentVerbs.has(verb), `AGENT_COMMANDS is missing phm node ${verb}`).toBe(true);
    }
  });
});
