/** Shared web contracts. Public entry point: ../types.ts. */

// ---------------------------------------------------------------------------
// M14: surfaces II - local web dashboard served by the hub (`ashlr serve`).
// A localhost-only HTTP server (Node 'http' builtin, ZERO new runtime deps,
// NO CDN - all assets bundled in the repo and served locally) exposes a
// read-only JSON API + Server-Sent-Events live stream and a hand-built static
// SPA. SECURITY: binds 127.0.0.1 ONLY; Host-header allowlist (anti DNS-
// rebinding); proprietary GET/SSE routes require a per-process read token or a
// short-lived read-only browser ticket; mutating routes exist ONLY under
// --allow-dispatch and require an independent raw mutation-token header.
// METADATA ONLY - never serves secret values.
// ---------------------------------------------------------------------------

/** Options controlling how the local web dashboard server starts. */
export interface WebServerOptions {
  /** TCP port to bind on 127.0.0.1 (default chosen by the CLI, e.g. 7777). */
  port: number;
  /** Whether to open the default browser to the served URL after start. */
  open: boolean;
  /**
   * Whether to expose the guarded, token-protected mutating dispatch route
   * (POST /api/run). When false (the default), the server has NO mutating
   * endpoints - read-only API + SSE + static assets only.
   */
  allowDispatch: boolean;
}

/** A handle to a running web dashboard server. Returned by `startServer`. */
export interface WebServerHandle {
  /** The actual port the server bound on 127.0.0.1. */
  port: number;
  /** Read-only capability for proprietary GET/SSE and browser-session bootstrap. */
  readToken: string;
  /**
   * Mutation-only capability. Emitted by `ashlr serve` only when mutations are
   * explicitly enabled; never accepted for read-session bootstrap.
   */
  token: string;
  /** The localhost URL the dashboard is served at (e.g. http://127.0.0.1:7777). */
  url: string;
  /** Stop the server cleanly (closes listeners + bounded SSE pollers). */
  close(): Promise<void>;
}
