import { isAbsolute, join } from 'node:path';
import { PLANNER_CANDIDATES_FILE } from './planner-candidates.js';
import { readSource } from './runs-parked-queue.js';

/** Only the bounded on-disk slate may declare the planner's prompt. Never throws. */
export async function readPlannerPromptPath(runsRoot: string): Promise<string | null> {
  try {
    const source = await readSource(join(runsRoot, PLANNER_CANDIDATES_FILE), 64 * 1024, false);
    if (source.state !== 'healthy') return null;
    const parsed: unknown = JSON.parse(source.text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const path = (parsed as Record<string, unknown>)['promptPath'];
    return typeof path === 'string' && isAbsolute(path) && !path.includes('\0') ? path : null;
  } catch { return null; }
}
