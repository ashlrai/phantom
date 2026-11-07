/** Offline oMLX settings planner. No host probes, credentials or process starts. */
const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

/** The stable line the default loopback lane stays on (0.7.2 or later stable). */
const STABLE_VERSION = /^(?:0\.(?:[7-9]|[1-9]\d+)\.\d+|[1-9]\d*\.\d+\.\d+)$/;
/** Only the 0.7.3 release-candidate line may canary; stable stays the default. */
const CANARY_VERSION = /^0\.7\.3rc[1-9]\d*$/;
const DEFAULT_PORT = 8000;
const CANARY_PORT = 8001;
/** The only provenance a canary may claim: Core cut, Security pin, Masbot install. */
const CANARY_PROVENANCE = Object.freeze({ cut: 'core', pin: 'security', install: 'masbot' });
const RETRY_THEN_REROUTE = 'retry-then-reroute';
const CANARY_EVAL = 'flint';
const CANARY_KEYS = new Set(['lane', 'version', 'port', 'provenance', 'incompleteToolCall', 'judge', 'eval']);
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

interface ModelPlan {
  turboquant_kv_enabled: boolean;
  turboquant_kv_scheme: string;
  turboquant_kv_bits: number;
  external_engine: 'splash' | null;
}

interface MemoryGuard {
  prefill_memory_guard: boolean;
  memory_guard_tier: 'custom';
  memory_guard_custom_ceiling_gb: number;
}

interface SplashIntegration {
  splash_kv_format: 'int8';
  splash_max_memory_gb: number;
}

export interface OmlxPlan {
  reserveBytes: number;
  budgetBytes: number;
  allocatedBytes: number;
  settings: {
    server: { host: '127.0.0.1'; port: number };
    memory: MemoryGuard;
    integrations: SplashIntegration;
  };
  modelSettings: { version: 1; models: Record<string, ModelPlan> };
  canary?: {
    lane: string;
    version: string;
    budgetBytes: number;
    provenance: { cut: string; pin: string; install: string };
    settings: {
      server: { host: '127.0.0.1'; port: number };
      memory: MemoryGuard;
      integrations?: SplashIntegration;
    };
    modelSettings: { version: 1; models: Record<string, ModelPlan> };
    policy: {
      on_incomplete_tool_call: typeof RETRY_THEN_REROUTE;
      judge: { cache_store: false; logprobs_confidence: true };
      eval: typeof CANARY_EVAL;
    };
  };
}

function bytes(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('Memory values must be nonnegative safe integer bytes');
  }
  return value;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object');
  return value as Record<string, unknown>;
}

function canarySpec(request: Record<string, unknown>): { lane: string; version: string; port: number } | null {
  if (request.canary === undefined) return null;
  const canary = object(request.canary);
  for (const key of Object.keys(canary)) {
    if (!CANARY_KEYS.has(key)) throw new Error('Unrecognized canary key');
  }
  if (typeof canary.lane !== 'string' || !MODEL_ID.test(canary.lane)) throw new Error('Canary lane must be a model id');
  if (typeof canary.version !== 'string' || !CANARY_VERSION.test(canary.version)) {
    throw new Error('Canary requires an oMLX 0.7.3 release candidate; stable stays the default');
  }
  let port = CANARY_PORT;
  if (canary.port !== undefined) {
    if (typeof canary.port !== 'number' || !Number.isSafeInteger(canary.port) ||
        canary.port < 1 || canary.port > 65535 || canary.port === DEFAULT_PORT) {
      throw new Error('Canary port must be a loopback port distinct from the default lane');
    }
    port = canary.port;
  }
  const provenance = object(canary.provenance);
  if (Object.keys(provenance).length !== 3 || provenance.cut !== CANARY_PROVENANCE.cut ||
      provenance.pin !== CANARY_PROVENANCE.pin || provenance.install !== CANARY_PROVENANCE.install) {
    throw new Error('Canary install is only via a Core cut, Security pin and Masbot');
  }
  if (canary.incompleteToolCall !== RETRY_THEN_REROUTE) {
    throw new Error('Canary requires retry-then-reroute for incomplete tool calls');
  }
  const judge = object(canary.judge);
  if (Object.keys(judge).length !== 2 || judge.cacheStore !== false || judge.logprobs !== true) {
    throw new Error('Canary judge requires cacheStore: false and logprobs: true');
  }
  if (canary.eval !== CANARY_EVAL) throw new Error('Canary requires rerunning the Flint eval');
  return { lane: canary.lane, version: canary.version, port };
}

/**
 * Snapshot contract: headroomBytes is memguard's additional allocation allowance,
 * freeBytes is currently available RAM. Capture with oMLX stopped. Every model's
 * budget includes weights, draft weights, KV, scratch and process overhead.
 * wiredLimitBytes is the live memguard wired limit; a canary must provide it,
 * and it tightens every ceiling when present.
 *
 * Canary: `canary` pins one named model lane to an oMLX 0.7.3 release candidate
 * on its own loopback port while the rest keep the stable default. It plans
 * only installs claimed through a Core cut, Security pin and Masbot, declares
 * the incomplete_tool_call retry-then-reroute policy, the judge with cache-store
 * off and logprobs confidence, and the required Flint eval rerun.
 */
export function planOmlxConfig(input: unknown, now = Date.now()): OmlxPlan {
  const request = object(input);
  if (typeof request.version !== 'string' || !STABLE_VERSION.test(request.version) ||
      (request.version.startsWith('0.7.') && Number(request.version.split('.')[2]) < 2)) {
    throw new Error('oMLX 0.7.2 or later stable version required');
  }
  const canary = canarySpec(request);
  const guard = object(request.memguard);
  const total = bytes(guard.totalBytes);
  const free = bytes(guard.freeBytes);
  const headroom = bytes(guard.headroomBytes);
  const captured = bytes(guard.capturedAtMs);
  if (!Number.isSafeInteger(now) || captured > now || now - captured > 30_000) throw new Error('Fresh memguard snapshot required');
  if (!total || free > total || headroom > total) throw new Error('Inconsistent memguard snapshot');
  const wired = guard.wiredLimitBytes === undefined ? null : bytes(guard.wiredLimitBytes);
  if (wired !== null && wired > total) throw new Error('Inconsistent memguard snapshot');
  if (canary !== null && wired === null) throw new Error('Canary requires a live memguard wired limit');
  const reserveBytes = Math.ceil(total * 0.30);
  const allowance = wired === null ? headroom : Math.min(headroom, wired);
  const budgetBytes = Math.floor(Math.min(allowance, Math.max(0, free - reserveBytes)) / MIB) * MIB;
  if (!budgetBytes) throw new Error('No memory available while keeping 30% free');
  if (!Array.isArray(request.models) || !request.models.length) throw new Error('Models required');
  const models: Record<string, ModelPlan> = Object.create(null) as Record<string, ModelPlan>;
  const canaryModels: Record<string, ModelPlan> = Object.create(null) as Record<string, ModelPlan>;
  let allocatedBytes = 0;
  let canaryAllocated = 0;
  let splashBytes = budgetBytes;
  let splashCount = 0;
  for (const raw of request.models) {
    const model = object(raw);
    if (typeof model.id !== 'string' || !MODEL_ID.test(model.id) ||
        Object.hasOwn(models, model.id) || Object.hasOwn(canaryModels, model.id)) {
      throw new Error('Unique model IDs required');
    }
    if (model.engine !== 'mlx' && model.engine !== 'splash') throw new Error('Model engine must be mlx or splash');
    if (model.longContext !== undefined && typeof model.longContext !== 'boolean') throw new Error('longContext must be boolean');
    const allocation = bytes(model.budgetBytes);
    if (!allocation || allocation % MIB) throw new Error('Model budgets must be positive whole MiB');
    if (allocation > budgetBytes - allocatedBytes) throw new Error('Concurrent models exceed memguard budget');
    allocatedBytes += allocation;
    const bits = model.longContext === true ? 4 : 8;
    const isCanary = model.id === canary?.lane;
    if (model.engine === 'splash') {
      // oMLX 0.7.2 Splash accepts int8/bf16 only. Never silently ignore 4-bit.
      if (bits === 4) throw new Error('4-bit long-context jobs require the MLX engine');
      if (!isCanary) {
        splashCount++;
        splashBytes = Math.min(splashBytes, allocation);
      }
    }
    const entry: ModelPlan = {
      turboquant_kv_enabled: true,
      turboquant_kv_scheme: `affine${bits}`,
      turboquant_kv_bits: bits,
      external_engine: model.engine === 'splash' ? 'splash' : null,
    };
    if (isCanary) {
      canaryAllocated += allocation;
      canaryModels[model.id] = entry;
    } else {
      models[model.id] = entry;
    }
  }
  if (canary !== null) {
    if (!Object.hasOwn(canaryModels, canary.lane)) throw new Error('Canary lane must be one planned model');
    if (allocatedBytes === canaryAllocated) throw new Error('The default lane keeps at least one model');
  }
  const defaultCeiling = budgetBytes - canaryAllocated;
  const plan: OmlxPlan = {
    reserveBytes, budgetBytes, allocatedBytes,
    settings: {
      server: { host: '127.0.0.1', port: DEFAULT_PORT },
      memory: { prefill_memory_guard: true, memory_guard_tier: 'custom', memory_guard_custom_ceiling_gb: defaultCeiling / GIB },
      integrations: { splash_kv_format: 'int8', splash_max_memory_gb: (splashCount ? splashBytes : defaultCeiling) / GIB },
    },
    modelSettings: { version: 1, models },
  };
  if (canary !== null) {
    plan.canary = {
      lane: canary.lane,
      version: canary.version,
      budgetBytes: canaryAllocated,
      provenance: { ...CANARY_PROVENANCE },
      settings: {
        server: { host: '127.0.0.1', port: canary.port },
        memory: { prefill_memory_guard: true, memory_guard_tier: 'custom', memory_guard_custom_ceiling_gb: canaryAllocated / GIB },
        ...(canaryModels[canary.lane]!.external_engine === 'splash'
          ? { integrations: { splash_kv_format: 'int8', splash_max_memory_gb: canaryAllocated / GIB } }
          : {}),
      },
      modelSettings: { version: 1, models: canaryModels },
      policy: {
        on_incomplete_tool_call: RETRY_THEN_REROUTE,
        judge: { cache_store: false, logprobs_confidence: true },
        eval: CANARY_EVAL,
      },
    };
  }
  return plan;
}
