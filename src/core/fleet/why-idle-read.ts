import { join } from 'node:path';
import { readSource } from './runs-parked-queue.js';
import { defaultRunsDir } from './landed-closes-read.js';
import { whyIdle, type WhyIdleBrief } from './why-idle.js';
import { scrubSecrets } from '../util/scrub.js';

/** Reuse the leader's bounded snapshot; expired or absent evidence explains nothing. */
export async function readWhyIdle(runsDir = defaultRunsDir(), now = Date.now()): Promise<string[]> {
  try {
    const source = await readSource(join(runsDir, 'queue/leader-brief.json'), 8192, false);
    if (source.state !== 'healthy') return [];
    const b = JSON.parse(source.text) as WhyIdleBrief & { schema: string; whyIdle?: unknown };
    const age = now - Date.parse(b.at);
    if (b.schema !== 'leader.compact-brief.v1' || !(age >= 0 && age <= 120_000)) return [];
    // Keep reasons derived before the writer trims low-priority evidence rows.
    if (Array.isArray(b.whyIdle) && b.whyIdle.length <= 3 && b.whyIdle.every(s => typeof s === 'string' && s.length > 0 && s.length <= 240 && !/lane|admission|settle_s|[\r\n]/i.test(s) && scrubSecrets(s) === s)) return b.whyIdle;
    return whyIdle(b);
  } catch { return []; }
}
