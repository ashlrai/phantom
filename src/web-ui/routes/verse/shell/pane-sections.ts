/**
 * routes/verse/shell/pane-sections.ts — the MetaMuse sections the add-a-pane
 * picker groups panes under. Pure data, no React.
 *
 * Unknown ids land in Fleet so a newly registered pane never disappears.
 */
export const PANE_SECTIONS = [
  { id: 'chat', label: 'Chat' },
  { id: 'feed', label: 'Feed' },
  { id: 'ideas', label: 'Ideas' },
  { id: 'goals', label: 'Goals' },
  { id: 'library', label: 'Library' },
  { id: 'fleet', label: 'Fleet' },
] as const;

export type PaneSectionId = (typeof PANE_SECTIONS)[number]['id'];

const SECTION_BY_PANE: Readonly<Record<string, PaneSectionId>> = {
  'leader-thread': 'chat', 'leader-journal': 'chat',
  feed: 'feed', 'fleet-events': 'feed', 'fleet-timeline': 'feed', 'fleet-bus': 'feed',
  ideas: 'ideas',
  goals: 'goals',
  library: 'library',
};

export function sectionForPane(id: string): PaneSectionId {
  return Object.hasOwn(SECTION_BY_PANE, id) ? SECTION_BY_PANE[id]! : 'fleet';
}
