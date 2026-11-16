import { explainRoutes } from '../core/queue/route-explain.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { open, constants } from 'node:fs/promises';

async function routeInput(file: string): Promise<unknown> {
  const limit = 32 * 1024;
  if (file !== '-') {
    const fd = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await fd.stat();
      if (!stat.isFile() || stat.size > limit) throw new Error('Invalid route input');
      const bytes = Buffer.alloc(limit + 1);
      const { bytesRead } = await fd.read(bytes, 0, bytes.length, 0);
      if (bytesRead > limit) throw new Error('Invalid route input');
      return JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'));
    } finally { await fd.close(); }
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.from(chunk as Uint8Array);
    size += buffer.length;
    if (size > limit) throw new Error('Invalid route input');
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function routeDecide(args: string[]): Promise<number> {
  let input: string | undefined, root = process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (seen.has(arg) || !['--input', '--root', '--json'].includes(arg)) {
      console.error(JSON.stringify({ error: 'Usage: phm route decide --input <file|-> [--root <directory>] --json' })); return 2;
    }
    seen.add(arg);
    if (arg === '--json') continue;
    const value = args[++i];
    if (!value || value.startsWith('--')) { console.error(JSON.stringify({ error: 'Missing route argument' })); return 2; }
    if (arg === '--input') input = value; else root = value;
  }
  if (!input || !seen.has('--json')) { console.error(JSON.stringify({ error: 'route decide requires --input and --json' })); return 2; }
  try {
    const { routeRequestSchema } = await import('../core/routing/decision-schema.js');
    const request = routeRequestSchema.safeParse(await routeInput(input));
    if (!request.success) { console.error(JSON.stringify({ error: 'Invalid route request' })); return 2; }
    const { loadRouteSources } = await import('../core/routing/decision-candidates.js');
    const { decideRoute } = await import('../core/routing/decision.js');
    console.log(JSON.stringify(await decideRoute(request.data, await loadRouteSources(root))));
    return 0;
  } catch {
    console.error(JSON.stringify({ error: 'Route input or decision unavailable' })); return 1;
  }
}

export async function cmdRoute(args: string[]): Promise<number> {
  if (args[0] === 'decide') return routeDecide(args.slice(1));
  if (args[0] !== 'explain' || args.slice(1).some(a => a !== '--json') || args.length > 2) {
    console.error('Usage: phm route explain [--json] | phm route decide --input <file|-> [--root <directory>] --json');
    return 2;
  }
  const report = await explainRoutes();
  console.log(args.includes('--json') ? JSON.stringify(report) : JSON.stringify(report, null, 2));
  return 0;
}
