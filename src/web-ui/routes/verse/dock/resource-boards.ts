/**
 * routes/verse/dock/resource-boards.ts — the resource boards as one surface.
 *
 * Pools, Usage, Router, Models, Lanes, Capacity, Supply and Throughput are
 * separate panes that answer one question between them: what does the fleet
 * have, where is work sent, how are the lanes running, and what came out. This is the order the switcher
 * above each of them lists them in. Only ids live here; a board's name comes
 * from its own registration, and a board that is not registered (an older
 * build, a pane removed by another unit) is simply left out.
 *
 * Pure data and functions; no React.
 */

export type ResourceBoardGroup = 'have' | 'route' | 'run' | 'out';

export const RESOURCE_BOARD_GROUPS: Readonly<Record<ResourceBoardGroup, string>> = {
  have: 'What the fleet has',
  route: 'Where work is sent',
  run: 'How the lanes are running',
  out: 'What came out',
};

export const RESOURCE_BOARDS: readonly { readonly id: string; readonly group: ResourceBoardGroup }[] = [
  { id: 'fleet-pools', group: 'have' },
  { id: 'fleet-usage', group: 'have' },
  { id: 'fleet-router', group: 'route' },
  { id: 'models', group: 'route' },
  { id: 'fleet-lanes', group: 'run' },
  { id: 'fleet-capacity', group: 'run' },
  { id: 'fleet-supply', group: 'run' },
  { id: 'fleet-throughput', group: 'out' },
];

export interface ResourceBoard {
  readonly id: string;
  readonly title: string;
  readonly description: string | null;
  readonly group: ResourceBoardGroup;
  /** First board of its group among the ones listed (the switcher draws a divider before it). */
  readonly startsGroup: boolean;
}

export function isResourceBoard(id: string): boolean {
  return RESOURCE_BOARDS.some((board) => board.id === id);
}

/** The boards that can be opened right now, in switcher order, named by their own registrations. */
export function resourceBoards(lookup: (id: string) => { title: string; description: string | null } | null): ResourceBoard[] {
  const out: ResourceBoard[] = [];
  for (const { id, group } of RESOURCE_BOARDS) {
    const pane = lookup(id);
    if (!pane) continue;
    out.push({ id, title: pane.title, description: pane.description, group, startsGroup: out.length > 0 && out[out.length - 1]!.group !== group });
  }
  return out;
}

/** The board `delta` steps from `current`, wrapping at both ends; null when `current` is not listed or stands alone. */
export function neighbourBoard(boards: readonly { id: string }[], current: string, delta: number): string | null {
  const index = boards.findIndex((board) => board.id === current);
  if (index < 0 || boards.length < 2) return null;
  return boards[(((index + delta) % boards.length) + boards.length) % boards.length]!.id;
}
