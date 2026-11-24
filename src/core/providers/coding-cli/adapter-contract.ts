/**
 * Offline coding-CLI command contract (pure data, no I/O).
 *
 * Historical provenance: recovered from `src/core/providers/coding-cli/adapters.ts`
 * at ashlrai/phantom PR #5952, head 3d6c8fb7c7f7d52655fb3e0f13ef239686f7b886.
 * Only the adapter shape and the listAdapters/adapterById command builders are
 * kept. Login/probe classifiers, env scrubbing, spawning, scheduling, billing
 * decisions and credential logic are deliberately NOT recovered.
 *
 * These are the PR's historical command shapes. They do not establish that a
 * binary is installed, that a backend is supported today, or that any account
 * is eligible. Nothing here runs a process.
 */

export const ADAPTER_CONTRACT_SOURCE = {
  pr: 5952,
  head: '3d6c8fb7c7f7d52655fb3e0f13ef239686f7b886',
  path: 'src/core/providers/coding-cli/adapters.ts',
} as const;

export interface AdapterCapabilities {
  editInWorkspace: boolean;
  headless: boolean;
}

/** Structural stand-in for the unmerged catalog's backend entry. Billing is a reported string only. */
export interface AdapterBackendInput {
  bin?: string | null;
  billing?: string;
}

export type AdapterBackendInputs = Readonly<Record<string, AdapterBackendInput | undefined>>;

export interface CodingCliAdapter {
  id: string;
  /** Reported string from the caller; never an eligibility verdict. */
  billing: string;
  bin: string | null;
  capabilities: AdapterCapabilities;
  versionArgs: readonly string[];
  /** Null when the backend has no CLI status command. */
  statusArgs: readonly string[] | null;
  /** Null when the backend has no headless exec (stubbed). */
  verifyArgs: ((model: string) => readonly string[]) | null;
  /** Model flag omitted when `model` is null. Empty array for stubs. */
  execArgs: (goal: string, cwd: string, model: string | null) => readonly string[];
}

const PROBE_PROMPT = 'Reply with the single word ok.';

function build(backends: AdapterBackendInputs): CodingCliAdapter[] {
  const bin = (id: string): string | null => backends[id]?.bin ?? null;
  const billing = (id: string): string => backends[id]?.billing ?? 'metered';
  return [
    {
      id: 'codex',
      billing: billing('codex'),
      bin: bin('codex'),
      capabilities: { editInWorkspace: true, headless: true },
      versionArgs: ['--version'],
      statusArgs: ['login', 'status'],
      verifyArgs: (model) => ['exec', '--skip-git-repo-check', '--model', model, '--json', PROBE_PROMPT],
      execArgs: (goal, cwd, model) => ['exec', ...(model ? ['--model', model] : []), '--cd', cwd, '--json', goal],
    },
    {
      id: 'claude',
      billing: billing('claude'),
      bin: bin('claude'),
      capabilities: { editInWorkspace: true, headless: true },
      versionArgs: ['--version'],
      statusArgs: ['auth', 'status'],
      verifyArgs: (model) => ['-p', PROBE_PROMPT, '--model', model, '--output-format', 'json'],
      execArgs: (goal, cwd, model) => ['-p', goal, ...(model ? ['--model', model] : []), '--output-format', 'json', '--add-dir', cwd],
    },
    {
      id: 'grok',
      billing: billing('grok'),
      bin: bin('grok'),
      capabilities: { editInWorkspace: true, headless: true },
      versionArgs: ['--version'],
      statusArgs: ['models'],
      verifyArgs: (model) => ['--model', model, '--single', PROBE_PROMPT],
      execArgs: (goal, cwd, model) => [...(model ? ['--model', model] : []), '--cwd', cwd, '--single', goal],
    },
    {
      id: 'devin',
      billing: billing('devin'),
      bin: null, // source hard-codes null: no local CLI
      capabilities: { editInWorkspace: false, headless: true },
      versionArgs: [],
      statusArgs: null,
      verifyArgs: null,
      execArgs: () => [],
    },
    {
      id: 'cursor',
      billing: billing('cursor'),
      bin: bin('cursor'),
      capabilities: { editInWorkspace: false, headless: true },
      versionArgs: ['--version'],
      statusArgs: null,
      verifyArgs: null,
      execArgs: () => [],
    },
    {
      id: 'ollama',
      billing: billing('ollama'),
      bin: bin('ollama'),
      capabilities: { editInWorkspace: false, headless: true },
      versionArgs: ['--version'],
      statusArgs: ['list'],
      verifyArgs: null,
      execArgs: () => [],
    },
  ];
}

export function listAdapters(backends: AdapterBackendInputs): readonly CodingCliAdapter[] {
  return build(backends);
}

export function adapterById(backends: AdapterBackendInputs, id: string): CodingCliAdapter | null {
  return build(backends).find((adapter) => adapter.id === id) ?? null;
}
