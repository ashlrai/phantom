/** Read-only linting of leader BET lines; never dispatches work. */
import { readFile } from 'node:fs/promises';

export interface VisionLintProblem { line: number; message: string }
export interface VisionLintReport { readOnly: true; problems: VisionLintProblem[] }
const usage = 'Usage: ashlr fleet vision-lint <file> [--deny-file <path>] [--json]';
const lanes = new Set(['codex-personal', 'devin', 'claude-api', 'codex-local']);

/** Header: BET repo lane tier short-id metadata, followed by task text. */
export function lintFleetVision(source: string, denied: string = ''): VisionLintReport {
  const problems: VisionLintProblem[] = [];
  const words = new Set(denied.toLowerCase().split(/\s+/u).filter(Boolean));
  for (const [index, line] of source.split(/\r?\n/u).entries()) {
    if (!/^BET(?:\s|$)/u.test(line)) continue;
    const add = (message: string): void => { problems.push({ line: index + 1, message }); };
    const match = /^(BET)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.+)$/u.exec(line);
    if (!match) { add('Expected six fields before nonempty task text'); continue; }
    if (!lanes.has(match[3]!)) add('Lane must be codex-personal, devin, claude-api or codex-local');
    if (match[5]!.endsWith('Q8')) add('Short id must not end in Q8');
    const text = match[7]!;
    if (Array.from(text).length > 600) add('Task text exceeds 600 characters');
    if (!/\bNEW\s+[`"']?(?:[A-Za-z0-9_@.-]+\/)*[A-Za-z0-9_@-]+\.[A-Za-z0-9]+\b/u.test(text)) {
      add('Task text must name at least one NEW file path');
    }
    const tokens = new Set(text.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? []);
    for (const word of words) if (tokens.has(word)) add(`Task text contains denied word: ${word}`);
  }
  return { readOnly: true, problems };
}

export async function cmdFleetVisionLint(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    process.stdout.write(`${usage}\nHeader: BET repo lane tier short-id metadata text\nDeny file: whitespace-separated words, matched case-insensitively as whole words.\n`);
    return 0;
  }
  const json = args.includes('--json');
  try {
    let file: string | undefined;
    let denyFile: string | undefined;
    let seenJson = false;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!;
      if (arg === '--json' && !seenJson) { seenJson = true; continue; }
      if (arg === '--deny-file' && !denyFile) {
        const value = args[++i];
        if (!value || value.startsWith('-')) throw new Error(usage);
        denyFile = value;
      } else if (!arg.startsWith('-') && !file) file = arg;
      else throw new Error(usage);
    }
    if (!file) throw new Error(usage);
    const [source, denied] = await Promise.all([readFile(file, 'utf8'), denyFile ? readFile(denyFile, 'utf8') : '']);
    const report = lintFleetVision(source, denied);
    process.stdout.write(json ? JSON.stringify(report) + '\n' : report.problems.map(p => `line ${p.line}: ${p.message}\n`).join(''));
    return report.problems.length ? 1 : 0;
  } catch {
    const error = `Unable to read input files or invalid arguments. ${usage}`;
    process.stdout.write(json ? JSON.stringify({ readOnly: true, error }) + '\n' : error + '\n');
    return 2;
  }
}
