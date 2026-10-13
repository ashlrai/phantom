/**
 * core/ecosystem/companion-manifest.ts — the ONE list of Ashlr open-source
 * companions the setup wizard (desktop + `phm setup workbench`) offers.
 *
 * Pure data + pure helpers: no I/O, safe to import from the web UI. Adding a
 * companion is one entry here; the wizard cards, the CLI listing, the docs
 * table test and the default selection all derive from it.
 *
 * Nothing in this file installs, stars or registers anything. Selection is a
 * preference; installation stays a separate, explicit, user-run step.
 */

export type CompanionId =
  | 'phantom-secrets'
  | 'locus'
  | 'lexicon'
  | 'ashlr-md'
  | 'ashlr-stack'
  | 'ashlr-plugin'
  | 'binshield';

export type CompanionRole = 'credentials' | 'identity' | 'voice' | 'markdown' | 'provisioning' | 'efficiency' | 'supply-chain';

export interface CompanionEntry {
  id: CompanionId;
  title: string;
  /** One line on the card. */
  tagline: string;
  /** The details panel. Plain sentences, no marketing claims we cannot back. */
  details: readonly string[];
  role: CompanionRole;
  /** `owner/name` on GitHub. */
  repo: string;
  /** Executable the inventory looks for, when the companion ships a CLI. */
  executable: string | null;
  /** Install hint shown (never run) by the wizard. */
  install: string;
  /** Asset file name under src/web-ui/assets/companions, or null → monogram. */
  logo: string | null;
  /** Two-letter monogram fallback. */
  monogram: string;
  /** Hue (0–360) for the generated monogram tile. */
  hue: number;
  /** Hero integrations get a full card; extras get a compact one-toggle row. */
  tier: 'hero' | 'extra';
}

export const COMPANION_MANIFEST: readonly CompanionEntry[] = [
  {
    id: 'phantom-secrets',
    title: 'Phantom Secrets',
    tagline: 'Agents see phm_ tokens, never your real API keys.',
    details: [
      'A local vault, proxy and MCP server that swaps real secrets for phm_ reference tokens at the network edge.',
      'When enabled, the wizard stores every API key and credit token you connect in Secrets instead of the OS keychain.',
      'Keys are isolated per repository checkout; agents and the setup assistant only ever handle references.',
    ],
    role: 'credentials',
    repo: 'ashlrai/phantom-secrets',
    executable: 'phantom',
    install: 'brew install ashlrai/phantom/phantom',
    logo: 'phantom-secrets.svg',
    monogram: 'PS',
    hue: 268,
    tier: 'hero',
  },
  {
    id: 'locus',
    title: 'Locus',
    tagline: 'The identity plane: the right account for every project, every time.',
    details: [
      'Binds MCP servers and CLI logins to a workspace so an agent cannot act in the wrong tenant.',
      'When enabled, each resource you connect is bound to a personal, company or client scope through Locus.',
      'Without Locus, Phantom keeps the scope as a local label only (no enforcement).',
    ],
    role: 'identity',
    repo: 'ashlrai/locus',
    executable: 'locus',
    install: 'brew install ashlrai/tap/locus',
    logo: null,
    monogram: 'Lo',
    hue: 196,
    tier: 'hero',
  },
  {
    id: 'lexicon',
    title: 'Lexicon',
    tagline: 'One YAML file of the words speech-to-text gets wrong, applied everywhere.',
    details: [
      'A personal vocabulary for voice-to-agent work, served over MCP to Claude Code, the browser and macOS.',
      'Useful when you dictate prompts to Phantom chats or agents.',
    ],
    role: 'voice',
    repo: 'ashlrai/lexicon',
    executable: 'lexicon',
    install: 'brew install ashlrai/tap/lexicon',
    logo: 'lexicon.svg',
    monogram: 'Lx',
    hue: 32,
    tier: 'extra',
  },
  {
    id: 'ashlr-md',
    title: 'Ashlr MD',
    tagline: 'The out-of-box Markdown app for plans, specs and agent notes.',
    details: [
      'An AI-native Markdown app for macOS, Windows and Linux with on-device AI and MCP integration.',
      'When enabled, Phantom opens .md files (plans, CLAUDE.md, AGENTS.md) in Ashlr MD.',
    ],
    role: 'markdown',
    repo: 'ashlrai/ashlr-md',
    executable: null,
    install: 'Download from https://github.com/ashlrai/ashlr-md/releases',
    logo: 'ashlr-md.png',
    monogram: 'MD',
    hue: 220,
    tier: 'extra',
  },
  {
    id: 'ashlr-stack',
    title: 'Ashlr Stack',
    tagline: 'Provision development services through CLI and MCP, with Secrets for credentials.',
    details: [
      'Creates and connects databases, hosting and other services for a project from the CLI or an agent.',
      'Credentials it provisions land in Phantom Secrets when Secrets is enabled.',
    ],
    role: 'provisioning',
    repo: 'ashlrai/ashlr-stack',
    executable: 'stack',
    install: 'curl -fsSL https://stack.ashlr.ai/install.sh | bash',
    logo: 'ashlr-stack.svg',
    monogram: 'St',
    hue: 152,
    tier: 'extra',
  },
  {
    id: 'ashlr-plugin',
    title: 'Ashlr Plugin',
    tagline: 'Token-efficiency MCP tools and hooks for Claude Code and Codex.',
    details: [
      'Replaces high-volume Read/Grep/Edit/Bash calls with compact equivalents, powered by @ashlr/core-efficiency.',
      'Stretches subscription windows across a fleet of agents.',
    ],
    role: 'efficiency',
    repo: 'ashlrai/ashlr-plugin',
    executable: null,
    install: 'See https://github.com/ashlrai/ashlr-plugin#install',
    logo: 'ashlr-plugin.svg',
    monogram: 'Pl',
    hue: 12,
    tier: 'extra',
  },
  {
    id: 'binshield',
    title: 'BinShield',
    tagline: 'Supply-chain checks for the npm and PyPI packages your agents install.',
    details: [
      'Scans install scripts and native binaries, checks OSV malware advisories and gates PRs with a GitHub Action.',
      'Pairs with autonomous agents that add dependencies on their own.',
    ],
    role: 'supply-chain',
    repo: 'ashlrai/binshield',
    executable: null,
    install: 'See https://github.com/ashlrai/binshield#readme',
    logo: 'binshield.svg',
    monogram: 'BS',
    hue: 352,
    tier: 'extra',
  },
];

export function companionById(id: string): CompanionEntry | undefined {
  return COMPANION_MANIFEST.find((c) => c.id === id);
}

export function repoUrl(entry: Pick<CompanionEntry, 'repo'>): string {
  return `https://github.com/${entry.repo}`;
}

/** Every companion selected — the out-of-box default. */
export function defaultCompanionSelection(): Record<CompanionId, boolean> {
  return Object.fromEntries(COMPANION_MANIFEST.map((c) => [c.id, true])) as Record<CompanionId, boolean>;
}

/** Normalise a stored/partial selection: unknown ids dropped, missing ids default ON. */
export function normaliseSelection(raw: unknown): Record<CompanionId, boolean> {
  const out = defaultCompanionSelection();
  if (raw && typeof raw === 'object') {
    for (const c of COMPANION_MANIFEST) {
      const v = (raw as Record<string, unknown>)[c.id];
      if (typeof v === 'boolean') out[c.id] = v;
    }
  }
  return out;
}

export function selectedIds(selection: Record<CompanionId, boolean>): CompanionId[] {
  return COMPANION_MANIFEST.filter((c) => selection[c.id]).map((c) => c.id);
}

/** Parse a `--exclude a,b` list; returns unknown ids separately so the CLI can refuse them. */
export function applyExclusions(list: string | undefined): { selection: Record<CompanionId, boolean>; unknown: string[] } {
  const selection = defaultCompanionSelection();
  const unknown: string[] = [];
  for (const raw of (list ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const entry = companionById(raw);
    if (entry) selection[entry.id] = false;
    else unknown.push(raw);
  }
  return { selection, unknown };
}
