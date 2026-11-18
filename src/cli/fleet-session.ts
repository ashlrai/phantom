import { isAbsolute } from 'node:path';
import { sessionPoolPolicy, type SessionPoolPolicy } from '../core/fleet/session-pool.js';
import { followFleetSession } from '../core/fleet/session.js';

const USAGE = 'usage: phantom fleet session <job> --json [--follow] [--queue-dir <abs>]\n       phantom fleet session run --runner <abs> --json [--tasks 1-100] [--rotate-after 1-100]';

export async function cmdFleetSession(args: string[]): Promise<number> {
  if (args[0] === 'run' && args.includes('--runner')) return run(args.slice(1));
  const [job, ...rest] = args;
  let queueDir: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--queue-dir' && rest[i + 1] && isAbsolute(rest[i + 1]!)) queueDir = rest[++i];
    else if (rest[i] !== '--json' && rest[i] !== '--follow') return usage();
  }
  if (!job || job.startsWith('-') || !rest.includes('--json')) return usage();
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    for await (const snapshot of followFleetSession(job, {
      queueDir, follow: rest.includes('--follow'), signal: controller.signal,
    })) console.log(JSON.stringify(snapshot));
    return 0;
  } catch {
    console.log(JSON.stringify({ error: 'Unable to read fleet session (unknown job id or unreadable source)', job }));
    return 1;
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}
function usage(): number {
  process.stderr.write(`${USAGE}\n`);
  return 2;
}

async function run(args: string[]): Promise<number> {
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    if (flags.has(flag)) return usage();
    if (flag === '--json') flags.set(flag, '');
    else if (['--runner', '--tasks', '--rotate-after'].includes(flag) && args[i + 1] && !args[i + 1]!.startsWith('--')) flags.set(flag, args[++i]!);
    else return usage();
  }
  const runner = flags.get('--runner');
  if (!runner || !isAbsolute(runner) || !flags.has('--json')) return usage();
  const policy: SessionPoolPolicy = {};
  for (const [flag, key] of [['--tasks', 'tasks'], ['--rotate-after', 'rotateAfterTasks']] as const) {
    if (flags.has(flag)) {
      if (!/^\d+$/.test(flags.get(flag)!)) return usage();
      policy[key] = Number(flags.get(flag));
    }
  }
  try { sessionPoolPolicy(policy); } catch { return usage(); }
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    const { runHostSessionPool } = await import('../core/fleet/session-pool-host.js');
    const result = await runHostSessionPool(runner, policy, controller.signal);
    console.log(JSON.stringify(result));
    return ['limit', 'empty'].includes(result.reason) ? 0 : 1;
  } catch {
    console.log(JSON.stringify({ error: 'Session pool unavailable; check node pool, host admission and runner protocol' }));
    return 1;
  } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
}
