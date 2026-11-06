import { awaitReleaseMilestone, type ReleaseAwaitDeps, type ReleaseAwaitStage } from '../core/fleet/release-milestone-await.js';
import { validMilestoneTag, validReleaseRepo } from '../core/fleet/release-live-notice.js';

const usage = 'Usage: ashlr fleet release-await --repo owner/name --tag vX.Y.Z --stage published|feed-ready [--timeout-ms N] [--poll-ms N] [--json]';
export async function cmdFleetReleaseAwait(args: string[], deps: ReleaseAwaitDeps & {
  signal?: AbortSignal; emit?: (line: string) => void | Promise<void> } = {}): Promise<number> {
  const invalid = (): number => { process.stderr.write(`${usage}\n`); return 2; };
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) { await (deps.emit ?? console.log)(usage); return 0; }
  const values: Record<string, string> = {}; let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json' && !json) { json = true; continue; }
    if (!['--repo', '--tag', '--stage', '--timeout-ms', '--poll-ms'].includes(arg) || values[arg] !== undefined || !args[i + 1] || args[i + 1]!.startsWith('--')) return invalid();
    values[arg] = args[++i]!;
  }
  const repo = values['--repo'], tag = values['--tag'], stage = values['--stage'];
  const number = (value: string | undefined, fallback: number, min: number, max: number): number | null => {
    if (value === undefined) return fallback;
    if (!/^(0|[1-9][0-9]*)$/.test(value)) return null;
    const n = Number(value); return Number.isSafeInteger(n) && n >= min && n <= max ? n : null;
  };
  const timeoutMs = number(values['--timeout-ms'], 60_000, 0, 300_000);
  const pollMs = number(values['--poll-ms'], 5_000, 1_000, 30_000);
  if (!repo || !validReleaseRepo(repo) || !tag || !validMilestoneTag(tag) || (stage !== 'published' && stage !== 'feed-ready') || timeoutMs === null || pollMs === null) return invalid();
  const result = await awaitReleaseMilestone({ repo, tag, stage: stage as ReleaseAwaitStage, timeoutMs, pollMs, signal: deps.signal }, deps);
  await (deps.emit ?? console.log)(json ? JSON.stringify(result) : `fleet release-await: ${JSON.stringify(result)}`);
  return result.outcome === 'observed' ? 0 : 1;
}
