/** Find repository uses of CLI flags explicitly described as removed or deprecated. */
import { execFileSync } from 'node:child_process';

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
      if ((error as { status?: number }).status === 1) continue;
      throw error;
    }
    const evidence = output.trimEnd().split('\n').map(line => {
      const match = /^(.*?):(\d+):/u.exec(line);
      return match ? `${match[1]!.replace(/^\.\//u, '')}:${match[2]}` : '';
    }).filter(Boolean);
    if (evidence.length) results.push({ flag, priority: 'fix-now', evidence });
  }
  return results;
}
