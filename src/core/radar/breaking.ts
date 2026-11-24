/** Find repository uses of CLI flags explicitly described as removed or deprecated. */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/** rg is not installed on every CI image. Walk the repo when the binary is missing. */
function searchFlag(repo: string, flag: string): string {
  const lines: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === '.git' || name === 'node_modules') continue;
      const path = join(dir, name);
      let st;
      try { st = statSync(path); } catch { continue; }
      if (st.isDirectory()) { walk(path); continue; }
      if (!st.isFile() || st.size > 4 * 1024 * 1024) continue;
      let text: string;
      try { text = readFileSync(path, 'utf8'); } catch { continue; }
      text.split('\n').forEach((line, index) => {
        if (line.includes(flag)) lines.push(`${relative(repo, path)}:${index + 1}:${line}`);
      });
    }
  };
  walk(repo);
  return lines.join('\n');
}

export interface BreakingFlag {
  flag: string;
  priority: 'fix-now';
  evidence: string[];
}

export function detectBreakingFlags(text: string, repo: string): BreakingFlag[] {
  const flags = new Set<string>();
  for (const sentence of text.split(/[\n.!?]+/u)) {
    if (!/\b(?:removed|deprecated)\b/iu.test(sentence)) continue;
    for (const match of sentence.matchAll(/(?<![\w-])--[a-z][a-z0-9-]*/giu)) flags.add(match[0]);
  }
  const results: BreakingFlag[] = [];
  for (const flag of [...flags].sort()) {
    let output: string;
    try {
      output = execFileSync('rg', ['--line-number', '--no-heading', '--fixed-strings', '--', flag, '.'],
        { cwd: repo, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      const failed = error as { status?: number; code?: string };
      if (failed.status === 1) continue;
      if (failed.code !== 'ENOENT') throw error;
      output = searchFlag(repo, flag);
      if (output === '') continue;
    }
    const evidence = output.trimEnd().split('\n').map(line => {
      const match = /^(.*?):(\d+):/u.exec(line);
      return match ? `${match[1]!.replace(/^\.\//u, '')}:${match[2]}` : '';
    }).filter(Boolean);
    if (evidence.length) results.push({ flag, priority: 'fix-now', evidence });
  }
  return results;
}
