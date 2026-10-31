/**
 * Doc facts: the commands, verbs and flags that agent-facing docs show in
 * inline code must exist in the CLI.
 *
 * Every `phm …` / `ashlr …` code span, and every fenced line that starts with
 * the CLI, in the listed docs is checked against
 * the sources of truth: the top-level command must be in TOP_LEVEL_COMMANDS
 * (itself pinned to the dispatch switch by cli-registry-drift.test.ts), a
 * literal second word must be one of the verbs shell completion offers for
 * that command (when completion lists any), and every `--flag` must appear
 * in src/. A stale doc fails here with the file and line to fix.
 * No network, no subprocesses.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { TOP_LEVEL_COMMANDS, cmdCompletions } from '../src/cli/completions.js';

const ROOT = join(__dirname, '..');

/** Entry points and agent-facing docs held to the current CLI. */
const DOCS = [
  'README.md',
  'docs/ECOSYSTEM-MAP.md',
  'AGENTS.md',
  'CLAUDE.md',
  'CONTRIBUTING.md',
  'docs/AGENT-OPERATIONS.md',
  'docs/HUB-REFERENCE.md',
  'docs/MISSION-OS.md',
  'docs/README.md',
];

/** Every `--flag` spelled anywhere in src/ (code, help text, comments). */
function sourceFlags(): Set<string> {
  const flags = new Set<string>();
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(ts|tsx|mjs|js)$/.test(name)) {
        for (const m of readFileSync(path, 'utf8').matchAll(/--[a-z][a-z0-9-]*/g)) flags.add(m[0]);
      }
    }
  };
  walk(join(ROOT, 'src'));
  return flags;
}

/** Second-word verbs bash completion offers per command. */
async function completionVerbs(): Promise<Map<string, Set<string>>> {
  const chunks: string[] = [];
  const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  });
  try {
    expect(await cmdCompletions(['bash'])).toBe(0);
  } finally {
    write.mockRestore();
  }
  const verbs = new Map<string, Set<string>>();
  for (const m of chunks.join('').matchAll(/^\s+([\w-]+)\) COMPREPLY=\( \$\(compgen -W "([^"]*)"/gm)) {
    verbs.set(m[1]!, new Set(m[2]!.split(' ').filter((v) => !v.startsWith('-'))));
  }
  return verbs;
}

interface Invocation {
  file: string;
  line: number;
  span: string;
  command: string;
  verbs: string[];
  flags: string[];
}

/** `phm`/`ashlr` invocations in a doc's inline code spans. */
function invocations(file: string): Invocation[] {
  const out: Invocation[] = [];
  const lines = readFileSync(join(ROOT, file), 'utf8').split('\n');
  let fenced = false;
  lines.forEach((text, i) => {
    if (/^\s*(```|~~~)/.test(text)) {
      fenced = !fenced;
      return;
    }
    // Inside a fence, a line that starts with the CLI is one invocation (a
    // trailing `# comment` dropped); outside, every inline code span is.
    const spans = fenced
      ? [text.replace(/\s+#.*$/, '').trim()]
      : // Table cells escape `|` as `\|`; inside code it still means "or".
        [...text.replace(/\\\|/g, '|').matchAll(/`([^`]+)`/g)].map((m) => m[1]!.trim());
    for (const span of spans) {
      const head = /^(?:phm|ashlr)\s+([a-z][\w-]*)(.*)$/.exec(span);
      if (!head) continue;
      const [, command, tail] = head as unknown as [string, string, string];
      // A literal second word (or an a|b / a/b list of them) right after the
      // command; placeholders, quotes and flags stop it.
      const second = /^\s+([a-z][\w-]*(?:[|/][a-z][\w-]*)*)(?=\s|$|\])/.exec(tail);
      out.push({
        file,
        line: i + 1,
        span,
        command,
        verbs: second ? second[1]!.split(/[|/]/) : [],
        flags: [...tail.matchAll(/--[a-z][a-z0-9-]*/g)].map((f) => f[0]),
      });
    }
  });
  return out;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('agent docs name only real CLI commands, verbs and flags', () => {
  const all = DOCS.flatMap(invocations);

  it('keeps companion server lists aligned with repo configuration', () => {
    // Read names only: never include server environment or credential values in diagnostics.
    const config = JSON.parse(readFileSync(join(ROOT, '.mcp.json'), 'utf8')) as { mcpServers: Record<string, unknown> };
    const expected = Object.keys(config.mcpServers).sort();
    for (const file of ['README.md', 'AGENTS.md', 'CLAUDE.md', 'docs/ECOSYSTEM-MAP.md']) {
      const text = readFileSync(join(ROOT, file), 'utf8');
      const paragraph = text.split(/\n\s*\n/).find((p) => p.includes('`.mcp.json`') && p.includes('`phantom-secrets`'));
      expect(paragraph, `${file}: missing companion server list`).toBeDefined();
      const names = [...(paragraph ?? '').matchAll(/`([a-z][a-z-]*)`/g)]
        .map((m) => m[1]!).sort();
      expect(names, `${file}: companion server list differs from .mcp.json`).toEqual(expected);
    }
  });

  it('keeps documented npm scripts aligned with package.json', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    const bad: string[] = [];
    for (const file of ['README.md', 'AGENTS.md', 'CLAUDE.md', 'docs/ECOSYSTEM-MAP.md']) {
      const lines = readFileSync(join(ROOT, file), 'utf8').split('\n');
      lines.forEach((line, i) => {
        for (const match of line.matchAll(/\bnpm run ([a-z][a-z0-9:-]*)/g)) {
          if (!Object.hasOwn(pkg.scripts, match[1]!)) bad.push(`${file}:${i + 1}: npm run ${match[1]}`);
        }
      });
    }
    expect(bad, 'unknown npm script; fix the documented command').toEqual([]);
  });

  it('finds invocations to check', () => {
    expect(all.length).toBeGreaterThan(50);
  });

  it('every documented command is dispatched', () => {
    const known = new Set(TOP_LEVEL_COMMANDS);
    const bad = all.filter((inv) => !known.has(inv.command)).map((inv) => `${inv.file}:${inv.line}: \`${inv.span}\``);
    expect(bad, 'unknown top-level command; fix the doc line or the CLI').toEqual([]);
  });

  it('every documented verb is one the command offers', async () => {
    const verbs = await completionVerbs();
    const bad: string[] = [];
    for (const inv of all) {
      const offered = verbs.get(inv.command);
      if (!offered || offered.size === 0) continue;
      for (const v of inv.verbs) {
        if (!offered.has(v)) bad.push(`${inv.file}:${inv.line}: \`${inv.span}\` (${inv.command} has no "${v}")`);
      }
    }
    expect(bad, 'unknown verb; fix the doc line, or add the verb to completions SUBCOMMANDS').toEqual([]);
  });

  it('every documented flag exists in src/', () => {
    const flags = sourceFlags();
    const bad = all.flatMap((inv) =>
      inv.flags.filter((f) => !flags.has(f)).map((f) => `${inv.file}:${inv.line}: \`${inv.span}\` (${f})`),
    );
    expect(bad, 'flag not found anywhere in src/; fix the doc line').toEqual([]);
  });
});
