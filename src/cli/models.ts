/**
 * `ashlr models` — local model management CLI.
 *
 * Subcommands:
 *   (none)           List the model registry (verified, unverified, stale), then
 *                    local models (Ollama + LM Studio).
 *   check [--diff <file>]
 *                    Report every model the router can pick as confirmed, stale or
 *                    unconfirmed; --diff compares a saved release-notes page.
 *   radar [--from <folder>] [--fetch [--propose]]
 *                    Compare official sources and optionally file pending notes.
 *   radar schedule [--install] [--hour <hour>]
 *   verify <id> --source <url>
 *                    Mark one model verified after its official doc page confirms the id.
 *   routing          Inspect recorded routing evidence without probing providers.
 *   pull <name>      Confirm then pull a model via `ollama pull` (EXPLICIT
 *                    only — large download; honors --yes to skip prompt).
 *   start            Best-effort start a locally-installed Ollama daemon.
 *
 * Flags (all subcommands):
 *   --json           Emit machine-readable JSON instead of human output.
 *   --yes            Skip interactive confirmation prompts (pull only).
 *
 * Returns process exit code: 0 success, 1 error, 2 bad usage.
 *
 * Guardrails:
 *   - `pull` NEVER runs automatically; only from this explicit path + confirm.
 *   - `start` NEVER auto-runs; only from the explicit `models start` path.
 *   - No secrets in output; no cloud interaction here.
 */

import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AshlrConfig, LocalModelInfo } from '../core/types.js';
import { ansi as C, pad, makeColors, isTty } from './ui.js';
import { BUILTIN_ENGINE_REGISTRY } from '../core/run/engine-registry.js';
import { probeApiModelEngine } from '../core/providers.js';
import type { ApiModelReadiness } from '../core/providers.js';
import type { ModelCheckReport } from '../core/fleet/model-check.js';
import type { ModelRadarReport } from '../core/fleet/model-radar.js';
import type { ModelRegistryRow, ModelVerifyOptions } from '../core/fleet/model-verify.js';

const { bold, dim, green, yellow, cyan, gray } = makeColors(isTty());

// ---------------------------------------------------------------------------
// Lazy imports (graceful degradation if model-manager not yet built)
// ---------------------------------------------------------------------------

type ListLocalModelsFn = (cfg: AshlrConfig) => Promise<LocalModelInfo[]>;
type OllamaInstalledFn = () => boolean;
type PullModelFn = (name: string) => Promise<{ ok: boolean; detail: string }>;
type StartOllamaFn = () => Promise<{ ok: boolean; detail: string }>;

let _listLocalModels: ListLocalModelsFn | null | undefined = undefined;
let _ollamaInstalled: OllamaInstalledFn | null | undefined = undefined;
let _pullModel: PullModelFn | null | undefined = undefined;
let _startOllama: StartOllamaFn | null | undefined = undefined;

async function loadModelManager(): Promise<{
  listLocalModels: ListLocalModelsFn;
  ollamaInstalled: OllamaInstalledFn;
  pullModel: PullModelFn;
  startOllama: StartOllamaFn;
} | null> {
  if (_listLocalModels === undefined) {
    try {
      const mod = await import('../core/run/model-manager.js') as {
        listLocalModels: ListLocalModelsFn;
        ollamaInstalled: OllamaInstalledFn;
        pullModel: PullModelFn;
        startOllama: StartOllamaFn;
      };
      _listLocalModels = mod.listLocalModels;
      _ollamaInstalled = mod.ollamaInstalled;
      _pullModel = mod.pullModel;
      _startOllama = mod.startOllama;
    } catch {
      _listLocalModels = null;
      _ollamaInstalled = null;
      _pullModel = null;
      _startOllama = null;
    }
  }
  if (
    _listLocalModels === null ||
    _ollamaInstalled === null ||
    _pullModel === null ||
    _startOllama === null
  ) {
    return null;
  }
  return {
    listLocalModels: _listLocalModels!,
    ollamaInstalled: _ollamaInstalled!,
    pullModel: _pullModel!,
    startOllama: _startOllama!,
  };
}

async function loadConfig(): Promise<AshlrConfig> {
  const mod = await import('../core/config.js') as { loadConfig: () => AshlrConfig };
  return mod.loadConfig();
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

interface ParsedModelsArgs {
  subcommand: 'list' | 'pull' | 'start' | 'inventory' | 'routing' | 'verify' | 'check' | 'radar';
  /** `radar --from <folder>`: saved release notes, one file per provider. */
  from?: string;
  /** `radar --fetch`: save today's pages into the folder first. */
  fetch?: boolean;
  propose?: boolean;
  /** `check --diff <file>`: a saved provider release-notes page. */
  diff?: string;
  pullName?: string;
  /** `verify <id> --source <url>`: the model to mark verified. */
  verifyId?: string;
  source?: string;
  provider?: string;
  lanes: string[];
  json: boolean;
  text?: boolean;
  yes: boolean;
  usageError?: string;
}

function parseModelsArgs(args: string[]): ParsedModelsArgs {
  const result: ParsedModelsArgs = {
    subcommand: 'list',
    json: false,
    yes: false,
    lanes: [],
  };

  // Strip flags first
  const positional: string[] = [];
  let i = 0;
  while (i < args.length) {
    const arg = args[i]!;
    if (arg === '--json') {
      result.json = true;
    } else if (arg === '--text') {
      result.text = true;
    } else if (arg === '--fetch') {
      result.fetch = true;
    } else if (arg === '--propose') {
      result.propose = true;
    } else if (arg === '--yes' || arg === '-y') {
      result.yes = true;
    } else if (arg === '--source' || arg === '--provider' || arg === '--lane' || arg === '--diff' || arg === '--from') {
      const value = args[++i];
      if (!value || value.startsWith('--')) { result.usageError = `${arg} needs a value`; return result; }
      if (arg === '--lane') result.lanes.push(value);
      else result[arg === '--source' ? 'source' : arg === '--diff' ? 'diff' : arg === '--from' ? 'from' : 'provider'] = value;
    } else if (arg === '--help' || arg === '-h') {
      // handled upstream via help check
    } else if (arg.startsWith('--')) {
      result.usageError = `unknown flag: ${arg}`;
      return result;
    } else {
      positional.push(arg);
    }
    i++;
  }

  const sub = positional[0];
  if (!sub || sub === 'list') {
    result.subcommand = 'list';
  } else if (sub === 'pull') {
    result.subcommand = 'pull';
    const name = positional[1];
    if (!name) {
      result.usageError = 'pull requires a model name: ashlr models pull <name>';
      return result;
    }
    result.pullName = name;
  } else if (sub === 'verify') {
    result.subcommand = 'verify';
    result.verifyId = positional[1];
    if (positional.length > 2 || result.yes || (result.verifyId ? !result.source || result.text : result.source))
      result.usageError = 'Usage: phm models verify [--text | --json], or phm models verify <id> --source <url> [--provider <name>] [--lane <lane>] [--json]';
  } else if (sub === 'check') {
    result.subcommand = 'check';
    if (positional.length > 1 || result.yes || result.source) result.usageError = 'Usage: phm models check [--json] [--diff <saved release-notes file>]';
  } else if (sub === 'radar') {
    result.subcommand = 'radar';
    if (positional.length > 1 || result.yes || result.source) result.usageError = 'Usage: phm models radar [--json] [--from <folder of saved release notes>] [--fetch [--propose]]';
  } else if (sub === 'routing') {
    result.subcommand = 'routing';
    if (positional.length > 1 || result.yes) result.usageError = 'Usage: phm models routing [--json]';
  } else if (sub === 'inventory') {
    result.subcommand = 'inventory';
    if (positional.length > 1 || result.yes) result.usageError = 'Usage: phm models inventory [--json]';
  } else if (sub === 'start') {
    result.subcommand = 'start';
  } else {
    result.usageError = `unknown subcommand: ${sub}. Use list, check, radar, routing, inventory, verify, pull <name>, or start.`;
  }

  if ((result.provider || result.lanes.length) && !result.verifyId) result.usageError = '--provider and --lane are only for models verify <id> --source <url>.';
  if (result.diff && result.subcommand !== 'check') result.usageError = '--diff is only for models check.';
  if ((result.from || result.fetch) && result.subcommand !== 'radar') result.usageError = '--from and --fetch are only for models radar.';
  if (result.propose && (result.subcommand !== 'radar' || !result.fetch)) result.usageError = '--propose requires models radar --fetch.';
  if (result.text && (result.subcommand !== 'verify' || result.json)) result.usageError = '--text is only for models verify and cannot be combined with --json.';
  return result;
}

// ---------------------------------------------------------------------------
// Interactive confirmation (readline, non-TTY safe)
// ---------------------------------------------------------------------------

async function confirm(prompt: string): Promise<boolean> {
  // Non-TTY (piped / scripted): default to no to avoid silent large downloads.
  if (!process.stdin.isTTY) return false;

  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes');
    });
  });
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function providerLabel(provider: 'ollama' | 'lmstudio'): string {
  return provider === 'ollama' ? cyan('ollama') : cyan('lmstudio');
}

function activeMarker(active: boolean): string {
  return active ? green('●') : dim('○');
}

// ---------------------------------------------------------------------------
// Subcommand: list
// ---------------------------------------------------------------------------

/** Plain status word for one registry row. */
export function registryStatus(row: ModelRegistryRow): string {
  return row.stale ? 'stale (verified over 30 days ago)' : row.status;
}

/** The registry table, no colour: one row per model, unknown shown as unknown. */
export function formatModelRegistry(rows: readonly ModelRegistryRow[] | null): string[] {
  if (rows === null) return ['  Model registry: unknown (it could not be read, so the router will not launch any model).', ''];
  if (rows.length === 0) return ['  Model registry: empty. Add a model: phm models verify <id> --provider <name> --source <official doc URL>', ''];
  const cells = rows.map(row => [row.id, row.provider, row.lanes.join(',') || 'unknown', registryStatus(row), row.verified_on ?? 'unknown', row.source_url ?? 'unknown']);
  const head = ['Model', 'Provider', 'Lanes', 'Status', 'Verified on', 'Source'];
  const widths = head.map((title, i) => Math.max(title.length, ...cells.map(cell => cell[i]!.length)));
  const line = (cell: string[]) => `  ${cell.map((text, i) => pad(text, widths[i]!)).join('  ').trimEnd()}`;
  const blocked = rows.filter(row => row.unverified).length;
  return [
    '  Model registry: the router only launches verified models', '', line(head), ...cells.map(line), '',
    `  ${rows.length - blocked} verified, ${blocked} blocked, ${rows.filter(row => row.stale).length} stale.  Verify one: phm models verify <id> --source <official doc URL>`, '',
  ];
}

/** `phm models check` in plain words: the top line, the three counts, the list, then the one next step. */
export function formatModelCheck(report: ModelCheckReport): string[] {
  if (report.registry === 'unknown') return [`Models: unknown. ${report.error}`];
  const { counts, diff } = report;
  const lines = [report.summary, `Models: ${counts.confirmed} confirmed, ${counts.stale} stale, ${counts.unconfirmed} unconfirmed`];
  for (const row of report.models) lines.push(`  ${row.id}: ${row.state}${row.routable ? '' : ', not routable'}; ${row.provider ?? 'unknown provider'}; lanes ${row.lanes.join(', ') || 'unknown'}; `
    + `confirmed ${row.confirmed_on ?? 'never'}; source ${row.source_url ?? 'none'}; docs ${row.docs}${row.replacement ? `, use ${row.replacement}` : ''}`);
  if (counts.stale || counts.unconfirmed) lines.push('Confirm one: phm models verify <id> --source <official doc URL>');
  for (const model of report.missing) lines.push(`  missing: ${model.id} (${model.provider}), seen ${model.seen_at}. Add it: phm models verify ${model.id} --source ${model.source_url} --provider ${model.provider}`);
  if (diff?.error) lines.push(`${diff.file}: ${diff.error}`);
  else if (diff) lines.push(`${diff.file} (${diff.provider}): ${diff.new.length} new, ${diff.renamed.length} renamed, ${diff.retired.length} retired`,
    ...diff.new.map(id => `  new: ${id}`), ...diff.renamed.map(pair => `  renamed: ${pair.from} is now ${pair.to}`), ...diff.retired.map(id => `  retired: ${id}`));
  return lines;
}

/** `phm models radar` in plain words: the one-line summary, each finding with its doc line, what is unknown, then the one next step. */
export function formatModelRadar(report: ModelRadarReport): string[] {
  if (report.registry === 'unknown') return [`Model radar: unknown. ${report.error}`];
  const lines = [report.summary];
  const row = (kind: string, item: ModelRadarReport['new_models'][number], what = item.id) =>
    lines.push(`  ${kind}: ${what} (${item.provider}, ${item.confidence} confidence), line ${item.line_number}: ${item.line}` +
      (item.source_url ? ` [${item.source_url}; retrieved ${item.retrieved_on}]` : ''));
  for (const item of report.new_models) row('new', item);
  for (const item of report.retired_models) row('retired', item);
  for (const item of report.renamed) row('renamed', item, `${item.from} is now ${item.id}`);
  for (const provider of report.providers) if (provider.note) lines.push(`  ${provider.doc === 'read' ? 'note' : 'unknown'}: ${provider.provider}: ${provider.note}`);
  for (const page of report.fetch ?? []) if (!page.saved) lines.push(`  not fetched: ${page.provider}: ${page.url}`);
  for (const notice of report.lane_notices) lines.push(`  configured lane ${notice.lane}: ${notice.id} (${notice.status === 'mentioned' ? 'retirement mentioned' : notice.status})${notice.replacement ? `; replacement: ${notice.replacement}` : ''}`);
  if (report.error) lines.push(report.error);
  const first = report.patch.add[0];
  if (first) lines.push(`Confirm one: phm models verify ${first.id} --provider ${first.provider} --source <official doc URL>`);
  if (report.proposals) {
    const { filed, existing, failed } = report.proposals;
    lines.push(`Inbox proposals: ${filed.length} filed, ${existing.length} already recorded, ${failed} failed. No registry patch was applied.`);
  } else lines.push('Nothing was changed. The proposed registry patch is in --json.');
  return lines;
}

async function cmdModelsList(
  cfg: AshlrConfig,
  mm: Awaited<ReturnType<typeof loadModelManager>>,
  json: boolean,
  verifyOptions: ModelVerifyOptions,
): Promise<number> {
  const { listModelRegistry } = await import('../core/fleet/model-verify.js');
  // Unreadable is reported as unknown (null), never as an empty registry.
  const registry = await listModelRegistry(verifyOptions).then(list => list.entries, () => null);

  if (!mm) {
    process.stderr.write(
      `${C.red}error:${C.reset} models command requires src/core/run/model-manager.ts (M15 module not yet built).\n`,
    );
    return 1;
  }

  let models: LocalModelInfo[];
  try {
    models = await mm.listLocalModels(cfg);
  } catch (err) {
    process.stderr.write(
      `${C.red}error:${C.reset} failed to list local models: ` +
        (err instanceof Error ? err.message : String(err)) + '\n',
    );
    return 1;
  }

  // Probe api-model engines from the builtin registry (nim, kimi, openai-compat)
  const apiEngines = Object.values(BUILTIN_ENGINE_REGISTRY).filter(
    (e) => e.kind === 'api-model' && e.api,
  );
  const apiReadiness: ApiModelReadiness[] = await Promise.all(
    apiEngines.map((e) => probeApiModelEngine(e.id, e.api!)),
  );

  if (json) {
    process.stdout.write(JSON.stringify({ registry, local: models, apiEngines: apiReadiness }, null, 2) + '\n');
    return 0;
  }

  console.log('');
  console.log(bold('  ashlr models') + gray(' — model registry, local models (Ollama + LM Studio) + API engines'));
  console.log('');
  for (const line of formatModelRegistry(registry)) console.log(line);

  if (models.length === 0) {
    console.log(`  ${dim('No local models found. Is Ollama or LM Studio running?')}`);
    console.log('');
    const installed = mm.ollamaInstalled();
    if (!installed) {
      console.log(`  ${yellow('Tip:')} Ollama is not installed. Visit https://ollama.com to install.`);
    } else {
      console.log(`  ${yellow('Tip:')} Start Ollama with ${bold('ashlr models start')}, then pull a model:`);
      console.log(`         ${cyan('phm models pull MODEL_TAG')}`);
    }
    console.log('');
    return 0;
  }

  // Table layout
  const provW  = 10;
  const nameW  = Math.min(50, Math.max(10, ...models.map(m => m.name.length)));
  const sizeW  = 10;

  console.log(
    `  ${bold(pad('', 2))}` +
    `${bold(pad('Provider', provW))}  ` +
    `${bold(pad('Model', nameW))}  ` +
    `${bold(pad('Size', sizeW))}`,
  );
  console.log(
    `  ${'─'.repeat(2)}` +
    `${'─'.repeat(provW)}  ` +
    `${'─'.repeat(nameW)}  ` +
    `${'─'.repeat(sizeW)}`,
  );

  for (const m of models) {
    const marker  = activeMarker(m.active);
    const size    = m.sizeLabel ? gray(pad(m.sizeLabel, sizeW)) : dim(pad('—', sizeW));
    const nameFmt = m.active ? bold(cyan(pad(m.name, nameW))) : pad(m.name, nameW);

    console.log(
      `  ${marker} ` +
      `${pad(providerLabel(m.provider), provW)}  ` +
      `${nameFmt}  ` +
      size,
    );
  }

  console.log('');

  const activeCount = models.filter(m => m.active).length;
  const ollamaCount = models.filter(m => m.provider === 'ollama').length;
  const lmsCount    = models.filter(m => m.provider === 'lmstudio').length;

  const parts: string[] = [];
  if (ollamaCount > 0) parts.push(`${ollamaCount} ollama`);
  if (lmsCount > 0)    parts.push(`${lmsCount} lmstudio`);
  console.log(
    `  ${dim(parts.join(', '))}` +
    (activeCount > 0 ? `  ${dim('·')}  ${green(`${activeCount} active`)}` : ''),
  );
  console.log('');

  console.log(
    `  ${dim('Pull a model:')} ${cyan('ashlr models pull <name>')}  ` +
    `${dim('Start Ollama:')} ${cyan('ashlr models start')}`,
  );
  console.log('');

  // ---------------------------------------------------------------------------
  // API engines section (nim, kimi, openai-compat)
  // ---------------------------------------------------------------------------
  if (apiReadiness.length > 0) {
    console.log(bold('  API engines') + gray(' — OpenAI-compatible cloud backends (opt-in)'));
    console.log('');

    const idW    = Math.max(12, ...apiReadiness.map((r) => r.engineId.length));
    const statusW = 12;
    const modelW = 36;

    console.log(
      `  ${bold(pad('', 2))}` +
      `${bold(pad('Engine', idW))}  ` +
      `${bold(pad('Status', statusW))}  ` +
      `${bold(pad('Default model', modelW))}`,
    );
    console.log(
      `  ${'─'.repeat(2)}` +
      `${'─'.repeat(idW)}  ` +
      `${'─'.repeat(statusW)}  ` +
      `${'─'.repeat(modelW)}`,
    );

    for (const r of apiReadiness) {
      const spec = BUILTIN_ENGINE_REGISTRY[r.engineId];
      const defaultModel = spec?.api?.defaultModel ?? '—';
      let statusStr: string;
      if (!r.keyPresent) {
        statusStr = yellow(pad('no key', statusW));
      } else if (r.reachable) {
        statusStr = green(pad('ready', statusW));
      } else {
        statusStr = yellow(pad('key, unreachable', statusW));
      }
      const marker = r.keyPresent && r.reachable ? green('●') : dim('○');
      console.log(
        `  ${marker} ` +
        `${pad(r.engineId, idW)}  ` +
        `${statusStr}  ` +
        `${dim(pad(defaultModel, modelW))}`,
      );
      if (r.error) {
        console.log(`    ${dim(r.error)}`);
      }
    }

    console.log('');
    console.log(
      `  ${dim('Enable an API engine:')} add its id to ${cyan('foundry.allowedBackends')} in ${cyan('~/.ashlr/config.json')}`,
    );
    console.log(
      `  ${dim('Existing environment key:')} ${cyan('NVIDIA_NIM_API_KEY')}`,
    );
    console.log('');
  }

  return 0;
}

// ---------------------------------------------------------------------------
// Subcommand: pull <name>
// ---------------------------------------------------------------------------

async function cmdModelsPull(
  name: string,
  mm: Awaited<ReturnType<typeof loadModelManager>>,
  opts: { json: boolean; yes: boolean },
): Promise<number> {
  if (!mm) {
    process.stderr.write(
      `${C.red}error:${C.reset} models command requires src/core/run/model-manager.ts (M15 module not yet built).\n`,
    );
    return 1;
  }

  if (!mm.ollamaInstalled()) {
    if (opts.json) {
      process.stdout.write(JSON.stringify({ ok: false, detail: 'ollama is not installed' }) + '\n');
    } else {
      console.error(
        `${C.red}error:${C.reset} ollama is not installed. ` +
        `Visit https://ollama.com to install it, then retry.`,
      );
    }
    return 1;
  }

  // Confirm: pulling is potentially a multi-GB download — always require opt-in.
  if (!opts.yes) {
    const ok = await confirm(
      `\n  Pull model ${bold(name)} via ollama?\n` +
      `  ${yellow('Warning:')} This may download several gigabytes.\n\n` +
      `  Continue? [y/N] `,
    );
    if (!ok) {
      if (!opts.json) {
        console.log('');
        console.log(`  ${dim('Pull cancelled.')}`);
        console.log('');
      }
      return 0;
    }
  }

  if (!opts.json) {
    console.log('');
    console.log(`  Pulling ${bold(name)} via ollama…`);
    console.log(`  ${dim('This may take a few minutes depending on model size.')}`);
    console.log('');
  }

  let result: { ok: boolean; detail: string };
  try {
    result = await mm.pullModel(name);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (opts.json) {
      process.stdout.write(JSON.stringify({ ok: false, detail }) + '\n');
    } else {
      console.error(`${C.red}error:${C.reset} pull failed: ${detail}`);
    }
    return 1;
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify(result) + '\n');
    return result.ok ? 0 : 1;
  }

  if (result.ok) {
    console.log(`  ${green('✓')} Pulled ${bold(name)} successfully.`);
    if (result.detail) console.log(`  ${dim(result.detail)}`);
    console.log('');
    console.log(`  ${dim('Run')} ${cyan('ashlr models')} ${dim('to see updated model list.')}`);
  } else {
    console.error(`  ${C.red}error:${C.reset} pull failed: ${result.detail}`);
  }
  console.log('');

  return result.ok ? 0 : 1;
}

// ---------------------------------------------------------------------------
// Subcommand: start
// ---------------------------------------------------------------------------

async function cmdModelsStart(
  mm: Awaited<ReturnType<typeof loadModelManager>>,
  json: boolean,
): Promise<number> {
  if (!mm) {
    process.stderr.write(
      `${C.red}error:${C.reset} models command requires src/core/run/model-manager.ts (M15 module not yet built).\n`,
    );
    return 1;
  }

  if (!mm.ollamaInstalled()) {
    if (json) {
      process.stdout.write(JSON.stringify({ ok: false, detail: 'ollama is not installed' }) + '\n');
    } else {
      console.error(
        `${C.red}error:${C.reset} ollama is not installed. ` +
        `Visit https://ollama.com to install it first.`,
      );
    }
    return 1;
  }

  if (!json) {
    console.log('');
    console.log(`  Starting Ollama… ${dim('(best-effort, local install only)')}`);
  }

  let result: { ok: boolean; detail: string };
  try {
    result = await mm.startOllama();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (json) {
      process.stdout.write(JSON.stringify({ ok: false, detail }) + '\n');
    } else {
      console.error(`\n${C.red}error:${C.reset} failed to start Ollama: ${detail}`);
    }
    return 1;
  }

  if (json) {
    process.stdout.write(JSON.stringify(result) + '\n');
    return result.ok ? 0 : 1;
  }

  if (result.ok) {
    console.log(`  ${green('✓')} Ollama started.`);
    if (result.detail) console.log(`  ${dim(result.detail)}`);
    console.log('');
    console.log(`  ${dim('Run')} ${cyan('ashlr models')} ${dim('to list available models.')}`);
  } else {
    console.log(`  ${yellow('!')} ${result.detail}`);
  }
  console.log('');

  return result.ok ? 0 : 1;
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

function printModelsHelp(): void {
  console.log('');
  console.log(bold('  ashlr models') + dim(' — local model management (Ollama + LM Studio)'));
  console.log('');
  console.log('  ' + bold('Usage:'));
  console.log('');
  console.log(`    ashlr models [subcommand] [flags]`);
  console.log('');
  console.log('  ' + bold('Subcommands:'));
  console.log('');

  const subs: [string, string][] = [
    ['check [--diff <file>]', 'Report every model the router can pick: confirmed, stale (over 14 days) or unconfirmed (not routable), and what provider docs say.'],
    ['radar [--from <folder>] [--fetch [--propose]]', 'Find new and retiring models; optionally file fresh candidates as pending inbox notes.'],
    ['radar schedule [--install] [--hour <hour>]', 'Preview or explicitly install the daily model radar user job.'],
    ['verify', 'Show model status, evidence age and configured choices (JSON by default; --text for people).'],
    ['verify <id> --source <url>', 'Mark one model verified once its official doc page names the exact id (--provider adds a new model).'],
    ['routing', 'Inspect recorded task fit, latency availability and execution feedback (read-only).'],
    ['inventory', 'Measure opt-in loopback models and write fleet.json resources.models.'],
    ['(none) / list',    'List the model registry (verified, unverified, stale), then local models.'],
    ['pull <name>',      'Pull a model by name via `ollama pull` (confirms first; large download).'],
    ['start',            'Best-effort start a locally-installed Ollama daemon.'],
  ];
  const subW = Math.max(...subs.map(([s]) => s.length));
  for (const [sub, desc] of subs) {
    console.log(`    ${cyan(pad(sub, subW))}  ${desc}`);
  }

  console.log('');
  console.log('  ' + bold('Flags:'));
  console.log('');

  const opts: [string, string][] = [
    ['--json',    'Emit machine-readable JSON on stdout; no ANSI rendering.'],
    ['--text',    'Show models verify in plain words.'],
    ['--yes',     'Skip the pull confirmation prompt (use in scripts).'],
    ['--source',  'Official doc or changelog URL that names the model (models verify <id>).'],
    ['--provider', 'Provider of a model that is not in the registry yet (models verify <id>).'],
    ['--lane',    'A lane that can run the model; repeat for more (models verify <id>).'],
    ['--diff',    'A saved provider release-notes page; lists new, renamed and retired ids (models check).'],
    ['--from',    'Folder of saved release notes, one file per provider such as anthropic.md (models radar).'],
    ['--fetch',   'Save today\'s official release-notes pages into the folder first (models radar).'],
    ['--propose', 'File fresh candidates with evidence and an unapplied patch (requires --fetch).'],
    ['--install', 'Install the model radar user schedule; otherwise print it.'],
    ['--hour',    'Local hour for the model radar schedule (0–23, default 3).'],
  ];
  const optW = Math.max(...opts.map(([o]) => o.length));
  for (const [opt, desc] of opts) {
    console.log(`    ${cyan(pad(opt, optW))}  ${desc}`);
  }

  console.log('');
  console.log('  ' + bold('Notes:'));
  console.log('');
  console.log(`    ${dim('• Models are never downloaded automatically — only via explicit `pull`.')}`);
  console.log(`    ${dim('• `start` only starts an already-installed local Ollama; it never installs.')}`);
  console.log(`    ${dim('• Cloud providers are not managed here — configure via ashlr config.')}`);
  console.log('');
  console.log('  ' + bold('Examples:'));
  console.log('');
  console.log(`    ${cyan('ashlr models')}                      ${dim('# list all local models')}`);
  console.log(`    ${cyan('ashlr models --json')}               ${dim('# machine-readable list')}`);
  console.log(`    ${cyan('phm models pull MODEL_TAG')}        ${dim('# pull a model (confirms)')}`);
  console.log(`    ${cyan('phm models pull MODEL_TAG --yes')}  ${dim('# pull without prompt (CI)')}`);
  console.log(`    ${cyan('ashlr models start')}                ${dim('# start local Ollama')}`);
  console.log('');
  console.log('  ' + bold('Exit codes:'));
  console.log('');
  console.log(`    ${dim('0  success')}`);
  console.log(`    ${dim('1  error (provider unreachable, pull failed, etc.)')}`);
  console.log(`    ${dim('2  bad usage / unknown subcommand or flag')}`);
  console.log('');
}

// ---------------------------------------------------------------------------
// cmdModels — main entry point
async function cmdModelRadarSchedule(args: string[]): Promise<number> {
  const usage = 'Usage: phm models radar schedule [--install] [--hour <hour>]';
  if (args.includes('--help') || args.includes('-h')) { console.log(usage); return 0; }
  let install = false, hour: number | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--install' && !install) { install = true; continue; }
    if (args[i] === '--hour' && hour === undefined) {
      const value = args[++i] ?? '';
      if (/^\d{1,2}$/.test(value) && Number(value) <= 23) { hour = Number(value); continue; }
    }
    console.error(usage);
    return 2;
  }
  try {
    const { modelRadarSchedule } = await import('../core/fleet/model-radar-schedule.js');
    const units = modelRadarSchedule({ phmPath: fileURLToPath(new URL('../../bin/ashlr', import.meta.url)), hour });
    if (!install) {
      for (const unit of units) console.log(`# ${unit.path}\n${unit.contents}`);
      return 0;
    }
    if (process.getuid?.() === 0) throw new Error('Install the schedule as a regular user, not root.');
    if (!existsSync(fileURLToPath(new URL('../../dist/cli/index.js', import.meta.url)))) {
      throw new Error('Compiled CLI missing; run npm run build before installing the schedule.');
    }
    const { installScheduleUnits } = await import('./steward.js');
    return installScheduleUnits(units, { logName: 'model-radar.jsonl' });
  } catch (error) {
    console.error(`Model radar schedule failed: ${(error as Error).message}`);
    return 1;
  }
}

// ---------------------------------------------------------------------------

/**
 * `ashlr models` — local model management.
 * Returns process exit code.
 */
export async function cmdModels(args: string[], verifyOptions: ModelVerifyOptions = {}): Promise<number> {
  if (args[0] === 'radar' && args[1] === 'schedule') return cmdModelRadarSchedule(args.slice(2));
  // Help shortcircuit
  // `models <verb> --help` / `-h` too: `models
  // list -h` probed local model servers and `models start -h` looked for
  // ollama to launch it.
  if (args[0] === 'help' || args.some((arg) => arg === '--help' || arg === '-h')) {
    printModelsHelp();
    return 0;
  }

  const parsed = parseModelsArgs(args);

  if (parsed.usageError) {
    process.stderr.write(`${C.red}error:${C.reset} ${parsed.usageError}\n`);
    process.stderr.write(`Run ${C.cyan}ashlr models --help${C.reset} for usage.\n`);
    return 2;
  }

  if (parsed.subcommand === 'check') {
    const { checkModels } = await import('../core/fleet/model-check.js');
    const report = await checkModels({ ...verifyOptions, diffPath: parsed.diff });
    if (parsed.json) console.log(JSON.stringify(report, null, 2));
    else for (const line of formatModelCheck(report)) console.log(line);
    return report.ok ? 0 : 1;
  }

  if (parsed.subcommand === 'radar') {
    const { runModelRadar } = await import('../core/fleet/model-radar.js');
    const { homeFile } = await import('../core/fleet/model-verify.js');
    const folder = homeFile('model-radar', parsed.from, verifyOptions);
    // A page that fails keeps its last saved copy; the report lists every page that was not saved.
    const fetcher = parsed.fetch && folder ? await import('../core/fleet/model-radar-fetch.js') : null;
    const freshDocs: import('../core/fleet/model-radar.js').ModelRadarDoc[] = [];
    // A folder that cannot be written saves nothing, and the report says so page by page.
    const fetched = await fetcher?.fetchModelRadarDocs(folder!, undefined, doc => freshDocs.push(doc), verifyOptions.now)
      .catch(() => {
        freshDocs.length = 0;
        return fetcher.MODEL_RADAR_SOURCES.map(({ provider, url }) => ({ provider, url, saved: false }));
      });
    const report = await runModelRadar({ ...verifyOptions, from: parsed.from, fetched, freshDocs });
    if (parsed.propose) {
      const { fileModelRadarProposals } = await import('../core/fleet/model-radar-proposals.js');
      report.proposals = fileModelRadarProposals(report);
    }
    if (parsed.json) console.log(JSON.stringify(report, null, 2));
    else for (const line of formatModelRadar(report)) console.log(line);
    return (parsed.propose ? fetched?.some(page => page.saved) && !report.error && !report.proposals?.failed : report.ok) ? 0 : 1;
  }

  if (parsed.subcommand === 'verify' && parsed.verifyId) {
    const { markModelVerified, ModelVerifyRefusal } = await import('../core/fleet/model-verify.js');
    try {
      const entry = await markModelVerified({ id: parsed.verifyId, source: parsed.source!, provider: parsed.provider, lanes: parsed.lanes }, verifyOptions);
      console.log(parsed.json ? JSON.stringify({ ok: true, entry }) : `Verified ${entry.id} on ${entry.verified_on}. Source: ${entry.source_url}. The router can use it now.`);
      return 0;
    } catch (err) {
      // Only our own refusals are shown; other errors can carry file contents.
      const error = err instanceof ModelVerifyRefusal ? err.message : 'Cannot read or update the model registry.';
      if (parsed.json) console.log(JSON.stringify({ ok: false, error }));
      else console.error(error);
      return 1;
    }
  }

  if (parsed.subcommand === 'verify') {
    try {
      const { verifyModelRegistry } = await import('../core/fleet/model-verify.js');
      const report = await verifyModelRegistry(verifyOptions);
      if (!parsed.text) console.log(JSON.stringify(report));
      else {
        for (const row of report.results) console.log(`${row.id}: ${row.status}; age ${row.age_days === null ? 'unknown' : `${row.age_days} days`}${row.needs_recheck ? '; re-check needed' : ''}`);
        for (const choice of report.current_choices) if (choice.status !== 'verified') console.log(`${choice.key}: ${choice.model ?? 'unknown'} is ${choice.status}.`);
        console.log(report.error ?? (report.ok ? 'All configured choices are verified.' : 'Router choices need verification.'));
      }
      return report.ok ? 0 : 1;
    } catch {
      const error = 'Cannot read or validate model registry.';
      if (parsed.text) console.error(error);
      else console.log(JSON.stringify({ schema: 'models.verify.v1', results: [], current_choices: [], ok: false, error }));
      return 1;
    }
  }

  if (parsed.subcommand === 'routing') {
    const { cmdRoutingObservation } = await import('./telemetry.js');
    return cmdRoutingObservation(parsed.json);
  }

  if (parsed.subcommand === 'inventory') {
    try {
      const { runModelInventory } = await import('../core/resources/model-inventory.js');
      const result = await runModelInventory();
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      return result.unavailableEngines.length || result.models.some(row => row.status !== 'measured') ? 1 : 0;
    } catch {
      process.stderr.write('Model inventory refused or unavailable. Check opt-in configuration, idle engines and memguard admission.\n');
      return 1;
    }
  }

  // Load model-manager (lazy; degrades if M15 core not yet built)
  const mm = await loadModelManager();

  // Load config (needed for list; not needed for start/pull but load once here)
  let cfg: AshlrConfig | null = null;
  if (parsed.subcommand === 'list') {
    try {
      cfg = await loadConfig();
    } catch (err) {
      process.stderr.write(
        `${C.red}error:${C.reset} failed to load config: ` +
          (err instanceof Error ? err.message : String(err)) + '\n',
      );
      return 1;
    }
  }

  switch (parsed.subcommand) {
    case 'list':
      return cmdModelsList(cfg!, mm, parsed.json, verifyOptions);

    case 'pull':
      return cmdModelsPull(parsed.pullName!, mm, { json: parsed.json, yes: parsed.yes });

    case 'start':
      return cmdModelsStart(mm, parsed.json);

    default:
      // unreachable; parseModelsArgs covers all cases
      process.stderr.write(`${C.red}error:${C.reset} unknown subcommand\n`);
      return 2;
  }
}
