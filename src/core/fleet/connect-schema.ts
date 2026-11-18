/**
 * phantom.connect.v1: the wire shape of `phm connect list --json` and
 * GET /api/connect. Browser-safe (types and constants only) so the desktop
 * Connect pane reads the same schema the CLI prints. Built by connect-list.ts;
 * additive changes only, bump the version otherwise.
 */
export const CONNECT_PATH = '/api/connect';
export const CONNECT_SCHEMA = 'phantom.connect.v1';
export const CONNECT_VERSION = 1;
/** The one existing enable/disable route: POST {name, enabled, revision, confirm: true}. */
export const CONNECT_TOGGLE_PATH = '/api/verse/mcp/connectors';

export const CONNECT_KINDS = ['channel', 'connector', 'plugin', 'skill', 'tool'] as const;
export type ConnectKind = (typeof CONNECT_KINDS)[number];
export const CONNECT_KIND_LABEL: Record<ConnectKind, string> = { channel: 'Channels', connector: 'Connectors', plugin: 'Plugins', skill: 'Skills', tool: 'Tools' };
export const CONNECT_STATES = ['on', 'off', 'broken', 'unknown'] as const;
export type ConnectState = (typeof CONNECT_STATES)[number];

export interface ConnectRow {
  /** Stable key: kind, source and name. */
  id: string;
  name: string;
  kind: ConnectKind;
  /** Where the row was read from, in plain words. */
  source: string;
  state: ConnectState;
  /** ISO time; null when never used; 'unknown' when nothing records it. */
  lastUsed: string | null | 'unknown';
  /** Lanes or agents that use it, in plain words; empty when none is named. */
  users: string[];
  /** True when it needs a credential. The credential itself is never read or shown. */
  needsSignIn: boolean;
  /** The one plain next step; null when on. */
  next: string | null;
  /** Present only where an enable/disable route exists; pass `revision` back to it. */
  toggle: { path: typeof CONNECT_TOGGLE_PATH; revision: string } | null;
}

export interface ConnectList {
  schema: typeof CONNECT_SCHEMA;
  version: typeof CONNECT_VERSION;
  at: string;
  /** The kind filter that was applied; null for every kind. */
  kind: ConnectKind | null;
  counts: Record<ConnectState, number>;
  /** Kinds with a source that could not be read: their rows may be missing, not absent. */
  unread: ConnectKind[];
  /** By kind, then broken, unknown, off, on, then name. */
  rows: ConnectRow[];
}

export function isConnectKind(value: unknown): value is ConnectKind {
  return (CONNECT_KINDS as readonly unknown[]).includes(value);
}
