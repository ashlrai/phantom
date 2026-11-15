/**
 * Lane selection for the Comms role. The role supplies a work item. The
 * existing router (and its bandit, when enabled) picks among the lanes the
 * caller says are available. A choice outside that set is discarded.
 */
import { loadConfig } from '../config.js';
import { routeTask } from '../run/router.js';
import type { EngineId, WorkItem } from '../types.js';
import { COMMS_AGENT_ROLE } from './role.js';

export function commsWorkItem(nowIso: string): WorkItem {
  return {
    id: 'role:comms',
    repo: 'phantom',
    source: 'goal',
    title: 'Comms inbox triage',
    detail: COMMS_AGENT_ROLE.prompt,
    value: 3,
    effort: 2,
    score: 4,
    tags: ['role:comms', 'parent:leader'],
    ts: nowIso,
  };
}

export function selectCommsLane(
  available: readonly string[],
  pick: (item: WorkItem, available: readonly string[]) => { engine: string },
): { lane: string | null; reason: string } {
  const lanes = [...new Set(available.filter(lane => typeof lane === 'string' && lane.trim().length > 0))];
  if (lanes.length === 0) return { lane: null, reason: 'No candidate lane. The Comms role does not choose one.' };
  const choice = pick(commsWorkItem(new Date().toISOString()), lanes);
  if (!lanes.includes(choice.engine)) return { lane: null, reason: 'The router named a lane that is not available.' };
  return { lane: choice.engine, reason: 'The router selected an available lane.' };
}

/** Ask the existing router. Failures leave the lane unset rather than inventing one. */
export function routeCommsLane(available: readonly string[]): { lane: string | null; reason: string } {
  if (available.length === 0) return selectCommsLane(available, () => ({ engine: '' }));
  try {
    const cfg = loadConfig();
    return selectCommsLane(available, (item, lanes) => {
      const decision = routeTask(item, cfg, { availableEngines: lanes as EngineId[] });
      return { engine: decision.engine };
    });
  } catch {
    return { lane: null, reason: 'The router could not choose a lane.' };
  }
}
