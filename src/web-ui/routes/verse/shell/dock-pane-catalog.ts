/**
 * routes/verse/shell/dock-pane-catalog.ts — the chat dock's FIRST-PARTY pane
 * metadata and groups (split from dock-catalog.ts).
 *
 * Only the dock's own UI (dock/Dock.tsx, the add menu) and the pane registry
 * read these labels and groups, all of them lazy; dock-catalog.ts, which the
 * chat's first paint imports for layout rules and persisted state, keeps just
 * the ids (DOCK_PANE_IDS) so this table stays out of the critical JS.
 *
 * Pure data — no React.
 */
import type { CommandId } from './command-catalog.js';

export const DOCK_PANE_GROUPS = [
  { id: 'fleet', label: 'Fleet' },
  { id: 'shipping', label: 'Merging and shipping' },
  { id: 'talk', label: 'Talking to the fleet' },
  { id: 'agent', label: 'Agent' },
] as const;

export type DockPaneGroup = (typeof DOCK_PANE_GROUPS)[number]['id'];
export interface DockPaneCatalogEntry {
  readonly id: string;
  readonly label: string;
  readonly group?: DockPaneGroup;
}

/** Groups for panes registered outside the built-in catalog. */
export const REGISTERED_DOCK_PANE_GROUPS: Readonly<Record<string, DockPaneGroup>> = {
  'fleet-hub': 'fleet', 'fleet-lanes': 'fleet', 'fleet-queue': 'fleet',
  'fleet-dispatch': 'fleet', 'fleet-capacity': 'fleet', 'fleet-supply': 'fleet',
  'worker-log': 'fleet',
  'fleet-merges': 'shipping', 'fleet-outcomes': 'shipping', 'fleet-releases': 'shipping', 'fleet-timeline': 'shipping',
  'fleet-bus': 'talk', 'fleet-inbox': 'talk', 'fleet-channels': 'talk', 'fleet-steering': 'talk',
  'leader-journal': 'talk', 'leader-thread': 'talk',
};

/**
 * The FIRST-PARTY panes, in the order the dock's menus list them. This is
 * metadata only (no components): the pane REGISTRY (routes/verse/panes/)
 * turns each into a registered pane, and other units add or replace panes
 * there with `registerPane` — without touching this table or the dock.
 *
 * `slot` names the C0 slot a pane renders through when its body is another
 * unit's file; null = a component the workbench owns (panes/builtin-panes).
 */
export const DOCK_PANES = [
  { id: 'terminal', label: 'Terminal', owner: 'C4', commandId: 'dock.terminal', slot: 'terminal-pane' },
  { id: 'browser', label: 'Browser', owner: 'C4', commandId: 'dock.preview', slot: 'preview-pane' },
  { id: 'diff', label: 'Changes', owner: 'C5', commandId: 'dock.diff', slot: 'diff-pane' },
  { id: 'files', label: 'Files', owner: 'workbench', commandId: 'dock.files', slot: null },
  { id: 'sources', label: 'Sources', owner: 'workbench', commandId: 'dock.sources', slot: null },
  { id: 'reasoning', label: 'Reasoning', owner: 'workbench', commandId: 'dock.reasoning', slot: null },
  { id: 'tasks', label: 'Tasks', owner: 'C2', commandId: null, slot: null },
  { id: 'context', label: 'Context', owner: 'C2', commandId: null, slot: null },
] as const satisfies readonly {
  id: string;
  label: string;
  group?: DockPaneGroup;
  owner: string;
  /** The catalog command that opens (and focuses) this pane; null = opened from its own affordance. */
  commandId: CommandId | null;
  /** Rendered through this slot when the pane is another unit's; null = the workbench's own component. */
  slot: 'terminal-pane' | 'preview-pane' | 'diff-pane' | null;
}[];

/** A first-party pane's id. */
export type BuiltinPaneId = (typeof DOCK_PANES)[number]['id'];
