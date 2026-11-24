/** `phm jobs dupcheck <prompt-file> [--repo <path>] [--json]`: thin handler; logic lives in core/queue/dupcheck-git.ts. */
import { gitDupcheckFile, gitDupcheckLines } from '../core/queue/dupcheck-git.js';

const help = `Usage: phm jobs dupcheck <prompt-file> [--repo <path>] [--json]
Is the work in this job prompt already on master? Pulls out the commands (phm foo bar), files and exported names
it mentions and looks each one up in the repo's origin/master with git (falls back to master, then HEAD). Says
new, partly on master (with what exists and what is missing) or likely done. Read-only, no network; it never drops a job.
Exit 0 for any verdict, 1 when the prompt or repo cannot be read, 2 for bad usage.`;

export async function cmdJobsDupcheck(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) { console.log(help); return 0; }
  let json = false, repo: string | undefined;
  const files: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--json') json = true;
    else if (a === '--repo' && repo === undefined && args[i + 1]) repo = args[++i];
    else if (a.startsWith('-')) { console.error(help); return 2; }
    else files.push(a);
  }
  if (files.length !== 1) { console.error(help); return 2; }
  try {
    const report = await gitDupcheckFile(files[0]!, { repo });
    console.log(json ? JSON.stringify(report) : gitDupcheckLines(report).join('\n'));
    return 0;
  } catch {
    const message = `Cannot read ${files[0]}. Give a prompt file.`;
    if (json) console.log(JSON.stringify({ error: message })); else console.error(message);
    return 1;
  }
}
