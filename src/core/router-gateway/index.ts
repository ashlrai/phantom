/** The entry points the CLI, the MCP tool and the HTTP endpoint share. Each
 * loads the one config file, builds production deps and calls the same
 * `routedComplete` / `planRoutedCompletion`. */
import type { AshlrConfig } from '../types.js';
import { loadRouterGatewayConfig, type LoadedRouterGatewayConfig } from './config.js';
import {
  listRouterModels,
  planRoutedCompletion,
  routedComplete,
  type RoutedCompletionRequest,
  type RoutedCompletionResult,
  type RouterGatewayDeps,
  type RouterModelEntry,
  type RouterPlan,
} from './complete.js';
import { loadRouterGatewayDeps } from './deps.js';
import { ensureRouterGatewayToken, routerGatewayTokenPath, startRouterGatewayServer, type RunningRouterGateway } from './server.js';

export * from './config.js';
export * from './complete.js';
export { flattenChatMessages, parseChatRequest, ROUTER_GATEWAY_HOST, ROUTER_GATEWAY_SCHEMA, routerGatewayTokenPath } from './server.js';

async function loadDefaultConfig(): Promise<AshlrConfig> {
  const { loadConfig } = await import('../config.js');
  return loadConfig();
}

async function prepare(configPath?: string, cfg?: AshlrConfig): Promise<{ loaded: LoadedRouterGatewayConfig; deps: RouterGatewayDeps }> {
  const loaded = loadRouterGatewayConfig(configPath);
  const deps = await loadRouterGatewayDeps(cfg ?? await loadDefaultConfig(), loaded.config);
  return { loaded, deps };
}

export async function completeViaRouter(req: RoutedCompletionRequest, opts: { configPath?: string; cfg?: AshlrConfig } = {}): Promise<RoutedCompletionResult> {
  const { deps } = await prepare(opts.configPath, opts.cfg);
  return routedComplete(deps, req);
}

export async function planViaRouter(req: Omit<RoutedCompletionRequest, 'signal'>, opts: { configPath?: string; cfg?: AshlrConfig } = {}): Promise<RouterPlan> {
  const { deps } = await prepare(opts.configPath, opts.cfg);
  return planRoutedCompletion(deps, req);
}

export async function listModelsViaRouter(opts: { configPath?: string; cfg?: AshlrConfig } = {}): Promise<RouterModelEntry[]> {
  const { deps } = await prepare(opts.configPath, opts.cfg);
  return listRouterModels(deps);
}

export interface ServeRouterGatewayResult {
  running: RunningRouterGateway;
  configPath: string;
  configExists: boolean;
  tokenFile: string;
}

/** Start the loopback endpoint. Config and deps are read once at start; restart to pick up config edits. */
export async function serveRouterGateway(opts: { configPath?: string; port?: number; cfg?: AshlrConfig } = {}): Promise<ServeRouterGatewayResult> {
  const { loaded, deps } = await prepare(opts.configPath, opts.cfg);
  const tokenFile = routerGatewayTokenPath();
  const running = await startRouterGatewayServer({
    port: opts.port ?? loaded.config.port,
    token: ensureRouterGatewayToken(tokenFile),
    maxConcurrent: loaded.config.maxConcurrent,
    handlers: { complete: (req) => routedComplete(deps, req), models: () => listRouterModels(deps) },
  });
  return { running, configPath: loaded.path, configExists: loaded.exists, tokenFile };
}
