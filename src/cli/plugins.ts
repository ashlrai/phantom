/**
 * cli/plugins.ts — `ashlr plugins list|info|enable|disable` + `ashlr x <name>` (M33).
 *
 * Trust posture (CONTRACT-M33 / docs/PLUGINS.md):
 *   - `list` / `info` are DISCOVERY ONLY — they read manifest.json files and
 *     NEVER import plugin code.
 *   - `enable` is the consent gate: shows declared capabilities + a trust
 *     warning, requires interactive confirmation (or --yes), and pins the
 *     entry file's sha256 into ~/.ashlr/config.json (tamper evidence).
 *     Stdin that is not a terminal never prompts (exit 2, prints the --yes
 *     command). --dry-run writes nothing. An unchanged pin reports already
 *     enabled and does not rewrite config.
 *   - `disable` removes the name from plugins.enabled (pin kept for re-enable).
 *     A name that is not enabled reports already disabled and exits 0.
 *     --dry-run writes nothing.
 *   - `ashlr x <name> [...]` runs an enabled plugin's command through the
 *     wrapped (audited, exit-code-safe) runner.
 *
 * Exit codes: 0 success, 1 runtime error, 2 bad usage (including enable
 * without --yes when stdin is not a terminal).
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';

import { loadConfig, loadConfigReadOnly, saveConfig } from '../core/config.js';
import { makeColors, isTty, pad } from './ui.js';
import { rejectUnknownOptions, type AllowedOptions } from './args.js';

const c = makeColors(isTty());

async function importRegistry() {
  return import('../core/plugins/registry.js');
}

async function importIntegrity() {
  return import('../core/plugins/integrity.js');
}

function printPluginsHelp(): void {
  console.log('');
  console.log(c.bold('  ashlr plugins') + c.dim('  manage the plugin layer (default-off)'));
  console.log('');
  console.log(`    ${c.cyan('ashlr plugins list [--json]')}`);
  console.log(`    ${c.cyan('ashlr plugins info <name> [--json]')}`);
  console.log(`    ${c.cyan('ashlr plugins init <name> [--capability scanner|template|provider|command] [--json] [--dry-run]')}`);
  console.log(`    ${c.cyan('ashlr plugins enable <name> [--yes] [--json] [--dry-run]')}`);
  console.log(`    ${c.cyan('ashlr plugins disable <name> [--json] [--dry-run]')}`);
  console.log(`    ${c.cyan('ashlr x <name> [args...]')}`);
  console.log('');
  console.log('  Examples:');
  console.log(`    ${c.cyan('phm plugins list --json')}`);
  console.log(`    ${c.cyan('phm plugins init my-scanner --capability scanner --dry-run')}`);
  console.log(`    ${c.cyan('phm plugins enable my-scanner --dry-run')}`);
  console.log(`    ${c.cyan('phm plugins enable my-scanner --yes')}`);
  console.log('');
  console.log('  Flags:');
  console.log(`    ${c.cyan('--json')}        one JSON value on stdout`);
  console.log(`    ${c.cyan('--yes')}         enable without a prompt`);
  console.log(`    ${c.cyan('--dry-run')}     report the change and write nothing`);
  console.log(`    ${c.cyan('--capability')}  init only: scanner, template, provider, or command`);
  console.log('');
  console.log('  ' + c.dim('When stdin is not a terminal, enable does not prompt. Pass --yes.'));
  console.log('  ' + c.dim('Exit 0 done, 1 plugin or entry file failed, 2 bad usage or enable without --yes.'));
  console.log('  ' + c.dim('Plugins live in ~/.ashlr/plugins/<name>/. See docs/PLUGINS.md for the trust model.'));
  console.log('');
}

/** Write a usage error to stderr and return exit code 2 (bad usage). */
function usageError(usage: string): number {
  process.stderr.write(`error: usage: ${usage}\n`);
  return 2;
}

/**
 * y/N prompt. When stdin is not a terminal this resolves false immediately
 * and does not read stdin, so a piped agent cannot hang. Callers must treat
 * that as a refusal and print the --yes command.
 */
function promptConfirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return Promise.resolve(false);
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    rl.question(`${question} [y/N] `, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

async function cmdPluginsList(jsonMode: boolean): Promise<number> {
  const { discoverPlugins } = await importRegistry();
  const cfg = loadConfig();
  const enabled = new Set(cfg.plugins?.enabled ?? []);
  const found = discoverPlugins();

  if (jsonMode) {
    process.stdout.write(
      JSON.stringify(
        found.map((p) => ({
          dir: p.dir,
          name: p.manifest?.name ?? basename(p.dir),
          ok: p.ok,
          reason: p.reason,
          enabled: p.manifest ? enabled.has(p.manifest.name) : false,
          capabilities: p.manifest?.capabilities ?? [],
          version: p.manifest?.version,
        })),
        null,
        2,
      ) + '\n',
    );
    return 0;
  }

  console.log('');
  console.log(c.bold('  ashlr plugins') + c.dim(`  — ${found.length} discovered (discovery never runs plugin code)`));
  console.log('');
  if (found.length === 0) {
    console.log(c.dim('  none — drop a plugin under ~/.ashlr/plugins/<name>/ (see docs/PLUGINS.md)'));
    console.log('');
    return 0;
  }
  for (const p of found) {
    const name = p.manifest?.name ?? basename(p.dir);
    const state = !p.ok
      ? c.red(`invalid (${p.reason ?? 'bad manifest'})`)
      : enabled.has(name)
        ? c.green('enabled')
        : c.dim('disabled');
    const caps = p.manifest?.capabilities.join(',') ?? '—';
    console.log(`    ${c.cyan(pad(name, 24))}  ${pad(state, 24)}  ${c.dim(`[${caps}] v${p.manifest?.version ?? '?'}`)}`);
  }
  console.log('');
  console.log(c.dim('  enable with: ashlr plugins enable <name>'));
  console.log('');
  return 0;
}

async function cmdPluginsInfo(name: string | undefined, jsonMode: boolean): Promise<number> {
  if (!name) {
    return usageError('ashlr plugins info <name>');
  }
  const { discoverPlugins } = await importRegistry();
  const found = discoverPlugins().find((p) => p.manifest?.name === name || basename(p.dir) === name);
  if (!found) {
    process.stderr.write(`error: plugin not found under ~/.ashlr/plugins/: ${name}\n`);
    return 1;
  }
  if (jsonMode) {
    process.stdout.write(JSON.stringify(found, null, 2) + '\n');
    return 0;
  }
  const cfg = loadConfig();
  console.log('');
  console.log(c.bold(`  ${name}`) + (found.ok ? '' : c.red('  (invalid manifest)')));
  if (found.manifest) {
    console.log(`    version       ${c.cyan(found.manifest.version)}`);
    console.log(`    apiVersion    ${c.cyan(found.manifest.apiVersion)}`);
    console.log(`    capabilities  ${c.cyan(found.manifest.capabilities.join(', ') || '(none)')}`);
    console.log(`    entry         ${c.dim(join(found.dir, found.manifest.entry))}`);
    if (found.manifest.description) console.log(`    description   ${found.manifest.description}`);
    console.log(`    enabled       ${(cfg.plugins?.enabled ?? []).includes(name) ? c.green('yes') : c.dim('no')}`);
    console.log(`    integrity     ${cfg.plugins?.integrity?.[name] ? c.green('pinned') : c.dim('not pinned')}`);
  } else if (found.reason) {
    console.log(`    ${c.red(found.reason)}`);
  }
  console.log('');
  return 0;
}

function enableResult(fields: {
  name: string;
  integrity: string;
  already: boolean;
  dryRun: boolean;
}): { ok: true; enabled: true; name: string; integrity: string; already: boolean; dryRun: boolean } {
  return { ok: true, enabled: true, name: fields.name, integrity: fields.integrity, already: fields.already, dryRun: fields.dryRun };
}

async function cmdPluginsEnable(name: string | undefined, yes: boolean, jsonMode: boolean, dryRun: boolean): Promise<number> {
  if (!name) {
    return usageError('ashlr plugins enable <name> [--yes] [--json] [--dry-run]');
  }
  const { discoverPlugins } = await importRegistry();
  const { hashEntry } = await importIntegrity();

  const found = discoverPlugins().find((p) => p.manifest?.name === name);
  if (!found?.ok || !found.manifest) {
    const why = found?.reason ? ` (${found.reason})` : '';
    process.stderr.write(
      `error: no valid plugin named "${name}" under ~/.ashlr/plugins/${why}\n` +
      '  Re-run: phm plugins list --json\n',
    );
    return 1;
  }

  const entryPath = join(found.dir, found.manifest.entry);
  const hash = hashEntry(entryPath);
  if (!hash) {
    process.stderr.write(
      `error: could not hash entry file ${entryPath}. The file is missing or unreadable.\n` +
      `  Re-run after the entry exists: phm plugins enable ${name} --yes\n`,
    );
    return 1;
  }

  const current = loadConfigReadOnly();
  const pinned = current.plugins?.integrity?.[name];
  const already = (current.plugins?.enabled ?? []).includes(name) && pinned === hash;
  if (already || dryRun) {
    const result = enableResult({ name, integrity: hash, already, dryRun });
    if (jsonMode) {
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    } else if (already) {
      console.log(c.green(`  already enabled ${name}`) + c.dim(' (entry pin unchanged)'));
    } else {
      console.log(c.dim(`  dry-run: would enable ${name} and pin ${hash.slice(0, 18)}…`));
      console.log(c.dim(`  Re-run: phm plugins enable ${name} --yes`));
    }
    return 0;
  }

  // Consent gate. stdin, not stdout: a terminal stdout with a piped stdin must not prompt.
  if (!yes) {
    if (!process.stdin.isTTY) {
      const message = `stdin is not a terminal, so plugins enable will not prompt. Re-run: phm plugins enable ${name} --yes`;
      if (jsonMode) {
        process.stdout.write(JSON.stringify({
          ok: false, enabled: false, name, already: false, dryRun: false, error: message,
        }) + '\n');
      }
      process.stderr.write(
        `error: ${message}\n` +
        `  Preview: phm plugins enable ${name} --dry-run\n`,
      );
      return 2;
    }
    console.log('');
    console.log(c.bold(`  Enable plugin "${name}" v${found.manifest.version}?`));
    console.log(`    capabilities: ${c.cyan(found.manifest.capabilities.join(', ') || '(none)')}`);
    console.log('');
    console.log(c.yellow('  An enabled plugin runs in-process with the same OS privileges as ashlr.'));
    console.log(c.yellow('  Only enable plugins whose source you have read or whose author you trust.'));
    console.log('');
    const confirmed = await promptConfirm('  Enable?');
    if (!confirmed) {
      console.log(c.dim('  Aborted. Plugin remains disabled.'));
      return 0;
    }
  }

  const cfg = loadConfig();
  const plugins = cfg.plugins ?? { enabled: [], settings: {}, integrity: {} };
  if (!plugins.enabled.includes(name)) plugins.enabled.push(name);
  plugins.integrity[name] = hash;
  cfg.plugins = plugins;
  saveConfig(cfg);

  const result = enableResult({ name, integrity: hash, already: false, dryRun: false });
  if (jsonMode) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    console.log(c.green(`  enabled ${name}`) + c.dim(` (entry pinned ${hash.slice(0, 18)}…)`));
    console.log('');
  }
  return 0;
}

function disableResult(name: string, already: boolean, dryRun: boolean): {
  ok: true; enabled: false; name: string; already: boolean; dryRun: boolean;
} {
  return { ok: true, enabled: false, name, already, dryRun };
}

async function cmdPluginsDisable(name: string | undefined, jsonMode: boolean, dryRun: boolean): Promise<number> {
  if (!name) {
    return usageError('ashlr plugins disable <name> [--json] [--dry-run]');
  }
  const current = loadConfigReadOnly();
  const enabled = current.plugins?.enabled ?? [];
  if (!enabled.includes(name)) {
    const result = disableResult(name, true, dryRun);
    if (jsonMode) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    else {
      console.log(c.dim(`  already disabled ${name}. Nothing changed.`));
      console.log(c.dim('  List plugins: phm plugins list --json'));
    }
    return 0;
  }
  if (dryRun) {
    const result = disableResult(name, false, true);
    if (jsonMode) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    else console.log(c.dim(`  dry-run: would disable ${name}. Re-run: phm plugins disable ${name}`));
    return 0;
  }

  const cfg = loadConfig();
  cfg.plugins = {
    enabled: (cfg.plugins?.enabled ?? []).filter((n) => n !== name),
    settings: cfg.plugins?.settings ?? {},
    integrity: cfg.plugins?.integrity ?? {},
  };
  saveConfig(cfg);
  const result = disableResult(name, false, false);
  if (jsonMode) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  else console.log(c.green(`  disabled ${name}`));
  return 0;
}

// ---------------------------------------------------------------------------
// plugins init — scaffold a working plugin skeleton
// ---------------------------------------------------------------------------

const INIT_CAPABILITIES = ['scanner', 'template', 'provider', 'command'] as const;
type InitCapability = (typeof INIT_CAPABILITIES)[number];

/** Entry-file skeleton per capability (plain ESM; works without a build step). */
function initEntrySource(name: string, capability: InitCapability): string {
  const header =
    `// ${name} — an ashlr plugin (capability: ${capability}).\n` +
    `// Typed authoring: npm i -D @ashlr/hub, then import { definePlugin } from '@ashlr/hub/plugin'.\n` +
    `// Docs + trust model: docs/PLUGINS.md in the ashlr-hub repo.\n\n`;
  switch (capability) {
    case 'scanner':
      return header + `export default {
  activate(host) {
    host.log('activated');
    return {
      scanners: [{
        id: 'example',
        // Return WorkItem-shaped objects. The hub wraps this: 15s timeout,
        // 100-item cap, value/effort clamped 1..5, score recomputed,
        // title/detail secret-scrubbed, ids namespaced.
        async scan(repo) {
          return [{
            id: 'demo', repo, source: 'plugin',
            title: 'Example finding from ${name}',
            detail: 'Replace scan() with real discovery logic.',
            value: 3, effort: 2, score: 0, tags: [], ts: new Date().toISOString(),
          }];
        },
      }],
    };
  },
};\n`;
    case 'template':
      return header + `export default {
  activate() {
    return {
      templates: [{
        id: 'starter', // exposed as '${name}:starter' in \`ashlr new --list\`
        title: 'Example starter',
        description: 'Scaffolded by the ${name} plugin.',
        files: ({ name: projectName }) => [
          { path: 'README.md', content: '# ' + projectName + '\\n' },
        ],
      }],
    };
  },
};\n`;
    case 'provider':
      return header + `export default {
  activate() {
    return {
      providers: [{
        id: '${name}-model',
        tier: 'local', // 'cloud' providers require --allow-cloud + envKeys presence
        async probe() { return { up: false }; },
        async createClient({ model }) {
          return {
            id: '${name}-model', supportsTools: false,
            async chat(messages) {
              return { text: 'not implemented', toolCalls: [], usage: { tokensIn: 0, tokensOut: 0 } };
            },
          };
        },
      }],
    };
  },
};\n`;
    case 'command':
      return header + `export default {
  activate() {
    return {
      commands: [{
        name: 'hello', // invoked as: ashlr x hello
        description: 'Example command from ${name}',
        async run(args, host) {
          host.log('hello ' + (args[0] ?? 'world'));
          return 0;
        },
      }],
    };
  },
};\n`;
  }
}

async function cmdPluginsInit(args: string[], jsonMode: boolean, dryRun: boolean): Promise<number> {
  const capIdx = args.indexOf('--capability');
  // The value after --capability is not the name: `init --capability command foo` names foo.
  const name = args.find((a, i) => !a.startsWith('--') && !(capIdx !== -1 && i === capIdx + 1));
  const capability = (capIdx !== -1 ? args[capIdx + 1] : 'scanner') as InitCapability;

  if (!name) {
    return usageError('ashlr plugins init <name> [--capability scanner|template|provider|command] [--json] [--dry-run]');
  }
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(name)) {
    process.stderr.write(`error: plugin name must match ^[a-z][a-z0-9-]{0,39}$ — got "${name}"\n`);
    return 2;
  }
  if (!INIT_CAPABILITIES.includes(capability)) {
    process.stderr.write(`error: --capability must be one of: ${INIT_CAPABILITIES.join(', ')}\n`);
    return 2;
  }

  const dir = join(homedir(), '.ashlr', 'plugins', name);
  if (existsSync(join(dir, 'manifest.json'))) {
    process.stderr.write(
      `error: ${dir} already has a manifest.json, so init will not overwrite it.\n` +
      `  Re-run: phm plugins enable ${name} --yes\n`,
    );
    return 1;
  }
  if (dryRun) {
    const result = { created: false, dryRun: true, name, capability, dir };
    if (jsonMode) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    else {
      console.log(c.dim(`  dry-run: would scaffold ${name} (${capability}) at ${dir}`));
      console.log(c.dim(`  Re-run: phm plugins init ${name} --capability ${capability}`));
    }
    return 0;
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify(
      {
        name,
        version: '0.1.0',
        apiVersion: '^1.0.0',
        description: `An ashlr ${capability} plugin.`,
        entry: './index.mjs',
        capabilities: [capability],
      },
      null,
      2,
    ) + '\n',
  );
  writeFileSync(join(dir, 'index.mjs'), initEntrySource(name, capability));

  if (jsonMode) {
    process.stdout.write(JSON.stringify({ created: true, dryRun: false, name, capability, dir }, null, 2) + '\n');
  } else {
    console.log('');
    console.log(c.green(`  ✓ scaffolded ${name}`) + c.dim(` (${capability}) at ${dir}`));
    console.log('');
    console.log('  Next steps:');
    console.log(`    1. Edit ${c.cyan(join(dir, 'index.mjs'))}`);
    console.log(`    2. ${c.cyan(`ashlr plugins enable ${name}`)}   ${c.dim('(confirm + integrity pin)')}`);
    if (capability === 'scanner') console.log(`    3. ${c.cyan('ashlr backlog refresh')}        ${c.dim('items appear tagged [plugin]')}`);
    if (capability === 'command') console.log(`    3. ${c.cyan('ashlr x hello')}`);
    if (capability === 'template') console.log(`    3. ${c.cyan('ashlr new --list')}             ${c.dim(`shows ${name}:starter`)}`);
    console.log('');
  }
  return 0;
}

/**
 * Options each plugins verb reads. Anything else is refused before a manifest
 * is read or a file written: `init <name> --capabilty command` used to
 * scaffold a scanner plugin.
 */
const PLUGINS_OPTIONS: Record<string, { allowed: AllowedOptions; usage: string }> = {
  init: {
    allowed: { flags: ['--json', '--dry-run'], values: ['--capability'] },
    usage: 'usage: ashlr plugins init <name> [--capability scanner|template|provider|command] [--json] [--dry-run]',
  },
  list: { allowed: { flags: ['--json'] }, usage: 'usage: ashlr plugins list [--json]' },
  info: { allowed: { flags: ['--json'] }, usage: 'usage: ashlr plugins info <name> [--json]' },
  enable: { allowed: { flags: ['--yes', '--json', '--dry-run'] }, usage: 'usage: ashlr plugins enable <name> [--yes] [--json] [--dry-run]' },
  disable: { allowed: { flags: ['--json', '--dry-run'] }, usage: 'usage: ashlr plugins disable <name> [--json] [--dry-run]' },
};

export async function cmdPlugins(args: string[]): Promise<number> {
  const sub = args[0];
  const jsonMode = args.includes('--json');
  const yes = args.includes('--yes');
  const dryRun = args.includes('--dry-run');

  // `plugins <verb> --help` / `-h` prints usage before any plugin is read or
  // scaffolded: the verbs took the flag as a plugin name.
  if (!sub || sub === 'help' || args.includes('--help') || args.includes('-h')) {
    printPluginsHelp();
    return 0;
  }
  const spec = Object.hasOwn(PLUGINS_OPTIONS, sub) ? PLUGINS_OPTIONS[sub] : undefined;
  if (spec) {
    const bad = rejectUnknownOptions(args.slice(1), spec.allowed);
    if (bad) {
      process.stderr.write(`error: ${bad.message}\n${spec.usage}\n`);
      return 2;
    }
  }
  if (sub === 'list') return cmdPluginsList(jsonMode);
  if (sub === 'info') return cmdPluginsInfo(args[1], jsonMode);
  if (sub === 'init') return cmdPluginsInit(args.slice(1), jsonMode, dryRun);
  if (sub === 'enable') return cmdPluginsEnable(args[1], yes, jsonMode, dryRun);
  if (sub === 'disable') return cmdPluginsDisable(args[1], jsonMode, dryRun);

  process.stderr.write(`error: unknown plugins subcommand: ${sub}\n`);
  printPluginsHelp();
  return 2;
}

/**
 * `ashlr x <name> [args...]` — run an enabled plugin's command (wrapped:
 * audited invocation + exit code; builtin shadowing rejected at load).
 */
export async function cmdX(args: string[]): Promise<number> {
  const name = args[0];
  if (!name || name === '--help' || name === '-h' || name === 'help') {
    console.log('');
    console.log(c.bold('  ashlr x') + c.dim(" — run an enabled plugin's command"));
    console.log(`    ${c.cyan('ashlr x <name> [args...]')}`);
    console.log('  ' + c.dim('Available commands come from enabled plugins — see `ashlr plugins list`.'));
    console.log('');
    return name ? 0 : 2;
  }

  const { loadEnabledPlugins } = await importRegistry();
  const { buildHostApi } = await import('../core/plugins/host-api.js');
  const { wrapCommand } = await import('../core/plugins/wrappers.js');
  const cfg = loadConfig();

  for (const p of await loadEnabledPlugins(cfg)) {
    const command = (p.contributions.commands ?? []).find((cmd) => cmd.name === name);
    if (command) {
      // The wrapper audits the invocation + exit code and never throws.
      const host = buildHostApi(p.manifest, cfg);
      return wrapCommand(p.name, command).run(args.slice(1), host);
    }
  }

  process.stderr.write(
    `error: no enabled plugin provides the command "${name}". ` +
    'Run `ashlr plugins list` to see enabled plugins.\n',
  );
  return 1;
}
