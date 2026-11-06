/**
 * disk-maint protect-list - the paths standing disk maintenance may never
 * touch, in one pure matcher every plan and every apply step must pass.
 *
 * Two layers, both fail-closed:
 *
 *   1. Component rules - if ANY path component matches a protected name the
 *      candidate is refused, wherever it sits. This covers `.codex*` lane and
 *      personal Codex homes (CMP), `.git` internals, ssh/gpg material, secret
 *      and credential files, model-weight directories and weight files, and
 *      the named client trees on the Desktop.
 *   2. Root rules - resolved physical roots a candidate may never be inside:
 *      `~/.codex*`, `~/.phantom`, `~/.ashlr` secret/identity stores, the runs
 *      quarantine and pinned `bin/` and `metrics/`, HF/oMLX/LM Studio caches,
 *      Docker state, `~/Library`, `~/Documents`, and the named Desktop client
 *      trees (dhs biothreat, rde-other, Client-Work).
 *
 * Nothing here is weakened by a flag: the opt-in classes (`venvs`,
 * `hub-claude`) only widen WHERE the scanner looks - a candidate that still
 * resolves onto this list is refused at plan time and refused again at apply
 * time. Git refs, stashes and auth material are additionally safe because
 * worktree removal goes through `git worktree remove` (never `--force`).
 */
import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';

export interface MaintRoots {
  home: string;
  /** ~/.ashlr - Phantom state, native profiles, logs, staging. */
  ashlrDir: string;
  /** ~/.ashlr-runs - the fleet runs dir (ASHLR_RUNS_DIR override wins). */
  runsDir: string;
  /** ~/Projects/ashlrai/wt - job worktrees. */
  wtDir: string;
  /** ~/Desktop/github/side-projects - only ever reached by --allow venvs. */
  sideProjectsDir: string;
  /** Resolved ashlr-hub checkout for --allow hub-claude; null when absent. */
  hubDir: string | null;
}

/** Any path component matching one of these refuses the whole candidate. */
const PROTECTED_COMPONENTS: readonly RegExp[] = [
  /^\.codex($|[.-])/i,          // CMP ~/.codex, ~/.codex-2, lane .codex homes
  /^\.git$/,                    // git refs, stashes, objects - never entered
  /^\.(ssh|gnupg|aws|kube|docker|gnupg\.d)$/i,
  /^\.env($|[.-])/i,
  /^\.?netrc$/i,
  /^keychains$/i,
  /^secrets?$/i,
  /^credentials($|[.-])/i,
  /^tokens?($|[.-])/i,
  /^auth\.json$/i,
  /^config\.toml$/i,            // codex lane config; may name MCP servers
  /^id_(rsa|dsa|ecdsa|ed25519)($|[._-])/i,
  /\.(pem|key|p12|pfx|keystore|kdbx|asc|gpg)$/i,
  /\.(gguf|safetensors|ckpt|onnx|coreml)$/i,
  /^(models|checkpoints|huggingface|hf[_-]?hub|ollama|lm[_-]?studio|omlx|mlx[_-]?models)($|[._-])/i,
  /^(dhs[\w.-]*|rde[\w.-]*|client[\w.-]*work[\w.-]*)$/i, // named client trees
];

/** Every candidate is also refused when a component is exactly one of these. */
const PROTECTED_EXACT = new Set(['.codex', '.codex-2']);

function insideRoot(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

const real = (path: string): string | null => {
  try { return realpathSync.native(path); } catch { return null; }
};

/** Child dirs of parent matching `name` - for `~/.codex*` and per-project `models` dirs. */
function matchingDirs(parent: string, name: RegExp): string[] {
  try {
    return readdirSync(parent, { withFileTypes: true })
      .filter(e => name.test(e.name))
      .map(e => join(parent, e.name));
  } catch { return []; }
}

/**
 * The resolved protect-root list for a roots set. Missing paths simply drop
 * out; a root that exists but cannot be resolved is kept lexical so a
 * half-broken symlink farm still refuses deletion.
 */
export function protectedRoots(roots: MaintRoots): string[] {
  const raw: string[] = [
    join(roots.ashlrDir, 'secrets'),
    join(roots.ashlrDir, 'keys'),
    join(roots.ashlrDir, 'team-keys'),
    join(roots.ashlrDir, 'account-connections'),
    join(roots.ashlrDir, 'authority'),
    join(roots.ashlrDir, 'enrollment.json'),
    join(roots.ashlrDir, 'auth.json'),
    join(roots.ashlrDir, 'models'),
    join(roots.ashlrDir, 'local-runtime'),
    join(roots.ashlrDir, 'quarantine'),
    join(roots.ashlrDir, 'security-quarantine'),
    join(roots.runsDir, 'quarantine'),
    join(roots.runsDir, 'bin'),
    join(roots.runsDir, 'metrics'),
    join(roots.runsDir, 'drafts'),
    join(roots.runsDir, 'leader'),
    join(roots.runsDir, 'selector'),
    join(roots.home, '.phantom'),
    join(roots.home, '.docker'),
    join(roots.home, '.cache', 'huggingface'),
    join(roots.home, '.cache', 'lm-studio'),
    join(roots.home, '.cache', 'omlx'),
    join(roots.home, '.lmstudio'),
    join(roots.home, '.ollama'),
    join(roots.home, 'Library'),
    join(roots.home, 'Documents'),
    join(roots.sideProjectsDir, 'hle-solver', 'models'),
    // Runs-dir state a sweep must never eat: the append-only ledger and queue
    // heartbeats live under queue/, which scanners only read non-recursively.
  ];
  for (const dir of matchingDirs(roots.home, /^\.codex/i)) raw.push(dir);
  for (const proj of matchingDirs(roots.sideProjectsDir, /.+/)) {
    raw.push(join(proj, 'models'), join(proj, 'Models'));
  }
  const out = new Set<string>();
  for (const path of raw) {
    const physical = real(path);
    out.add(physical ?? resolve(path));
  }
  return [...out];
}

/**
 * Returns a short reason when `path` is protected, else null. Called on every
 * planned candidate and again inside apply before any byte moves.
 */
export function protectedReason(path: string, roots: MaintRoots, rootsList?: readonly string[]): string | null {
  if (!isAbsolute(path)) return 'not-absolute';
  const parts = resolve(path).split(sep).filter(Boolean);
  for (const part of parts) {
    if (PROTECTED_EXACT.has(part) || PROTECTED_COMPONENTS.some(re => re.test(part))) {
      return `protected-name:${part}`;
    }
  }
  for (const root of rootsList ?? protectedRoots(roots)) {
    if (insideRoot(root, resolve(path))) return `protected-root:${basename(root)}`;
  }
  return null;
}

export function resolveMaintRoots(overrides: Partial<MaintRoots> = {}): MaintRoots {
  const home = resolve(overrides.home ?? homedir());
  const hubCandidates = [
    process.env['ASHLR_HUB_DIR'],
    join(home, 'Projects', 'ashlrai', 'hub'),
    join(home, 'Projects', 'ashlrai', 'ashlr-hub'),
    join(home, 'ashlr-hub'),
    join(home, 'Desktop', 'github', 'ashlr-hub'),
  ].filter((p): p is string => !!p);
  let hubDir = overrides.hubDir ?? null;
  if (hubDir === null) {
    for (const candidate of hubCandidates) {
      try {
        if (lstatSync(candidate).isDirectory()) { hubDir = candidate; break; }
      } catch { /* keep looking */ }
    }
  }
  return {
    home,
    ashlrDir: resolve(overrides.ashlrDir ?? join(home, '.ashlr')),
    runsDir: resolve(overrides.runsDir ?? process.env['ASHLR_RUNS_DIR'] ?? join(home, '.ashlr-runs')),
    wtDir: resolve(overrides.wtDir ?? join(home, 'Projects', 'ashlrai', 'wt')),
    sideProjectsDir: resolve(overrides.sideProjectsDir ?? join(home, 'Desktop', 'github', 'side-projects')),
    hubDir: hubDir ? resolve(hubDir) : null,
  };
}
