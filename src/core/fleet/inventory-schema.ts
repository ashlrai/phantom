/**
 * phantom.inventory.v1: the wire shape of `phm inventory --json` and
 * GET /api/verse/fleet/runs/inventory. Browser-safe (types and constants only)
 * so the desktop Inventory pane reads the same schema the CLI prints.
 * Built by inventory.ts; additive changes only, bump the version otherwise.
 */
export const INVENTORY_PATH = '/api/verse/fleet/runs/inventory';
export const INVENTORY_SCHEMA = 'phantom.inventory.v1';
export const INVENTORY_VERSION = 1;

/** Fixed order: the CLI sections and the pane chips follow it. */
export const INVENTORY_KINDS = ['channel', 'connector', 'plugin', 'skill', 'tool'] as const;
export type InventoryKind = typeof INVENTORY_KINDS[number];
export const INVENTORY_KIND_LABELS: Readonly<Record<InventoryKind, string>> = {
  channel: 'Channels', connector: 'Connectors', plugin: 'Plugins', skill: 'Skills', tool: 'Tools',
};

/** Plain words, shown as written. Fixed order: counts and summaries follow it. */
export const INVENTORY_STATES = ['ready', 'needs setup', 'off', 'error', 'unknown'] as const;
export type InventoryState = typeof INVENTORY_STATES[number];
export type InventoryCounts = Record<InventoryState, number>;

export interface InventoryItem {
  kind: InventoryKind;
  /** Unique across the inventory: `<kind>:<name>`, with the source in front when one name has several. */
  id: string;
  name: string;
  state: InventoryState;
  /** One plain line: what it is, or why it is in this state. Never a credential value. */
  detail: string;
  /** ISO time its source was last read; null when the source could not be read. */
  lastChecked: string | null;
  /** Lanes that can use it; 'all' when it is not limited to a lane; 'unknown' when no source says. */
  usedByLanes: string[] | 'all' | 'unknown';
  /** The single next step: set when the state is 'needs setup', and on other states only when a source names one. */
  next: InventoryNextStep | null;
}

export interface InventoryNextStep {
  /** What to do, in plain words. */
  text: string;
  /** A command to copy; null when the step has none. Never holds a secret. */
  command: string | null;
}

export interface InventoryKindSummary {
  kind: InventoryKind;
  label: string;
  total: number;
  counts: InventoryCounts;
}

/** One lane against every tool and connector that is not off. `has` and `lacks` hold item ids. */
export interface InventoryLaneParity {
  lane: string;
  has: string[];
  lacks: string[];
  /** Tools and connectors no source declares for this lane; never counted as lacking. */
  unknown: number;
  /** `lacks.length`: this lane's tool gap. */
  gap: number;
}

export interface InventoryParity {
  /** How many tools and connectors each lane is compared against. */
  compared: number;
  /** Largest lane gap minus the smallest: 0 means every lane lacks the same number. */
  widestGap: number;
  /** Org lanes first, then any other lane a source names. */
  lanes: InventoryLaneParity[];
}

export interface Inventory {
  schema: typeof INVENTORY_SCHEMA;
  version: typeof INVENTORY_VERSION;
  at: string;
  /** The kind filter that was applied; null for the whole inventory. */
  kind: InventoryKind | null;
  counts: InventoryCounts;
  kinds: InventoryKindSummary[];
  /** Kind order, then name. */
  items: InventoryItem[];
  /** Always over every tool and connector, whatever `kind` filters the items to. */
  parity: InventoryParity;
}

/** Accepts `skill` or `skills`, any case; null for anything else. */
export function parseInventoryKind(text: string): InventoryKind | null {
  const word = text.trim().toLowerCase().replace(/s$/, '');
  return (INVENTORY_KINDS as readonly string[]).includes(word) ? word as InventoryKind : null;
}
