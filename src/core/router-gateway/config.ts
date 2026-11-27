/** The router gateway's one versioned config file: routing config as code.
 * It names which lanes `auto` may use, model aliases, the loopback port and
 * attempt limits. It holds no host (the listener is always 127.0.0.1), no
 * credentials and no provider URLs: provider auth stays in each lane's own
 * CLI or keychain. Unknown keys are refused so a typo never silently widens
 * routing. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ashlrHome } from '../cloud/store.js';
import type { RoutingDifficulty, RoutingTask } from '../routing/types.js';

const ROUTER_GATEWAY_CONFIG_VERSION = 1;
const ROUTER_GATEWAY_DEFAULT_PORT = 18741;
/** Engines the gateway has a completion adapter for. Devin cloud sessions are their own lane. */
export const ROUTER_GATEWAY_ENGINES = ['claude', 'codex', 'grok', 'local'] as const;
export type RouterGatewayEngine = typeof ROUTER_GATEWAY_ENGINES[number];

export const ROUTER_GATEWAY_TASKS: readonly RoutingTask[] = ['code', 'review', 'plan', 'bulk', 'leader'];
export const ROUTER_GATEWAY_DIFFICULTIES: readonly RoutingDifficulty[] = ['low', 'medium', 'high'];
const MAX_FILE_BYTES = 64 * 1024;
const MAX_ALIASES = 64;
/** A lane is a seat id (`codex-personal`) or an engine name (`claude`); local seats are `local:<tag>`. */
const LANE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const ALIAS = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;

export interface RouterGatewayAlias {
  /** `auto` or `<lane>:<model>`. */
  route: string;
  task?: RoutingTask;
  difficulty?: RoutingDifficulty;
}

export interface RouterGatewayConfig {
  version: 1;
  /** Loopback TCP port; the host is never configurable. */
  port: number;
  defaults: { task: RoutingTask; difficulty: RoutingDifficulty };
  /** Lanes `auto` may pick from: engine names or seat ids. Explicit `<lane>:<model>` pins must also be listed. */
  lanes: string[];
  models: Record<string, RouterGatewayAlias>;
  /** Ranked seats tried before giving up (a failed call falls through to the next). */
  maxAttempts: number;
  /** Per-attempt wall-clock limit. */
  timeoutMs: number;
  /** Requests served at once; more get HTTP 429. */
  maxConcurrent: number;
}

class RouterGatewayConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RouterGatewayConfigError';
  }
}

function fail(message: string): never {
  throw new RouterGatewayConfigError(message);
}

export function isRouterGatewayRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 4-chars-per-token estimate shared by routing context checks and gateway usage reporting. */
export const estimateRouterTokens = (chars: number): number => Math.ceil(chars / 4);

function onlyKeys(value: Record<string, unknown>, keys: readonly string[], where: string): void {
  const extra = Object.keys(value).filter((key) => !keys.includes(key));
  if (extra.length > 0) fail(`${where} has unknown key "${extra[0]}"`);
}

function parseTask(raw: unknown, where: string): RoutingTask {
  if (!ROUTER_GATEWAY_TASKS.includes(raw as RoutingTask)) fail(`${where} must be one of ${ROUTER_GATEWAY_TASKS.join(', ')}`);
  return raw as RoutingTask;
}

function parseDifficulty(raw: unknown, where: string): RoutingDifficulty {
  if (!ROUTER_GATEWAY_DIFFICULTIES.includes(raw as RoutingDifficulty)) {
    fail(`${where} must be one of ${ROUTER_GATEWAY_DIFFICULTIES.join(', ')}`);
  }
  return raw as RoutingDifficulty;
}

function intIn(value: unknown, min: number, max: number, where: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    fail(`${where} must be a whole number from ${min} to ${max}`);
  }
  return value;
}

export function defaultRouterGatewayConfig(): RouterGatewayConfig {
  return {
    version: 1,
    port: ROUTER_GATEWAY_DEFAULT_PORT,
    defaults: { task: 'code', difficulty: 'medium' },
    lanes: [...ROUTER_GATEWAY_ENGINES],
    models: {},
    maxAttempts: 2,
    timeoutMs: 10 * 60_000,
    maxConcurrent: 4,
  };
}

/** A model string is `auto` or `<lane>:<model>`; the first colon splits, so `local:qwen3:8b` works. */
export type RouterModelSpec = { kind: 'auto' } | { kind: 'pin'; lane: string; model: string };

export function parseRouterModelSpec(value: string): RouterModelSpec | null {
  if (value === 'auto') return { kind: 'auto' };
  const at = value.indexOf(':');
  if (at <= 0) return null;
  const lane = value.slice(0, at);
  const model = value.slice(at + 1);
  return LANE.test(lane) && MODEL.test(model) ? { kind: 'pin', lane, model } : null;
}

/** True when `phm run --model <value>` means a routed call rather than a local model tag. */
export function isRouterModelFlag(value: string): boolean {
  if (value === 'auto') return true;
  const spec = parseRouterModelSpec(value);
  if (!spec || spec.kind !== 'pin') return false;
  // `qwen3:8b` stays a plain local tag; only lanes named after a gateway engine route.
  return ROUTER_GATEWAY_ENGINES.some((engine) => spec.lane === engine || spec.lane.startsWith(`${engine}-`));
}

function aliasOf(raw: unknown, where: string): RouterGatewayAlias {
  if (!isRouterGatewayRecord(raw)) fail(`${where} must be an object`);
  onlyKeys(raw, ['route', 'task', 'difficulty'], where);
  const route = raw['route'];
  if (typeof route !== 'string' || parseRouterModelSpec(route) === null) fail(`${where}.route must be "auto" or "<lane>:<model>"`);
  const alias: RouterGatewayAlias = { route };
  if (raw['task'] !== undefined) alias.task = parseTask(raw['task'], `${where}.task`);
  if (raw['difficulty'] !== undefined) alias.difficulty = parseDifficulty(raw['difficulty'], `${where}.difficulty`);
  return alias;
}

/** Parse the file's text. Absent optional keys take their defaults; anything else malformed throws one readable line. */
export function parseRouterGatewayConfig(text: string): RouterGatewayConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail('router config is not valid JSON');
  }
  if (!isRouterGatewayRecord(parsed)) fail('router config must be an object');
  onlyKeys(parsed, ['version', 'port', 'defaults', 'lanes', 'models', 'maxAttempts', 'timeoutMs', 'maxConcurrent'], 'router config');
  if (parsed['version'] !== ROUTER_GATEWAY_CONFIG_VERSION) fail(`router config needs "version": ${ROUTER_GATEWAY_CONFIG_VERSION}`);
  const config = defaultRouterGatewayConfig();
  if (parsed['port'] !== undefined) config.port = intIn(parsed['port'], 1024, 65535, 'port');
  if (parsed['defaults'] !== undefined) {
    const defaults = parsed['defaults'];
    if (!isRouterGatewayRecord(defaults)) fail('defaults must be an object');
    onlyKeys(defaults, ['task', 'difficulty'], 'defaults');
    if (defaults['task'] !== undefined) config.defaults.task = parseTask(defaults['task'], 'defaults.task');
    if (defaults['difficulty'] !== undefined) config.defaults.difficulty = parseDifficulty(defaults['difficulty'], 'defaults.difficulty');
  }
  if (parsed['lanes'] !== undefined) {
    const lanes = parsed['lanes'];
    if (!Array.isArray(lanes) || lanes.length > 64 || lanes.some((lane) => typeof lane !== 'string' || !LANE.test(lane))) {
      fail('lanes must be a list of engine names or seat ids');
    }
    config.lanes = [...new Set(lanes as string[])];
  }
  if (parsed['models'] !== undefined) {
    const models = parsed['models'];
    if (!isRouterGatewayRecord(models)) fail('models must be an object of alias → { route }');
    const names = Object.keys(models);
    if (names.length > MAX_ALIASES) fail(`models lists more than ${MAX_ALIASES} aliases`);
    for (const name of names) {
      if (!ALIAS.test(name) || name === 'auto') fail(`models alias "${name.slice(0, 64)}" must be a plain name other than "auto"`);
      config.models[name] = aliasOf(models[name], `models.${name}`);
    }
  }
  if (parsed['maxAttempts'] !== undefined) config.maxAttempts = intIn(parsed['maxAttempts'], 1, 5, 'maxAttempts');
  if (parsed['timeoutMs'] !== undefined) config.timeoutMs = intIn(parsed['timeoutMs'], 5_000, 60 * 60_000, 'timeoutMs');
  if (parsed['maxConcurrent'] !== undefined) config.maxConcurrent = intIn(parsed['maxConcurrent'], 1, 32, 'maxConcurrent');
  return config;
}

export function routerGatewayDir(): string {
  return join(ashlrHome(), 'router');
}

export function routerGatewayConfigPath(): string {
  return join(routerGatewayDir(), 'gateway.json');
}

export interface LoadedRouterGatewayConfig {
  path: string;
  /** false = the file is absent and defaults apply. */
  exists: boolean;
  config: RouterGatewayConfig;
}

/** Read the config at `path` (default: ~/.ashlr/router/gateway.json). Absent = defaults; malformed throws. */
export function loadRouterGatewayConfig(path = routerGatewayConfigPath()): LoadedRouterGatewayConfig {
  if (!existsSync(path)) return { path, exists: false, config: defaultRouterGatewayConfig() };
  const text = readFileSync(path, 'utf8');
  if (Buffer.byteLength(text) > MAX_FILE_BYTES) fail(`router config is larger than ${MAX_FILE_BYTES} bytes`);
  return { path, exists: true, config: parseRouterGatewayConfig(text) };
}

/** Write the default config when none exists. Never overwrites. Returns whether it wrote. */
export function initRouterGatewayConfig(path = routerGatewayConfigPath()): boolean {
  if (existsSync(path)) return false;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(defaultRouterGatewayConfig(), null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  return true;
}
