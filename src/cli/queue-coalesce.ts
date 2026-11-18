import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { coalesceQueue } from '../core/queue/coalesce.js';

const help = `Usage: phm queue coalesce [<file>] [--apply --out <directory>] [--json]
Merge small READY lines for the same repo into batch jobs (up to 8 tasks each).
Reads <file>, or stdin when no file is given. By default nothing is written.
--apply --out <directory> saves router-queue.original.md, then writes
router-queue.md and prompts/<batch id>.md. Existing files are never replaced.
Never batched: P0, tier=frontier, FIXUP ids, src=leader, lines without size<=200.`;

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) throw new Error('No queue file given and stdin is a terminal');
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

export async function cmdQueueCoalesce(args: string[]): Promise<number> {
  let file: string | undefined, out: string | undefined, apply = false, json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--help' || arg === '-h') { console.log(help); return 0; }
    if (arg === '--apply') apply = true;
    else if (arg === '--json') json = true;
    else if (arg === '--out' && args[i + 1] && !args[i + 1]!.startsWith('--')) out = args[++i];
    else if (!arg.startsWith('-') && file === undefined) file = arg;
    else if (arg === '-' && file === undefined) file = '-';
    else { console.error(help); return 2; }
  }
  if (apply !== (out !== undefined)) { console.error(help); return 2; }
  try {
    const input = file === undefined || file === '-' ? await readStdin() : await readFile(file, 'utf8');
    const { report, output } = coalesceQueue(input);
    if (out) {
      await mkdir(join(out, 'prompts'), { recursive: true });
      // 'wx' refuses to replace an existing file, so a rerun never clobbers a prior plan.
      await writeFile(join(out, 'router-queue.original.md'), input, { flag: 'wx' });
      await writeFile(join(out, 'router-queue.md'), output, { flag: 'wx' });
      for (const batch of report.batches) await writeFile(join(out, 'prompts', `${batch.id}.md`), batch.prompt, { flag: 'wx' });
    }
    if (json) console.log(JSON.stringify({ ...report, applied: Boolean(out), out: out ?? null }));
    else {
      for (const batch of report.batches) console.log(`${batch.id} replaces ${batch.replaces.length} ${batch.repo} jobs: ${batch.replaces.join(', ')}`);
      if (!report.batches.length) console.log('Nothing to batch.');
      for (const bad of report.malformed) console.log(`Line ${bad.line} kept as is: ${bad.reason}`);
      console.log(out ? `Written to ${out}.` : 'Dry run; nothing written. Add --apply --out <directory> to write.');
    }
    return 0;
  } catch (error) {
    const message = (error as NodeJS.ErrnoException).code === 'EEXIST'
      ? 'Output directory already has a coalesce plan; choose an empty directory'
      : error instanceof Error ? error.message : 'Queue unavailable';
    if (json) console.log(JSON.stringify({ error: message })); else console.error(message);
    return 1;
  }
}
