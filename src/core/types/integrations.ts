/** Shared integrations contracts. Public entry point: ../types.ts. */

/* ---------------------------------------------------------------------------
 * M18 - outward integrations (GitHub, Vercel, identity, notifications).
 * All READ shapes; producers reuse the installed CLIs (gh/vercel/phantom),
 * never handle raw tokens, and read-only producers must never throw.
 * ------------------------------------------------------------------------- */

/**
 * Read-only snapshot of the current repo's GitHub state (M18), derived from
 * the `gh` CLI. Surfaced in `ashlr status` when cwd is a gh repo. Never thrown
 * from a producer - degrades to a safe "not a repo / unknown" shape instead.
 */
export interface GithubStatus {
  /** Whether cwd resolves to a GitHub repo reachable via `gh`. */
  isRepo: boolean;
  /** Count of open pull requests (0 when unknown/not a repo). */
  openPrs: number;
  /** Count of open issues (0 when unknown/not a repo). */
  openIssues: number;
  /** Aggregate CI/checks state for the default/most-recent ref. */
  ci: 'passing' | 'failing' | 'pending' | 'none';
  /** "owner/name" of the repo, or null when not a repo / unresolved. */
  repo: string | null;
}

/**
 * Read-only snapshot of the linked Vercel project's latest deploy (M18),
 * derived from the `vercel` CLI. Surfaced in `ashlr status` when a project is
 * linked. Producer must never throw - degrades to an "unlinked" shape.
 */
export interface VercelStatus {
  /** Whether a Vercel project is linked for cwd. */
  linked: boolean;
  /** Latest deployment build state (e.g. "READY", "BUILDING"), or null. */
  latestState: string | null;
  /** Latest preview/deploy URL, or null when none/unlinked. */
  url: string | null;
}

/**
 * Read-only caller identity (M18), derived from `phantom` cloud status/team.
 * NAMES/status only - never secret values. Degrades to a logged-out shape when
 * phantom is absent or not logged in. Producer must never throw.
 */
export interface Identity {
  /** Whether phantom reports an authenticated session. */
  loggedIn: boolean;
  /** Account id/handle, or null when logged out/unknown. */
  user: string | null;
  /** Tier/plan name, or null when logged out/unknown. */
  tier: string | null;
  /** Team name, or null when none/logged out/unknown. */
  team: string | null;
}

/**
 * Opt-in outward notification targets (M18). A webhook is a URL only - no
 * secret payloads. When unset, notify() is a strict no-op (never posts).
 */
export interface NotifyTarget {
  /** Slack incoming-webhook URL. Posts a concise completion summary when set. */
  slackWebhook?: string;
  /** Discord webhook URL. Posts a concise completion summary when set. */
  discordWebhook?: string;
  /**
   * M32: macOS desktop notification on new PENDING proposals (osascript;
   * metadata only - never the diff). OPT-IN: strict no-op unless true.
   */
  desktop?: boolean;
}

/**
 * M19: spend-governance verdict for the configured budget window. Advisory by
 * default ('warn'); 'over' may require --over-budget when cfg.telemetry
 * govAction is 'block'. Governance NEVER silently blocks a run.
 */
export interface GovernanceStatus {
  /** ok < 80% of cap, warn >= 80% of cap, over > cap. */
  level: "ok" | "warn" | "over";
  /** Spend (USD) over the window, from the forecast/rollup. */
  spentUsd: number;
  /** Configured spend cap (USD) for the window, or null when none is set. */
  capUsd: number | null;
  /** The budget window the verdict applies to (e.g. '7d'). */
  window: string;
  /** Human-readable summary - metadata only, never secrets. */
  message: string;
}
