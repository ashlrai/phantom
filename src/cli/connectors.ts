import { ConnectorError, importClients, readProfile, updateProfile, validateProfile } from '../core/connectors/profile.js';

import { runConnector } from '../core/connectors/run.js';
import { execConnector, execSession } from '../core/connectors/exec.js';
import { buildClientConfig } from '../core/connectors/client-config.js';
import { buildToolMesh } from '../core/connectors/mesh.js';
import { createTool, discoverTools, invokeTool, readRegistry, removeTool, revokeTool, type NewTool } from '../core/connectors/registry.js';

const USAGE = `phm connectors list|show <id>|remove <id> [--json]
phm connectors add <id> --kind mcp-stdio|mcp-http|cli|plugin [--description <text>] [--command <executable> | --url <https-url>] [--arg <argument>] [--scope <scope>] [--tool <tool>] [--lane <lane>] [--credential <binding=vault-name>] [--json]
phm connectors import [--json]
phm connectors mesh [--lane <lane>] [--json]
phm connectors tool list [--lane <lane>]|show <id>|remove <id>|revoke <id> --reason <text>|create --spec <json>|invoke <id> --lane <lane> [--param name=value] [--json]
phm connectors exec <id> --tool <tool> --lane <lane> [--project <dir>] [--json] -- <command> [args]
phm connectors config --client claude|cursor|codex --lane <lane> [--project <dir>] [--json]
phm connectors run <id> --scope <scope> --tool <tool> --lane <lane> [--json] -- <args>
Exec starts a cli or mcp-stdio connector; credentials are injected by phantom exec as session tokens, never values.
Config prints client MCP entries that launch through exec. Run is denied pending Security review. See docs/CONNECTORS.md.`;

export async function cmdConnectors(args: string[]): Promise<number> {
  const separator = args.indexOf('--');
  const options = separator < 0 ? args : args.slice(0, separator);
  const json = options.includes('--json');
  const emit = (v: unknown): void => { console.log(JSON.stringify(v, null, json ? 2 : undefined)); };
  try {
    const a = options.filter(v => v !== '--json');
    const verb = a.shift();
    if (!verb || ['--help', '-h', 'help'].includes(verb) || a.includes('--help') || a.includes('-h')) { if (json) emit({ usage: USAGE }); else console.log(USAGE); return 0; }
    if (verb === 'run') {
      const id = a.shift();
      const selectors: Record<string, string> = {};
      while (a.length) {
        const flag = a.shift()!;
        const value = a.shift();
        if (!['--scope', '--tool', '--lane'].includes(flag) || !value || selectors[flag.slice(2)] !== undefined) throw new ConnectorError('Run requires unique scope, tool and lane selectors before --.');
        selectors[flag.slice(2)] = value;
      }
      if (separator < 0 || !id) throw new ConnectorError('Use phm connectors run <id> --scope <scope> --tool <tool> --lane <lane> --json -- <args>.');
      await runConnector(id, { scope: selectors.scope ?? '', tool: selectors.tool ?? '', lane: selectors.lane ?? '' }, args.slice(separator + 1));
      return 0;
    }
    if (verb === 'exec' || verb === 'exec-session') {
      const id = a.shift();
      const { values } = flags(a, ['--tool', '--lane', '--project']);
      const cmd = args.slice(separator + 1);
      if (separator < 0 || !id || !cmd.length) throw new ConnectorError('Use phm connectors exec <id> --tool <tool> --lane <lane> -- <command> [args].');
      const selectors = { tool: values['--tool'] ?? '', lane: values['--lane'] ?? '' };
      // Success writes nothing: stdout belongs to the child (MCP stdio protocol).
      return verb === 'exec'
        ? await execConnector(id, selectors, cmd, { project: values['--project'] })
        : await execSession(id, selectors, cmd);
    }
    if (separator >= 0) throw new ConnectorError('Argument separator is supported only for run and exec.');
    if (verb === 'config') {
      const { values } = flags(a, ['--client', '--lane', '--project']);
      const result = await buildClientConfig(values['--client'] ?? '', values['--lane'] ?? '', { project: values['--project'] });
      if (json) emit(result); else process.stdout.write(result.config);
      if (!json) for (const s of result.skipped) console.error(`${s.id}: ${s.reason}`);
      return result.skipped.length ? 1 : 0;
    }
    if (verb === 'mesh') {
      const lane = a[0] === '--lane' ? a[1] : undefined;
      if (a.length !== (lane ? 2 : 0)) throw new ConnectorError('Unexpected arguments. Run phm connectors --help.');
      emit(await buildToolMesh(undefined, undefined, lane)); return 0;
    }
    if (verb === 'tool') { await cmdTool(a, emit); return 0; }
    if (verb === 'list' || verb === 'import') {
      if (a.length) throw new ConnectorError('Unexpected arguments. Run phm connectors --help.');
      if (verb === 'list') { emit(await readProfile()); return 0; }
      const report = await importClients(); emit(report); return report.skipped.length ? 1 : 0;
    }
    if (!['add', 'show', 'remove'].includes(verb)) throw new ConnectorError('Unknown connectors command. Run phm connectors --help.');
    const id = a.shift();
    if (!id || !/^[a-zA-Z][a-zA-Z0-9_.-]{0,79}$/.test(id)) throw new ConnectorError('Supply a connector id using letters, digits, dots, underscores or hyphens.');
    if (verb === 'add') {
      const data: Record<string, unknown> = { id, args: [], scopes: [], tools: [], lanes: [], credentials: [] };
      const repeated: Record<string, string> = { '--arg': 'args', '--scope': 'scopes', '--tool': 'tools', '--lane': 'lanes' };
      while (a.length) {
        const flag = a.shift()!;
        const value = a.shift();
        if (!value || value.startsWith('--')) throw new ConnectorError('Option requires a value. Run phm connectors --help.');
        if (repeated[flag]) (data[repeated[flag]!] as string[]).push(value);
        else if (flag === '--credential') {
          const parts = value.split('=');
          if (parts.length !== 2) throw new ConnectorError('Use --credential binding=vault-name; never supply a credential value.');
          (data.credentials as unknown[]).push({ binding: parts[0], name: parts[1] });
        } else if (['--kind', '--command', '--url', '--description'].includes(flag) && data[flag.slice(2)] === undefined) data[flag.slice(2)] = value;
        else throw new ConnectorError('Unknown or repeated option. Run phm connectors --help.');
      }
      const connector = validateProfile({ version: 1, connectors: [data] }).connectors[0]!;
      await updateProfile(p => {
        if (p.connectors.some(c => c.id === id)) throw new ConnectorError('Connector already exists. Use show to inspect it or remove before replacing.');
        return { ...p, connectors: [...p.connectors, connector] };
      });
      emit({ ok: true, connector }); return 0;
    }
    if (a.length) throw new ConnectorError('Unexpected arguments. Run phm connectors --help.');
    if (verb === 'show') {
      const connector = (await readProfile()).connectors.find(c => c.id === id);
      if (!connector) throw new ConnectorError('Connector not found. Run phm connectors list or add it first.');
      emit({ connector }); return 0;
    }
    await updateProfile(p => {
      if (!p.connectors.some(c => c.id === id)) throw new ConnectorError('Connector not found. Run phm connectors list.');
      return { ...p, connectors: p.connectors.filter(c => c.id !== id) };
    });
    emit({ ok: true, removed: id }); return 0;
  } catch (e) {
    // Filesystem, TOML and validator exceptions can contain rejected data. Never relay them.
    const error = e instanceof ConnectorError ? e.message : 'Connector operation failed. Check profile permissions and retry; run phm connectors --help.';
    if (json) emit({ ok: false, error }); else console.error(error);
    return 2;
  }
}


/** Flags may appear in any order; `--param` repeats. */
function flags(a: string[], allowed: string[]): { values: Record<string, string>; params: Record<string, string> } {
  const values: Record<string, string> = {}; const params: Record<string, string> = {};
  while (a.length) {
    const flag = a.shift()!; const value = a.shift();
    if (!allowed.includes(flag) || !value) throw new ConnectorError('Unknown option or missing value. Run phm connectors --help.');
    if (flag === '--param') {
      const i = value.indexOf('=');
      if (i < 1 || Object.hasOwn(params, value.slice(0, i))) throw new ConnectorError('Use --param name=value once per parameter.');
      params[value.slice(0, i)] = value.slice(i + 1);
    } else if (Object.hasOwn(values, flag)) throw new ConnectorError('Repeated option. Run phm connectors --help.');
    else values[flag] = value;
  }
  return { values, params };
}

async function cmdTool(a: string[], emit: (v: unknown) => void): Promise<void> {
  const verb = a.shift();
  const id = verb === 'list' || verb === 'create' ? undefined : a.shift();
  if (verb === 'list') { const { values } = flags(a, ['--lane']); emit(await discoverTools(undefined, values['--lane'])); return; }
  if (verb === 'create') {
    const { values } = flags(a, ['--spec']);
    let spec: unknown;
    try { spec = JSON.parse(values['--spec'] ?? ''); } catch { throw new ConnectorError('--spec must be a JSON object.'); }
    emit(await createTool(spec as NewTool)); return;
  }
  if (!id || !/^[a-zA-Z][a-zA-Z0-9_.-]{0,79}$/.test(id)) throw new ConnectorError('Supply a tool id. Run phm connectors --help.');
  if (verb === 'show') {
    const t = (await readRegistry()).tools.find(x => x.id === id);
    if (!t) throw new ConnectorError('Tool not found. Run phm connectors tool list.');
    emit(t); return;
  }
  if (verb === 'remove') { if (a.length) throw new ConnectorError('Unexpected arguments.'); await removeTool(id); emit({ removed: id }); return; }
  if (verb === 'revoke') { const { values } = flags(a, ['--reason']); await revokeTool(id, values['--reason'] ?? 'revoked'); emit({ revoked: id }); return; }
  if (verb === 'invoke') {
    const { values, params } = flags(a, ['--lane', '--param']);
    if (!values['--lane']) throw new ConnectorError('invoke requires --lane.');
    emit(await invokeTool(id, values['--lane'], params)); return;
  }
  throw new ConnectorError('Unknown tool command. Run phm connectors --help.');
}
