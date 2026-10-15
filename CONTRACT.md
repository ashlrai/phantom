# Phantom — shared core contract (M1/M2 baseline)

This is the binding interface for Phantom's original index, launcher and
identity modules (the package was formerly named ashlr-hub). Do not change these
exported signatures without updating this file. Later milestones pin their own
contracts in `docs/contracts/`. All source is ESM/NodeNext:
**import sibling modules with `.js` extensions** (e.g.
`import { getGitStatus } from './git.js'`). Strict TypeScript.

The modules below use Node builtins only. The package as a whole declares a
small set of runtime dependencies in `package.json` (for example the MCP SDK,
`yaml`, `smol-toml`, `marked` and `tar`); do not add one without updating the
dependency contract and its verification together (see
[CONTRIBUTING.md](CONTRIBUTING.md)).

The canonical types live in **`src/core/types.ts`** — import them, never redefine.
Every module named below is implemented; the signatures are the required
baseline, and several have since gained optional trailing parameters (noted
inline).

The CLI ships as `phm` with the compatible `ashlr` alias (both run `bin/ashlr`).
The full, current command inventory is `phm help --all`.

---

## src/core/types.ts — THE CONTRACT (types only)

The shapes below are the baseline fields. `AshlrConfig` has since gained many
optional sections (`firm`, `phantom`, `locus`, `genome`, `notify`, `foundry`,
`daemon`, `plugins`, `pulse`, `user`, `fleet`, `comms`, `reasoning`, `devin`),
and `models` / `telemetry` gained optional keys; read `src/core/types.ts` and
[`schema/config.schema.json`](schema/config.schema.json) for the full shape.

```ts
export interface TidyRule { match: string; matchType: 'glob' | 'regex' | 'ext'; dest: string; description?: string }

export interface AshlrConfig {
  version: number;
  roots: string[];
  editor: 'cursor' | 'vscode';
  staleDays: number;
  categories: Record<string, string>;
  tidyRules: TidyRule[];
  keepers: string[];
  models: { lmstudio: string; ollama: string; providerChain: string[] };
  telemetry: { pulse?: string };
  tools: Record<string, string>;
}

export type ItemKind = 'repo' | 'doc-folder' | 'doc' | 'asset' | 'symlink' | 'other';

export interface GitStatus { branch: string; dirty: number; ahead: number; behind: number; lastCommit: string | null }

export interface IndexedItem {
  id: string; name: string; path: string; kind: ItemKind;
  category: string | null; description: string | null;
  org: string | null; remote: string | null; language: string | null;
  lastModified: string; active: boolean;
  sizeBytes?: number; git?: GitStatus; linkTarget?: string;
}

export interface AshlrIndex { version: number; generatedAt: string; root: string; items: IndexedItem[] }

export interface TidyMove { from: string; to: string; rule: string }
export interface TidyPlan { moves: TidyMove[]; skipped: { path: string; reason: string }[] }
```

---

## src/core/config.ts — config + path constants

Responsibility: own `~/.ashlr/`, load/save config, provide defaults seeded from the real Desktop layout.

```ts
export const CONFIG_DIR: string;                 // ~/.ashlr
export const CONFIG_PATH: string;                // ~/.ashlr/config.json
export const INDEX_PATH: string;                 // ~/.ashlr/index.json
export function defaultConfig(): AshlrConfig;     // seed roots/categories/keepers/tidyRules, resolve tool paths
export function loadConfig(): AshlrConfig;        // read CONFIG_PATH; create dir + write default if missing
export function saveConfig(c: AshlrConfig): void; // write CONFIG_PATH (mkdir -p CONFIG_DIR)
```

Imports: `node:os`, `node:fs`, `node:path`, `./types.js`.

---

## src/core/git.ts — git introspection

Responsibility: read git state without third-party deps (shell out to `git` via `node:child_process`).
Must tolerate repos where `.git` is a **file** (worktrees/submodules), missing upstream, and zero-commit repos.

```ts
export function isRepo(dir: string): boolean;
// True if `dir` contains a `.git` entry (directory OR file).

export function getGitStatus(repoPath: string): GitStatus | null;
// Branch, dirty count (porcelain), ahead/behind vs upstream, last-commit ISO.
// Returns null if not a repo or git unavailable.

export function getRemoteOrg(repoPath: string): { remote: string | null; org: string | null };
// Parse `origin` remote URL; extract org from ashlrai/*, masonwyatt23/*, evero-consulting/* style paths.
```

Imports: `node:child_process`, `node:fs`, `node:path`, `./types.js`.

---

## src/core/classify.ts — categorization + metadata

Responsibility: classify a path and extract cheap metadata. No git calls here (git.ts owns that).

```ts
export function categoryOf(path: string): string | null;
// Map an absolute path to a category by matching against cfg.categories folders / Desktop layout.
// NOTE: implementation may read config via loadConfig() OR accept it — keep signature path-only;
// resolve config internally.

export function describe(path: string): string | null;
// One-line description: README first H1, else package.json "description", else null.

export function primaryLanguage(path: string): string | null;
// Best-effort primary language (package.json => TS/JS, presence of go.mod, Cargo.toml, pyproject.toml, etc.).

export function kindOf(path: string): ItemKind;
// 'symlink' (lstat) > 'repo' (isRepo) > 'doc-folder'/'asset'/'doc'/'other' by name + dirent type.
```

Imports: `node:fs`, `node:path`, `./types.js`, `./git.js` (isRepo).

---

## src/core/index-engine.ts — scan + persist

Responsibility: walk roots (depth ~3), build IndexedItem[] using classify + git, persist/load index.json.
Must detect symlinks and NOT double-count symlink targets that point into `github/`.

```ts
export function buildIndex(cfg: AshlrConfig, opts?: BuildIndexOptions): AshlrIndex;
// Scan cfg.roots, classify each entry, attach GitStatus for repos, compute `active` from staleDays.

export function loadIndex(): AshlrIndex | null;   // read INDEX_PATH; null if absent/invalid
export function writeIndex(i: AshlrIndex): void;   // write INDEX_PATH (mkdir -p CONFIG_DIR)
```

Imports: `node:fs`, `node:path`, `./types.js`, `./config.js` (INDEX_PATH), `./classify.js`, `./git.js`.

---

## src/core/tidy.ts — loose-file tidy planner

Responsibility: plan and apply moves of loose top-level files per cfg.tidyRules. Honor `keepers` (never move),
skip symlinks, skip git repos, skip the indexed KEEPERS. Plan is always dry-run; apply is the only mutator.

```ts
export function planTidy(cfg: AshlrConfig): TidyPlan;
// Examine loose entries under roots; for each, first-matching tidyRule => TidyMove; else skipped w/ reason.

export function applyTidy(plan: TidyPlan): void;
// Execute plan.moves with fs.rename (mkdir -p dest). Idempotent/safe: skip if source gone or dest exists.
```

Imports: `node:fs`, `node:path`, `./types.js`.

---

## src/cli/open.ts — launchers

Responsibility: open a path in editor / Finder / Terminal. Best-effort, never throw on launch failure.

```ts
export function openInEditor(path: string, cfg: AshlrConfig): void;
// Build deep link from cfg.editor: cursor://file/<path> or vscode://file/<path>; `open` the URL.

export function openInFinder(path: string): void;   // `open <path>`
export function openInTerminal(path: string): void; // best-effort: open Terminal/tmux at path
```

Imports: `node:child_process`, `./../core/types.js`.

---

## src/cli/picker.ts — interactive selection

Responsibility: let the user choose one item. Use `fzf` ONLY if present on PATH; otherwise a
built-in `node:readline` numbered picker. **fzf is NOT installed by default — the builtin is the primary path.**

```ts
export function pick(items: IndexedItem[]): Promise<IndexedItem | null>;
// Resolve to the chosen item, or null if cancelled / empty input.
```

Imports: `node:child_process`, `node:readline`, `./../core/types.js`.

---

## src/cli/index.ts — CLI entrypoint

Responsibility: parse argv and dispatch. Invoked via `bin/ashlr` (installed as `phm`
and `ashlr`) -> `dist/cli/index.js`. No default export; runs on import (top-level).
The `switch (cmd)` in `main()` is the source of truth for top-level commands;
`src/cli/help.ts` (`HELP_ENTRIES`) and `src/cli/completions.ts` mirror it, and
`test/cli-registry-drift.test.ts` fails on drift. The baseline commands this
contract pins:

| command            | flags                | behavior |
| ------------------ | -------------------- | -------- |
| `index`            | `--refresh`          | build + writeIndex (force rebuild on --refresh) |
| `go [query]`       | `--open` \| `--cd`   | fuzzy-pick (or filter by query); --open in editor, --cd prints path for shell cd |
| `status`           |                      | summarize index: counts by kind/category, dirty/stale repos |
| `ls [category]`    |                      | list items, optionally filtered by category |
| `open <query>`     |                      | resolve query -> item -> openInEditor |
| `tidy`             | `--apply`            | planTidy (print); with --apply run applyTidy |
| `config`           | `get \| set \| path` | read/write config; `path` (or no subcommand) prints CONFIG_PATH |
| `help`             | `[<topic>] [--all]`  | topic-grouped usage; `--all` prints every command |

Imports: everything in `core/` + `cli/open.js` + `cli/picker.js`.

---

## src/raycast/* — Raycast extension (own package.json)

Lives in `src/raycast/`, excluded from the root tsconfig and eslint. Has its own `package.json`,
`tsconfig.json`, and Raycast dependencies. Reads the SAME `~/.ashlr/index.json` (do not re-scan in Raycast).

- `src/raycast/src/lib/index.ts` — load + parse `~/.ashlr/index.json` into `IndexedItem[]`
  (copy/share the `AshlrIndex`/`IndexedItem` types from `core/types.ts`).
- `src/raycast/src/lib/open.ts` — editor/Finder deep-link helpers mirroring `cli/open.ts`.
- Raycast command files (list view over IndexedItem, actions: open in editor, reveal in Finder, copy path).

Contract for the lib layer:

```ts
// src/raycast/src/lib/index.ts
export function loadIndex(): AshlrIndex | null;   // read ~/.ashlr/index.json
// src/raycast/src/lib/open.ts
export function openInEditor(path: string, editor: 'cursor' | 'vscode'): void;
export function openInFinder(path: string): void;
```

---

## M2 — identity & model awareness

M2 turns `~/.ashlr/config.json` into the unified source of truth and adds Phantom
Secrets identity (the separate `phantom` CLI) + local-model awareness. **Hard rules for every M2 build agent:**

- Zero runtime deps — Node builtins only (`node:child_process`, global `fetch`, `node:fs`, ...).
- **Probes NEVER throw.** Return a typed result with `up:false` / `error` on any failure.
- **Phantom is READ-ONLY and NEVER prints secret VALUES** — names/status only.
- doctor/providers MUST tolerate every endpoint being up OR down without crashing.
- `init` MUST be NON-TTY safe (no hang when piped / no stdin).
- Verify `phantom` subcommand flags at runtime via `phantom --help`; degrade gracefully.

### types.ts additions (already in THE CONTRACT)

```ts
export interface ProviderEndpoint { id: 'lmstudio' | 'ollama' | string; url: string; up: boolean; models: string[]; error?: string }
export interface ProviderRegistry { providers: ProviderEndpoint[]; activeProvider: string | null; chain: string[] }
export interface PhantomStatus { installed: boolean; version: string | null; initialized: boolean; secretNames: string[]; capability: PhantomCapabilitySnapshot; agentReport?: PhantomAgentReportRollup; error?: string }
export type DoctorCheckStatus = 'pass' | 'warn' | 'fail';
export interface DoctorCheck { id: string; label: string; status: DoctorCheckStatus; detail: string; fix?: string }
export interface DoctorReport { generatedAt: string; checks: DoctorCheck[]; summary: { pass: number; warn: number; fail: number } }
// AshlrConfig also gains: phantom?: { enabled: boolean }   (models unchanged)
```

### src/core/providers.ts — local-model/provider registry + failover

Responsibility: probe local-model endpoints (LM Studio, Ollama), build a registry, resolve the
active provider via the configured chain. Pure probes; never throw.

```ts
export async function probeEndpoint(id: string, url: string): Promise<ProviderEndpoint>;
// fetch `url` (LM Studio: GET http://localhost:1234/v1/models -> data[].id;
// Ollama: GET http://localhost:11434/api/tags -> models[].name). On any error/timeout:
// { id, url, up:false, models:[], error }. On success: up:true with parsed model names.

export async function getProviderRegistry(cfg: AshlrConfig): Promise<ProviderRegistry>;
// Probe each provider implied by cfg.models (lmstudio/ollama) in cfg.models.providerChain order;
// chain = cfg.models.providerChain; activeProvider = first probed provider that is up, else null.

export async function resolveActiveProvider(cfg: AshlrConfig): Promise<string | null>;
// Convenience: id of the first up provider in chain order, or null when none are reachable.
```

Imports: global `fetch`, `./types.js`.

### src/core/phantom.ts — Phantom Secrets identity layer

Responsibility: read-only introspection of the `phantom` CLI. NAMES/STATUS ONLY — never values.

```ts
export function phantomInstalled(options?: { cwd?: string; timeoutMs?: number }): boolean;
// True if `phantom` binary resolves on PATH (e.g. spawnSync('phantom','--version') or 'which phantom').

export function getPhantomStatus(options?: { cwd?: string; timeoutMs?: number; includeAgentReport?: boolean }): PhantomStatus;
// SYNC. spawn phantom (spawnSync) read-only: version (`phantom --version`),
// initialized + secret NAMES (`phantom status` / `phantom list`; verify flags via `phantom --help`).
// NEVER capture or return secret values. On any failure: degrade gracefully with error set.
```

Imports: `node:child_process` (spawnSync), `./types.js`.

### src/core/doctor.ts — one-glance health check

Responsibility: aggregate config, phantom, and provider health into a single DoctorReport.

```ts
export async function runDoctor(cfg: AshlrConfig): Promise<DoctorReport>;
// Run checks (config present/valid, editor resolvable, phantom status, each provider endpoint,
// activeProvider resolvable, index freshness). Build DoctorCheck[] with pass/warn/fail + fix hints.
// generatedAt = new Date().toISOString(); summary = roll-up counts. Never throws.
```

Imports: `node:fs`, `./types.js`, `./config.js`, `./phantom.js`, `./providers.js`.

### src/cli/index.ts — M2 commands (extend existing dispatch)

Add to the argv dispatch (do not remove existing commands):

| command  | flags    | behavior |
| -------- | -------- | -------- |
| `doctor` |          | `runDoctor(loadConfig())` -> print checks + summary; exit non-zero if any `fail`. |
| `init`   | `--yes`  | idempotent onboarding: ensure config, detect+offer phantom + local models, set editor, `saveConfig`. **NON-TTY safe** — when stdin is not a TTY (or `--yes`), accept defaults and never prompt/hang. |

Both are implemented in `src/cli/doctor-init.ts` and loaded lazily from the dispatch switch.

---

## Build / run

- `npm run build` → tsc → `dist/`
- `bin/ashlr` (chmod +x) → `import('../dist/cli/index.js')`
- Install: `npm install -g @ashlr/phantom` (provides `phm` and `ashlr`), or from a
  checkout run `./install.sh`, which builds and links `phm` and `ashlr` into `~/.local/bin`
- Config/index home: `~/.ashlr/` (created on first run)
