import { explainRoutes } from '../core/queue/route-explain.js';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { open, constants } from 'node:fs/promises';

async function routeInput(file: string, limit = 32 * 1024): Promise<unknown> {
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
    const { withRunwayYield } = await import('../core/queue/route-yield.js');
    console.log(JSON.stringify(await decideRoute(request.data, await withRunwayYield(root, await loadRouteSources(root)))));
    return 0;
  } catch {
    console.error(JSON.stringify({ error: 'Route input or decision unavailable' })); return 1;
  }
}

const FIT_USAGE = 'Usage: phm route fit --input <file|-> [--worktree <directory>] --json';

/** Does this lane's sandbox fit the job? With gh_context and --worktree, also writes the gh context pack. */
async function routeFit(args: string[]): Promise<number> {
  let input: string | undefined, worktree: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json') continue;
    const value = args[i + 1];
    if ((args[i] !== '--input' && args[i] !== '--worktree') || !value || value.startsWith('--')) { console.error(JSON.stringify({ error: FIT_USAGE })); return 2; }
    if (args[i++] === '--input') input = value; else worktree = value;
  }
  if (!input || !args.includes('--json')) { console.error(JSON.stringify({ error: FIT_USAGE })); return 2; }
  try {
    const { z } = await import('zod');
    const lane = z.string().regex(/^[a-z][a-z0-9-]{1,30}$/);
    const request = z.object({ job: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/), lane, prompt: z.string().max(1024 * 1024),
      candidates: z.array(lane).max(32).optional(), gh_context: z.unknown().optional() }).safeParse(await routeInput(input, 4 * 1024 * 1024));
    if (!request.success) { console.error(JSON.stringify({ error: 'Invalid route fit request' })); return 2; }
    const { fitRoute } = await import('../core/fleet/lane-capabilities.js');
    const { gh_context: context, ...job } = request.data;
    const offered = context !== undefined && worktree !== undefined;
    const fit = fitRoute({ ...job, ...(offered ? { pack: true } : {}) });
    let pack: { file: string; prompt_note: string } | null = null;
    if (offered && fit.decision === 'route_with_pack') {
      // Only a job that needs the pack gets one; the supplied gh JSON is scrubbed and bounded first.
      const { buildGhContextPack, ghContextPromptNote, writeGhContextPack } = await import('../core/fleet/gh-context-pack.js');
      const built = buildGhContextPack(job.job, context);
      pack = { file: await writeGhContextPack(worktree!, built), prompt_note: ghContextPromptNote(built) };
    }
    console.log(JSON.stringify({ ...fit, pack }));
    return 0;
  } catch {
    console.error(JSON.stringify({ error: 'Route fit input or context pack unavailable' })); return 1;
  }
}

const SEATS_USAGE = 'Usage: phm route seats [--root <directory>] --json';

/** Which Google seat the router uses and whether it reaches Gemini 4 Neon on included capacity. */
export async function routeSeats(args: string[], out: (text: string) => void = console.log): Promise<number> {
  let root = process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (seen.has(arg) || !['--root', '--json'].includes(arg)) { console.error(JSON.stringify({ error: SEATS_USAGE })); return 2; }
    seen.add(arg);
    if (arg === '--json') continue;
    const value = args[++i];
    if (!value || value.startsWith('--')) { console.error(JSON.stringify({ error: SEATS_USAGE })); return 2; }
    root = value;
  }
  if (!seen.has('--json')) { console.error(JSON.stringify({ error: SEATS_USAGE })); return 2; }
  const { loadRouteSources } = await import('../core/routing/decision-candidates.js');
  const { googleSeatReadout } = await import('../core/routing/subscription-capacity.js');
  out(JSON.stringify(googleSeatReadout((await loadRouteSources(root)).seats)));
  return 0;
}

export async function cmdRoute(args: string[]): Promise<number> {
  if (args[0] === 'seats') return routeSeats(args.slice(1));
  if (args[0] === 'failover') return routeFailover(args.slice(1));
  if (args[0] === 'decide') return routeDecide(args.slice(1));
  if (args[0] === 'fit') return routeFit(args.slice(1));
  if (args[0] === 'shadow') return routeShadow(args.slice(1));
  if (args[0] !== 'explain' || args.slice(1).some(a => a !== '--json') || args.length > 2) {
    console.error('Usage: phm route explain [--json] | phm route seats [--root <directory>] --json | phm route decide --input <file|-> [--root <directory>] --json | phm route failover --input <file|-> --failed-lane <lane> --failure <quota|5xx|timeout|near_reset> [--attempted a,b] [--root <directory>] [--record] --json | phm route fit --input <file|-> [--worktree <directory>] --json | phm route shadow eval --input <file|-> [--policy <name>] [--root <directory>] [--record] --json | phm route shadow report [--policy <name>] [--root <directory>] --json');
    return 2;
  }
  const report = await explainRoutes();
  console.log(args.includes('--json') ? JSON.stringify(report) : JSON.stringify(report, null, 2));
  return 0;
}

const SHADOW_USAGE = 'Usage: phm route shadow eval --input <file|-> [--policy <name>] [--root <directory>] [--record] --json | phm route shadow report [--policy <name>] [--root <directory>] --json';

async function routeShadow(args: string[]): Promise<number> {
  const mode = args[0];
  if (mode !== 'eval' && mode !== 'report') { console.error(JSON.stringify({ error: SHADOW_USAGE })); return 2; }
  const allowed = mode === 'eval' ? ['--input', '--policy', '--root', '--record', '--json'] : ['--policy', '--root', '--json'];
  const values = new Map<string, string>();
  const seen = new Set<string>();
  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!;
    if (seen.has(arg) || !allowed.includes(arg)) { console.error(JSON.stringify({ error: SHADOW_USAGE })); return 2; }
    seen.add(arg);
    if (arg === '--record' || arg === '--json') continue;
    const value = args[++i];
    if (!value || value.startsWith('--')) { console.error(JSON.stringify({ error: 'Missing route shadow argument' })); return 2; }
    values.set(arg, value);
  }
  if (!seen.has('--json') || (mode === 'eval' && !values.has('--input'))) { console.error(JSON.stringify({ error: SHADOW_USAGE })); return 2; }
  const root = resolve(values.get('--root') ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs'));
  try {
    const { buildShadowPolicyReport, evaluateShadowPolicy, isShadowPolicyName, recordShadowPolicyDecision } = await import('../core/router/shadow-policy.js');
    const rawPolicy = values.get('--policy');
    if (rawPolicy !== undefined && !isShadowPolicyName(rawPolicy)) { console.error(JSON.stringify({ error: 'Unknown shadow policy' })); return 2; }
    const policy = rawPolicy && isShadowPolicyName(rawPolicy) ? rawPolicy : undefined;
    if (mode === 'report') {
      console.log(JSON.stringify(await buildShadowPolicyReport({ runsDir: root, ...(policy ? { policy } : {}) })));
      return 0;
    }
    const { routeRequestSchema } = await import('../core/routing/decision-schema.js');
    const request = routeRequestSchema.safeParse(await routeInput(values.get('--input')!));
    if (!request.success) { console.error(JSON.stringify({ error: 'Invalid route request' })); return 2; }
    const [{ loadRouteSources }, { decideRoute }, { withRunwayYield }, { readRouterOutcomes }, { readControllerQuality }] = await Promise.all([
      import('../core/routing/decision-candidates.js'),
      import('../core/routing/decision.js'),
      import('../core/queue/route-yield.js'),
      import('../core/router/outcomes.js'),
      import('../core/router/controller-quality.js'),
    ]);
    const sources = await withRunwayYield(root, await loadRouteSources(root));
    const live = await decideRoute(request.data, sources);
    if (!('lane' in live)) {
      console.log(JSON.stringify({ schema: 'route.shadow-eval.v1', advisory: true, dispatched: false, recorded: false, live, shadow: null }));
      return 0;
    }
    const [outcomesRead, qualityRead] = await Promise.all([readRouterOutcomes({ runsDir: root }), readControllerQuality({ runsDir: root })]);
    const shadow = evaluateShadowPolicy(request.data, sources, live, outcomesRead.outcomes, { ...(policy ? { policy } : {}), qualityReceipts: qualityRead.receipts });
    if (seen.has('--record')) await recordShadowPolicyDecision(root, shadow);
    console.log(JSON.stringify({ schema: 'route.shadow-eval.v1', advisory: true, dispatched: false, recorded: seen.has('--record'), live, shadow }));
    return 0;
  } catch {
    console.error(JSON.stringify({ error: 'Route shadow input or ledger unavailable' })); return 1;
  }
}

async function routeFailover(args: string[]): Promise<number> {
  const values = new Map<string, string>();
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (seen.has(arg) || !['--input', '--failed-lane', '--failure', '--attempted', '--root', '--record', '--json'].includes(arg)) return 2;
    seen.add(arg);
    if (arg === '--record' || arg === '--json') continue;
    const value = args[++i];
    if (!value || value.startsWith('--')) return 2;
    values.set(arg, value);
  }
  if (!seen.has('--json') || !values.has('--input') || !values.has('--failed-lane') || !values.has('--failure')) return 2;
  try {
    const { routeRequestSchema, routeFailureKindSchema, routeIdSchema } = await import('../core/routing/decision-schema.js');
    const { loadRouteSources } = await import('../core/routing/decision-candidates.js');
    const { runFailover } = await import('../core/router/fallback.js');
    const request = routeRequestSchema.parse(await routeInput(values.get('--input')!));
    const failed_lane = routeIdSchema.parse(values.get('--failed-lane'));
    const failure = routeFailureKindSchema.parse(values.get('--failure'));
    const attempted = values.get('--attempted')?.split(',').map(lane => routeIdSchema.parse(lane)) ?? [];
    const root = values.get('--root') ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
    const result = await runFailover(request, await loadRouteSources(root), { failed_lane, failure, attempted },
      { root, record: seen.has('--record'), nowMs: Date.now() });
    console.log(JSON.stringify(result));
    return result.lane === null ? 2 : 0;
  } catch {
    console.error(JSON.stringify({ error: 'Route failover input or ledger unavailable' })); return 2;
  }
}
