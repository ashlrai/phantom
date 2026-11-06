import { isAbsolute } from 'node:path';
import { followFleetSession } from '../core/fleet/session.js';

export async function cmdFleetSession(args: string[]): Promise<number> {
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
  process.stderr.write('usage: phantom fleet session <job> --json [--follow] [--queue-dir <abs>]\n');
  return 2;
}
