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
