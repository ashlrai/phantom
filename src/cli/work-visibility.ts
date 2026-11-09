/**
 * `phm context --for-agent <lane> --json` and `phm claim acquire|release`.
 * The company context verbs stay in company-context.ts.
 */
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { listCoordination } from '../core/agents/claim-store.js';
import { acquireWorkClaim, buildContextBrief, parseOpenWorkPulls, releaseWorkClaim, type OpenWorkPull } from '../core/agents/work-visibility.js';
import { readWorldModel } from '../core/world/read.js';

const CONTEXT_USAGE = `phm context --for-agent <lane> --json
phm context read|write ...   (company context; see phm context read --help)`;

const CLAIM_USAGE = `phm claim acquire <work-key> --lane <lane> [--repo owner/name] [--pr N] [--branch NAME] [--pulls <file>] [--root <abs>] --json
phm claim release <work-key> --lane <lane> --reason open|merge|abandon [--root <abs>] --json

Acquire refuses a live claim or an open pull on the same work key and returns the holder.`;

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  return args[index + 1];
}

function laneOf(args: string[]): string | undefined {
  return flag(args, '--lane');
}

async function readPulls(path: string | undefined): Promise<OpenWorkPull[]> {
  if (!path || !isAbsolute(path)) return [];
  try {
    return parseOpenWorkPulls(JSON.parse(await readFile(path, 'utf8')));
  } catch {
    return [];
  }
}

export async function cmdAgentContext(args: string[], deps: {
  readWorld?: () => Promise<{ generatedAt: string; blindSpots: import('../core/world/types.js').WorldModel['blindSpots']; sensors: import('../core/world/types.js').WorldModel['sensors']; views?: { observe: { bottlenecks: { top: { id: string; metric: string; value: number | null }[] } } } }>;
  claims?: () => ReturnType<typeof listCoordination>['claims'];
} = {}): Promise<number> {
  const json = args.includes('--json');
  const lane = flag(args, '--for-agent');
  if (!lane || args.includes('--help') || args.includes('-h')) {
    console.log(json ? JSON.stringify({ usage: CONTEXT_USAGE }) : CONTEXT_USAGE);
    return lane ? 0 : 2;
  }
  const model = await (deps.readWorld ?? (() => readWorldModel({ force: args.includes('--refresh') })))();
  const claims = (deps.claims ?? (() => listCoordination().claims))();
  const brief = buildContextBrief({
    nowMs: Date.parse(model.generatedAt) || Date.now(),
    lane,
    world: model as import('../core/world/types.js').WorldModel,
    claims,
    pulls: await readPulls(flag(args, '--pulls')),
    bottlenecks: model.views?.observe.bottlenecks.top.map((item) => ({ id: item.id, metric: item.metric, value: item.value })) ?? [],
  });
  console.log(JSON.stringify(brief));
  return 0;
}

export async function cmdWorkClaim(args: string[]): Promise<number> {
  const json = args.includes('--json');
  const say = (value: unknown, code: number): number => {
    console.log(json ? JSON.stringify(value) : typeof value === 'object' && value && 'status' in value ? String((value as { status: string }).status) : CLAIM_USAGE);
    return code;
  };
  if (args.includes('--help') || args.includes('-h') || args.length === 0) return say({ usage: CLAIM_USAGE }, args.length === 0 ? 2 : 0);
  const verb = args[0];
  const workKey = args[1];
  const lane = laneOf(args);
  if ((verb !== 'acquire' && verb !== 'release') || !workKey || workKey.startsWith('-') || !lane) return say({ error: 'invalid-argument', usage: CLAIM_USAGE }, 2);
  const root = flag(args, '--root');
  if (verb === 'release') {
    const reason = flag(args, '--reason');
    if (reason !== 'open' && reason !== 'merge' && reason !== 'abandon') return say({ error: 'invalid-argument', usage: CLAIM_USAGE }, 2);
    const result = releaseWorkClaim({ workKey, lane, reason, root: root && isAbsolute(root) ? root : undefined });
    return say(result, result.status === 'released' ? 0 : result.status === 'invalid' ? 2 : 1);
  }
  const prText = flag(args, '--pr');
  const pr = prText === undefined ? null : Number(prText);
  const result = acquireWorkClaim({
    workKey,
    lane,
    repo: flag(args, '--repo') ?? null,
    pr,
    branch: flag(args, '--branch') ?? null,
    pulls: await readPulls(flag(args, '--pulls')),
    root: root && isAbsolute(root) ? root : undefined,
  });
  return say(result, result.status === 'acquired' ? 0 : result.status === 'invalid' ? 2 : 1);
}
