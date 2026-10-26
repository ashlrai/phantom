/**
 * Coding CLI adapters beside the API-key and local-model providers.
 *
 * Command shapes are the stable CLI surface. Model names come from the catalog
 * and stay off the argv until a probe marks them accepted. Grok's ambient
 * `grok` binary is the metered xAI CLI from the owner inventory, distinct from
 * the fleet `grok-cli` seat launcher.
 */

import type { BillingClass } from '../../routing/billing-class.js';
import type { CodingCliCatalog } from './catalog.js';

export interface AdapterCapabilities {
  editInWorkspace: boolean;
  headless: boolean;
}

export interface CodingCliAdapter {
  id: string;
  billing: BillingClass;
  bin: string | null;
  capabilities: AdapterCapabilities;
  /** Cheap presence check. No model call. */
  versionArgs: readonly string[];
  /** Cheap login or billing check. No model call. Null when there is no CLI. */
  statusArgs: readonly string[] | null;
  /**
   * Minimal exec that asks the account whether `model` is accepted.
   * Null when this backend has no headless exec (stubbed cloud or API).
   */
  verifyArgs: ((model: string) => readonly string[]) | null;
  /** Headless edit invocation. Model flag omitted unless `model` is accepted. */
  execArgs: (goal: string, cwd: string, model: string | null) => readonly string[];
}

const PROBE_PROMPT = 'Reply with the single word ok.';

function adapters(catalog: CodingCliCatalog): CodingCliAdapter[] {
  const bin = (id: string): string | null => catalog.backends[id]?.bin ?? null;
  const billing = (id: string): BillingClass => catalog.backends[id]?.billing ?? 'metered';
  return [
    {
      id: 'codex',
      billing: billing('codex'),
      bin: bin('codex'),
      capabilities: { editInWorkspace: true, headless: true },
      versionArgs: ['--version'],
      statusArgs: ['login', 'status'],
      verifyArgs: (model) => ['exec', '--skip-git-repo-check', '--model', model, '--json', PROBE_PROMPT],
      execArgs: (goal, cwd, model) => [
        'exec',
        ...(model ? ['--model', model] : []),
        '--cd',
        cwd,
        '--json',
        '--',
        goal,
      ],
    },
    {
      id: 'claude',
      billing: billing('claude'),
      bin: bin('claude'),
      capabilities: { editInWorkspace: true, headless: true },
      versionArgs: ['--version'],
      statusArgs: ['auth', 'status'],
      verifyArgs: (model) => ['-p', PROBE_PROMPT, '--model', model, '--output-format', 'json'],
      execArgs: (goal, cwd, model) => ['-p', ...(model ? ['--model', model] : []), '--output-format', 'json', '--add-dir', cwd, '--', goal],
    },
    {
      id: 'grok',
      billing: billing('grok'),
      bin: bin('grok'),
      capabilities: { editInWorkspace: true, headless: true },
      versionArgs: ['--version'],
      statusArgs: ['models'],
      verifyArgs: (model) => ['--model', model, '--single', PROBE_PROMPT],
      execArgs: (goal, cwd, model) => [
        ...(model ? ['--model', model] : []),
        '--cwd',
        cwd,
        `--single=${goal}`,
      ],
    },
    {
      id: 'devin',
      billing: billing('devin'),
      bin: null,
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

export function listAdapters(catalog: CodingCliCatalog): readonly CodingCliAdapter[] {
  return adapters(catalog);
}

export function adapterById(catalog: CodingCliCatalog, id: string): CodingCliAdapter | null {
  return adapters(catalog).find((adapter) => adapter.id === id) ?? null;
}

/** `grok models` text that names the API key billing mode. */
export function grokOutputIsMetered(text: string): boolean {
  return /XAI_API_KEY/i.test(text);
}

const LOGGED_OUT = /not logged in|login expired|please run .*login|sign in/i;
const LOGGED_IN = /logged in|signed in/i;

export function interpretLogin(text: string, code: number): 'in' | 'out' | 'unknown' {
  if (LOGGED_OUT.test(text)) return 'out';
  if (code === 0 && LOGGED_IN.test(text)) return 'in';
  return 'unknown';
}

const REJECTED = /not available|unknown model|does not exist|rejected|model .*not found|invalid model/i;

/** Account answer from a minimal exec. Cache text is not an input. */
export function interpretModelProbe(text: string, code: number): 'accepted' | 'rejected' {
  if (code !== 0 || REJECTED.test(text)) return 'rejected';
  if (text.trim() === '') return 'rejected';
  return 'accepted';
}
