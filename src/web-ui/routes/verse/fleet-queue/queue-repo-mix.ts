/** The fields needed to classify a queued job. */
export interface QueueItemShape {
  lane: string;
  id?: string | null;
  repo?: string | null;
}

export function isPhantomJob(item: QueueItemShape): boolean {
  return /^(?:[^/]+\/)?phantom$/i.test(item.repo?.trim() ?? '')
    || (item.id?.startsWith('RQ-PHX-') ?? false);
}

export function repoMixByLane(items: QueueItemShape[]): Array<{
  lane: string; total: number; phantom: number; other: number; otherRepos: string[];
}> {
  const lanes = new Map<string, { lane: string; total: number; phantom: number; other: number; otherRepos: Set<string> }>();
  for (const item of items) {
    const mix = lanes.get(item.lane) ?? { lane: item.lane, total: 0, phantom: 0, other: 0, otherRepos: new Set<string>() };
    lanes.set(item.lane, mix);
    mix.total++;
    if (isPhantomJob(item)) mix.phantom++;
    else {
      mix.other++;
      mix.otherRepos.add(item.repo?.trim() || 'unknown');
    }
  }
  return [...lanes.values()]
    .map((mix) => ({ ...mix, otherRepos: [...mix.otherRepos].sort((a, b) => a.localeCompare(b)) }))
    .sort((a, b) => b.total - a.total || a.lane.localeCompare(b.lane));
}

export const PERSONAL_PHANTOM_RESTOCK_MIN = 20;

export function restockNotice(byLane: ReadonlyArray<{ lane: string; phantom?: number }>): string | null {
  const personal = byLane.find((lane) => lane.lane === 'codex-personal');
  return personal?.phantom !== undefined && personal.phantom < PERSONAL_PHANTOM_RESTOCK_MIN
    ? `Only ${personal.phantom} Phantom lines are ready on codex-personal; under ${PERSONAL_PHANTOM_RESTOCK_MIN} the author adds filler on the next restock.`
    : null;
}
