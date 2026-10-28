/** Shared genome contracts. Public entry point: ../types.ts. */

// ---------------------------------------------------------------------------
// M7: shared memory / genome (cross-project, local-first) contract
// ---------------------------------------------------------------------------

/**
 * A single unit of shared memory in the aggregated genome. Sourced either
 * from a per-project `.ashlrcode/genome/` directory ('project') or from the
 * hub store at ~/.ashlr/genome/hub.jsonl ('hub'). User's own notes/summaries
 * only - never carries secrets.
 */
export interface GenomeEntry {
  /** Stable identifier (derived from content/source; unique within the aggregate). */
  id: string;
  /** Project name this entry belongs to, or null when not project-scoped. */
  project: string | null;
  /** Where the entry came from. */
  source: 'project' | 'hub';
  /** Short human-readable title/heading for the entry. */
  title: string;
  /** Body text of the memory (the actual note/summary). */
  text: string;
  /** Free-form tags for filtering/grouping. */
  tags: string[];
  /** ISO timestamp the entry was created/learned. */
  ts: string;
}

/** A single recall result: a genome entry plus its relevance score + method. */
export interface RecallHit {
  /** The matched genome entry. */
  entry: GenomeEntry;
  /** Relevance score (higher is more relevant). */
  score: number;
  /** How the score was computed. */
  method: 'keyword' | 'embedding';
}

/** Status/health roll-up for the aggregated genome (`ashlr genome`). */
export interface GenomeHealth {
  /** Total entries across all sources (project + hub). */
  totalEntries: number;
  /** Number of distinct projects covered by the genome. */
  projects: number;
  /** Number of entries in the hub store (~/.ashlr/genome/hub.jsonl). */
  hubEntries: number;
  /** Total size in bytes of the hub store on disk. */
  sizeBytes: number;
  /** ISO timestamp of the most recently learned entry, or null if empty. */
  lastLearnedAt: string | null;
  /** Whether a local embedding-capable model is available for reranking. */
  embeddingsAvailable: boolean;
}

/** Input accepted by `ashlr learn` / `appendHubEntry`. */
export interface LearnInput {
  /** Body text of the memory to store (required). */
  text: string;
  /** Optional short title/heading (derived from text when omitted). */
  title?: string;
  /** Optional project name to scope the entry to. */
  project?: string;
  /** Optional tags to attach to the entry. */
  tags?: string[];
  /**
   * When true, append to the hub store ONLY - never drop a note file into the
   * resolved project's `.ashlrcode/genome/hub-notes/` working tree. M16
   * auto-capture sets this so a completed run/swarm never emits a file inside
   * the user's repo (which could be git-committed); the project-note drop is
   * reserved for explicit `genome --teach` / `learn`.
   */
  hubOnly?: boolean;
}

// ---------------------------------------------------------------------------
// M16: compounding genome. Completed runs/swarms auto-capture a SUMMARY-only
// GenomeEntry (fire-and-forget, never blocks/throws, dedupe-aware). Near-
// duplicate entries can be consolidated (backup-first, provenance-preserving,
// never lossy). Past entries are synthesized into a bounded playbook injected
// into planning. The genome is exportable (no lock-in). PRIVACY: metadata/
// summary only - never secrets, full prompts/completions, tool args, or file
// contents. LOCAL-ONLY: no cloud calls; synthesis uses the local provider
// best-effort with a concatenated-recall fallback.
// ---------------------------------------------------------------------------

/**
 * The summary-only payload captured from a completed run/swarm (or an explicit
 * teach) before it is appended to the genome. METADATA/SUMMARY ONLY - never
 * carries secrets, raw prompts/completions, tool args, or file contents.
 */
export interface GenomeCapture {
  /** The top-level goal the run/swarm pursued (or the teach note's subject). */
  goal: string;
  /** Absolute project path this capture is scoped to, or null when global. */
  project: string | null;
  /** Concise approach/outcome summary (capped length; secret-free). */
  summary: string;
  /** Tags for filtering/grouping (e.g. project, status, engine, source). */
  tags: string[];
  /** Terminal outcome of the work being captured. */
  outcome: 'done' | 'aborted' | 'failed';
  /** Where the capture originated. */
  source: 'run' | 'swarm' | 'teach';
}

/**
 * A synthesized "how we've approached this before" playbook for a goal: the
 * recalled past entries plus a concise synthesis of what worked / what failed
 * / cost. Bounded; injected into planning context. LOCAL synthesis with a
 * concatenated-recall fallback.
 */
export interface Playbook {
  /** The goal the playbook was built for. */
  goal: string;
  /** The recalled past entries the playbook synthesizes (ranked). */
  entries: RecallHit[];
  /** Concise synthesized guidance (what worked / failed / cost), or fallback. */
  synthesis: string;
}

/**
 * Outcome of `ashlr genome consolidate`. A timestamped backup of hub.jsonl is
 * written BEFORE any merge; near-duplicate entries are merged into canonical
 * entries that preserve provenance (count + first/last seen + merged tags) so
 * information is never irrecoverably dropped.
 */
export interface ConsolidationResult {
  /** Entry count before consolidation. */
  before: number;
  /** Entry count after consolidation. */
  after: number;
  /** Number of entries merged away into canonical entries. */
  merged: number;
  /** Absolute path of the timestamped hub.jsonl backup written first. */
  backupPath: string;
}
