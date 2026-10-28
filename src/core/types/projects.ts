/** Shared projects contracts. Public entry point: ../types.ts. */

// ---------------------------------------------------------------------------
// M6: project lifecycle (scaffold `ashlr new` + pre-ship gate `ashlr ship`)
// ---------------------------------------------------------------------------

/** A single file emitted by a project template. */
export interface TemplateFile {
  /** Path relative to the project root (POSIX-style separators). */
  path: string;
  /** Full file contents to write. */
  content: string;
  /** Optional octal file mode (e.g. 0o755 for executables). */
  mode?: number;
}

/** A complete agentic-engineering starter template. */
export interface ProjectTemplate {
  /** Stable template id (e.g. 'node-cli', 'mcp-server', 'next-app', 'minimal'). */
  id: string;
  /** Display title for the template. */
  title: string;
  /** One-line description of what the template scaffolds. */
  description: string;
  /** Produce the template's files for a given project name + category. */
  files(ctx: { name: string; category: string }): TemplateFile[];
}

/** Fully-resolved instructions for a single scaffold operation. */
export interface ScaffoldSpec {
  /** Project name (basename of the new directory). */
  name: string;
  /** Category bucket (e.g. 'side-projects', 'dev-tools'). */
  category: string;
  /** Id of the template to scaffold from. */
  templateId: string;
  /** Absolute target directory (must not already exist). */
  dir: string;
  /** Whether to run `git init` in the new project. */
  git: boolean;
  /** Optional `stack` recipe id to provision after scaffolding. */
  stackRecipe?: string;
  /**
   * Opt out of the in-tree write guard that confines scaffolding to
   * ~/Desktop/github (or the cwd for --here). ONLY for hermetic tests that
   * scaffold into os.tmpdir(). Never set by the CLI for real scaffolds.
   */
  allowAnyRoot?: boolean;
}

/** Outcome of a scaffold operation. Never throws; failure is reported here. */
export interface ScaffoldResult {
  /** Whether the project was scaffolded successfully. */
  ok: boolean;
  /** Absolute directory the project was (or would be) created in. */
  dir: string;
  /** Absolute paths of files written. */
  filesWritten: string[];
  /** Whether `git init` ran successfully. */
  gitInitialized: boolean;
  /** Whether the ashlr MCP gateway was wired into .mcp.json. */
  mcpWired: boolean;
  /** Whether the project was registered in the index. */
  registered: boolean;
  /** Error message when `ok` is false, else absent. */
  error?: string;
  /** Non-fatal warnings collected during scaffolding. */
  warnings: string[];
}

/** A single pre-ship gate check. */
export interface ShipCheck {
  /** Stable check id (e.g. 'supply-chain', 'test', 'lint', 'build'). */
  id: string;
  /** Human-readable label for the check. */
  label: string;
  /** pass | warn | fail | skip. */
  status: 'pass' | 'warn' | 'fail' | 'skip';
  /** One-line detail describing the observed state. */
  detail: string;
  /** Optional suggested remediation command/hint. */
  fix?: string;
}

/** The full pre-ship gate report. */
export interface ShipGate {
  /** All checks performed, in display order. */
  checks: ShipCheck[];
  /** Roll-up counts by status. */
  summary: { pass: number; warn: number; fail: number; skip: number };
  /** Whether the gate passed overall (no fails, or non-strict). */
  passed: boolean;
}

/** Outcome of `ashlr ship`: the gate plus optional (dry-run) deploy. */
export interface ShipResult {
  /** The pre-ship gate report. */
  gate: ShipGate;
  /** Deploy target name, or null when no deploy was requested. */
  deployTarget: string | null;
  /** Whether the deploy was a dry-run (true unless --confirm passed). */
  deployDryRun: boolean;
  /** Whether the deploy actually ran (only when confirmed). */
  deployRan: boolean;
  /** Human-readable detail of what was (or would be) deployed. */
  deployDetail: string;
}
