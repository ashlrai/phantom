/**
 * core/connect/types.ts: `phm connect` contracts.
 *
 * The connect wizard moves *access* (vendor sign-ins) from this machine to a
 * named target node under a strict rule set:
 *
 *   - Discovery uses vendor status commands only. Token and session file
 *     contents are never read to decide what is signed in.
 *   - One approval per account: every grant requires an explicit interactive
 *     approval. There is no auto-approval path and no flag that skips it.
 *   - Transfer order is strict: the vendor's own device-code/OAuth login on
 *     the target node first, then a scoped token vaulted in Phantom Secrets,
 *     and raw session-file copy only as a last resort (per-item approval,
 *     sealed, never printed).
 *   - The CMP Codex session (~/.codex) is excluded from copy, move and
 *     rotation. It can only ever be re-authenticated by the vendor login.
 *   - Every state change writes a value-free audit entry.
 */

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

export const CONNECT_SERVICE_IDS = [
  'codex', 'claude', 'gh', 'devin', 'grok', 'gcloud', 'vercel', 'supabase', 'mcp',
] as const;

export type ConnectServiceId = (typeof CONNECT_SERVICE_IDS)[number];

/** Captured result of a bounded status-command run. Never throws. */
export interface ConnectProbeResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

/** A vendor status command used to detect a sign-in without reading files. */
export interface ConnectProbeSpec {
  argv: readonly string[];
  timeoutMs: number;
  signedIn(result: ConnectProbeResult): boolean;
  /** Value-free account label parsed from status output, or null. */
  account(result: ConnectProbeResult): string | null;
}

export interface ConnectServiceSpec {
  id: ConnectServiceId;
  label: string;
  /** Scopes named on the approve card (what a grant covers). */
  scopes: readonly string[];
  /** Status probe; null for the `mcp` pseudo-service (registry scan instead). */
  probe: ConnectProbeSpec | null;
  /** Vendor device-code/OAuth login argv, run interactively on the target node. */
  deviceLogin: readonly string[] | null;
  /** Vendor argv that prints a scoped token on stdout (captured, vaulted, never shown). */
  tokenMint: readonly string[] | null;
  /** Session-file paths relative to the home directory; existence-checked only. */
  sessionFiles: readonly string[];
  /** When set, session-file copy/move/rotation for this service is refused outright. */
  sessionCopyProhibitedReason: string | null;
}

// ---------------------------------------------------------------------------
// Transfer
// ---------------------------------------------------------------------------

/** Strict preference order. Session copy is always the last resort. */
export const CONNECT_METHOD_ORDER = ['device-login', 'scoped-token', 'session-copy'] as const;
export type ConnectTransferMethod = (typeof CONNECT_METHOD_ORDER)[number];

export type ConnectDelivery =
  | 'executed'          // vendor login ran on this (local) node
  | 'operator-command'  // remote node: exact vendor login command was handed to the operator
  | 'vaulted'           // scoped token stored in Phantom Secrets under secretName
  | 'sealed-bundle';    // session files sealed into an encrypted bundle file

export interface ConnectAttempt {
  method: ConnectTransferMethod;
  outcome: 'ok' | 'unavailable' | 'refused' | 'failed';
  /** Value-free reason code or short text; never carries secret material. */
  reason?: string;
}

// ---------------------------------------------------------------------------
// Store records
// ---------------------------------------------------------------------------

export type ConnectRequestStatus = 'pending' | 'approved' | 'denied';

export interface ConnectRequest {
  schemaVersion: 1;
  id: string;
  service: ConnectServiceId;
  node: string;
  scopes: string[];
  requestedMethod: ConnectTransferMethod | null;
  /** Who filed the request: 'agent' (phm connect request) or 'operator'. */
  requestedBy: 'agent' | 'operator';
  requestedAt: string;
  status: ConnectRequestStatus;
  resolvedAt: string | null;
  grantId: string | null;
  /** Value-free note (denial reason, refusal detail). */
  note: string | null;
}

export interface ConnectGrant {
  schemaVersion: 1;
  id: string;
  service: ConnectServiceId;
  node: string;
  account: string | null;
  scopes: string[];
  method: ConnectTransferMethod;
  delivery: ConnectDelivery;
  /** Phantom Secrets name (never a value), when delivery is vaulted. */
  secretName: string | null;
  /** Sealed bundle file basename under the connect bundles dir. */
  bundleFile: string | null;
  /** Relative session paths sealed into the bundle (paths only, never contents). */
  sessionPaths: string[];
  /** Methods tried, in order, before the grant landed (value-free). */
  attempts: ConnectAttempt[];
  requestId: string | null;
  createdAt: string;
  revokedAt: string | null;
  revokedReason: string | null;
}

export interface ConnectStore {
  schemaVersion: 1;
  requests: ConnectRequest[];
  grants: ConnectGrant[];
}

export const CONNECT_STORE_SCHEMA_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

export interface ConnectDiscoveryRow {
  service: ConnectServiceId;
  label: string;
  /** Whether a live sign-in was detected on this machine. */
  signedIn: boolean;
  /** Value-free account label, or null when the probe does not name one. */
  account: string | null;
  /** Why the row looks the way it does ('signed-in', 'signed-out', 'probe-unavailable', 'registry'). */
  reason: 'signed-in' | 'signed-out' | 'probe-unavailable' | 'registry';
  scopes: string[];
  /** Operator-visible notes (e.g. the ~/.codex exclusion, MCP server names). */
  notes: string[];
}

// ---------------------------------------------------------------------------
// Node identifiers
// ---------------------------------------------------------------------------

/** A node id: letters/digits, plus `.` `_` `-` inside; 1-64 chars. */
export const CONNECT_NODE_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

// ---------------------------------------------------------------------------
// Injectable seams
// ---------------------------------------------------------------------------

/** Result of vaulting or deleting a secret by name. The value never returns. */
export interface ConnectSecretOutcome {
  ok: boolean;
  /** Value-free reason on failure. */
  reason?: string;
}

export interface ConnectDeps {
  /** Bounded status/probe run: argv only, no shell, captures output. Never throws. */
  run(argv: readonly string[], opts?: { timeoutMs?: number }): ConnectProbeResult;
  /** Interactive vendor login on the local node (stdio inherited). Resolves to the exit code. */
  runInteractive(argv: readonly string[]): number;
  /** Store a secret by name in Phantom Secrets (value travels on stdin). */
  storeSecret(name: string, value: string): ConnectSecretOutcome;
  /** Best-effort removal of a vaulted secret by name. */
  removeSecret(name: string): ConnectSecretOutcome;
  /** Configured MCP servers (names + commands; env values are never returned). */
  mcpServers(): readonly { name: string; command: string }[];
  /** Local host name, used to resolve the `local` node. */
  hostname(): string;
  now(): Date;
}
