/**
 * Credential injection at launch. Phantom never holds a credential value:
 * `phantom exec` resolves vault entries and keeps real values inside its
 * loopback proxy, handing its child only session tokens (`phm_` + random hex)
 * that the proxy swaps for the real credential on outbound requests.
 *
 *   phm connectors exec <id> --tool T --lane L -- <command>
 *     -> phantom --quiet exec -- phm connectors exec-session <id> --tool T --lane L -- <command>
 *       -> <command> <profile args> <extra args>   (binding = session token, in env only)
 *
 * The session step re-reads the profile, maps each binding to the session token
 * phantom issued for its vault name and drops every unbound token, so a
 * connector reaches only its own credentials. Argv at every level holds ids,
 * selectors and the executable, never a value; nothing is logged.
 */
import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { constants } from 'node:os';
import { isAbsolute, sep } from 'node:path';
import { ConnectorError, name as nameSchema, readProfile, validateProfile, type Connector } from './profile.js';

export interface ExecSelectors { tool: string; lane: string; }
export interface ExecOptions {
  home?: string;
  env?: NodeJS.ProcessEnv;
  /** Phantom Secrets executable; resolved through PATH by default. */
  phantomBin?: string;
  /** Argv that re-enters this CLI (default: this Node process and script). */
  self?: string[];
  /** Working directory; phantom takes project custody (.phantom.toml) from it. */
  project?: string;
}
export interface ExecPlan { connector: Connector; argv: string[]; }

/** Session token prefix issued by `phantom exec` (phantom-core token.rs). */
const SESSION_TOKEN = /^phm_[0-9a-f]{64}$/;
/** Names-only list `phantom exec` exports for the variables it filled. */
const SESSION_KEYS = 'PHANTOM_SESSION_KEYS';
/** Phantom-internal variables a connector without credentials never needs. */
const PHANTOM_INTERNAL = ['PHANTOM_VAULT_PASSPHRASE', 'PHANTOM_PROXY_TOKEN', 'PHANTOM_PROXY_PORT', SESSION_KEYS];

/** Validates id, kind, selectors and extra args; returns the exact argv to launch. */
export async function planExec(id: string, selectors: ExecSelectors, cmd: string[], home?: string): Promise<ExecPlan> {
  if (!nameSchema.safeParse(id).success) throw new ConnectorError('Invalid connector id.');
  const connector = (await readProfile(home)).connectors.find(c => c.id === id);
  if (!connector) throw new ConnectorError('Connector not found. Run phm connectors list.');
  if (connector.kind !== 'cli' && connector.kind !== 'mcp-stdio') {
    throw new ConnectorError('Only cli and mcp-stdio connectors start a process. Configure mcp-http endpoints in the client; plugin entries need their host.');
  }
  // Empty selector lists deny: a connector must name the clients and lanes allowed to launch it.
  if (!selectors.tool || !selectors.lane || !connector.tools.includes(selectors.tool) || !connector.lanes.includes(selectors.lane)) {
    throw new ConnectorError('Connector selectors denied. Supply a tool and lane explicitly listed on the connector.');
  }
  // The executable is pinned by the profile so a connector's credentials never reach another program.
  if (cmd[0] !== connector.command) throw new ConnectorError('Command after -- must be the connector command exactly. Add arguments after it.');
  const argv = [connector.command!, ...connector.args, ...cmd.slice(1)];
  // Reuse the metadata boundary: credential-argument and secret-shape refusal for extra args.
  validateProfile({ version: 1, connectors: [{ ...connector, args: argv.slice(1) }] });
  return { connector, argv };
}

/**
 * Child environment inside a phantom session. Each binding receives the session
 * token phantom issued for its vault name; every other session token is removed.
 * Fails closed when phantom did not serve a referenced name.
 */
export function sessionEnv(connector: Connector, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (!env.PHANTOM_PROXY_TOKEN) throw new ConnectorError('exec-session runs only under phantom exec. Use phm connectors exec.');
  const served = new Set((env[SESSION_KEYS] ?? '').split(',').filter(Boolean));
  const tokens = new Map<string, string>();
  for (const { name } of connector.credentials) {
    const token = env[name];
    if (!served.has(name) || !token || !SESSION_TOKEN.test(token)) {
      throw new ConnectorError(`Vault name ${name} is not served by phantom exec here. Run phantom why ${name} in the project directory.`);
    }
    tokens.set(name, token);
  }
  const out: NodeJS.ProcessEnv = {};
  // Drop every session token (listed or merely token-shaped) before adding the bound ones back.
  for (const [key, value] of Object.entries(env)) {
    if (served.has(key) || (value && SESSION_TOKEN.test(value))) continue;
    out[key] = value;
  }
  for (const { binding, name } of connector.credentials) out[binding] = tokens.get(name)!;
  out[SESSION_KEYS] = connector.credentials.map(c => c.binding).sort().join(',');
  return out;
}

/** Runs argv with inherited stdio, forwarding termination signals; resolves the exit code. */
export function launch(argv: string[], env: NodeJS.ProcessEnv, cwd?: string): Promise<number> {
  return new Promise(resolve => {
    const failed = (): void => { process.stderr.write('Connector command could not be started. Check that it is installed and on PATH.\n'); };
    let child: ReturnType<typeof spawn>;
    // Spawn errors carry the attempted path only; report a static message.
    try { child = spawn(argv[0]!, argv.slice(1), { stdio: 'inherit', env, cwd }); } catch { failed(); resolve(127); return; }
    const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    const forward = (signal: NodeJS.Signals): void => { child.kill(signal); };
    for (const s of signals) process.on(s, forward);
    const done = (code: number): void => { for (const s of signals) process.off(s, forward); resolve(code); };
    child.on('error', () => { failed(); done(127); });
    child.on('exit', (code, signal) => done(code ?? (signal ? 128 + constants.signals[signal] : 1)));
  });
}

async function projectDir(project: string | undefined): Promise<string | undefined> {
  if (project === undefined) return undefined;
  if (!isAbsolute(project) || project.split(sep).some(p => p.toLowerCase() === '.codex')) {
    throw new ConnectorError('Use an absolute --project directory outside any .codex home.');
  }
  try { if ((await stat(project)).isDirectory()) return project; } catch { /* reported below */ }
  throw new ConnectorError('Project directory not found. Pass the directory holding .phantom.toml.');
}

const selfArgv = (): string[] => [process.execPath, ...process.execArgv, process.argv[1]!];

/** Outer launch. Connectors without credentials start directly; others start under phantom exec. */
export async function execConnector(id: string, selectors: ExecSelectors, cmd: string[], options: ExecOptions = {}): Promise<number> {
  const plan = await planExec(id, selectors, cmd, options.home);
  const cwd = await projectDir(options.project);
  const env = { ...(options.env ?? process.env) };
  if (!plan.connector.credentials.length) {
    for (const key of PHANTOM_INTERNAL) delete env[key];
    return launch(plan.argv, env, cwd);
  }
  const inner = [...(options.self ?? selfArgv()), 'connectors', 'exec-session', id, '--tool', selectors.tool, '--lane', selectors.lane, '--', ...cmd];
  return launch([options.phantomBin ?? 'phantom', '--quiet', 'exec', '--', ...inner], env, cwd);
}

/** Inner launch, running as phantom's child. Re-validates rather than trusting the outer process. */
export async function execSession(id: string, selectors: ExecSelectors, cmd: string[], options: ExecOptions = {}): Promise<number> {
  const plan = await planExec(id, selectors, cmd, options.home);
  if (!plan.connector.credentials.length) throw new ConnectorError('Connector has no credentials. Use phm connectors exec.');
  return launch(plan.argv, sessionEnv(plan.connector, options.env ?? process.env));
}
