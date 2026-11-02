import { homedir } from 'node:os';
import { join } from 'node:path';
import { buildContextPack, type ContextPackOptions } from '../core/fleet/context-pack.js';

const usage = 'Usage: phm ctxpack build --job <id> --lane <lane> [--max-tokens 256..2000] [--merges 0..100] [--json]';
export async function cmdCtxpack(args: string[], options: Partial<ContextPackOptions> = {}): Promise<number> {
  if (args.length === 1 && args[0] === '--help') { console.log(usage); return 0; }
  const values = new Map<string, string>();
  let json = false;
  if (args[0] !== 'build') { console.error(usage); return 2; }
  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json' && !json) json = true;
    else if (['--job', '--lane', '--max-tokens', '--merges'].includes(arg) && !values.has(arg) && args[i + 1] && !args[i + 1]!.startsWith('--')) values.set(arg, args[++i]!);
    else { console.error(usage); return 2; }
  }
  if (!values.has('--job') || !values.has('--lane')) { console.error(usage); return 2; }
  try {
    const pack = await buildContextPack({ job: values.get('--job')!, lane: values.get('--lane')!,
      runsDir: process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs'),
      maxTokens: values.has('--max-tokens') ? Number(values.get('--max-tokens')) : undefined,
      merges: values.has('--merges') ? Number(values.get('--merges')) : undefined, ...options });
    console.log(pack);
    return 0;
  } catch (error) { console.error(error instanceof Error ? error.message : 'Build failed. Check fleet and bus storage, then retry.'); return 1; }
}
