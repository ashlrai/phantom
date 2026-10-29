/** Offline oMLX settings planner. No host probes, credentials or process starts. */
const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

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

/**
 * Snapshot contract: headroomBytes is memguard's additional allocation allowance,
 * freeBytes is currently available RAM. Capture with oMLX stopped. Every model's
 * budget includes weights, draft weights, KV, scratch and process overhead.
 */
export function planOmlxConfig(input: unknown, now = Date.now()) {
  const request = object(input);
  if (typeof request.version !== 'string' || !/^(?:0\.(?:[7-9]|[1-9]\d+)\.\d+|[1-9]\d*\.\d+\.\d+)$/.test(request.version) ||
      (request.version.startsWith('0.7.') && Number(request.version.split('.')[2]) < 2)) {
    throw new Error('oMLX 0.7.2 or later stable version required');
  }
  const guard = object(request.memguard);
  const total = bytes(guard.totalBytes);
  const free = bytes(guard.freeBytes);
  const headroom = bytes(guard.headroomBytes);
  const captured = bytes(guard.capturedAtMs);
  if (!Number.isSafeInteger(now) || captured > now || now - captured > 30_000) throw new Error('Fresh memguard snapshot required');
  if (!total || free > total || headroom > total) throw new Error('Inconsistent memguard snapshot');
  const reserveBytes = Math.ceil(total * 0.30);
  const budgetBytes = Math.floor(Math.min(headroom, Math.max(0, free - reserveBytes)) / MIB) * MIB;
  if (!budgetBytes) throw new Error('No memory available while keeping 30% free');
  if (!Array.isArray(request.models) || !request.models.length) throw new Error('Models required');
  const models: Record<string, Record<string, unknown>> = Object.create(null) as Record<string, Record<string, unknown>>;
  let allocatedBytes = 0;
  let splashBytes = budgetBytes;
  let splashCount = 0;
  for (const raw of request.models) {
    const model = object(raw);
    if (typeof model.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(model.id) || Object.hasOwn(models, model.id)) {
      throw new Error('Unique model IDs required');
    }
    if (model.engine !== 'mlx' && model.engine !== 'splash') throw new Error('Model engine must be mlx or splash');
    if (model.longContext !== undefined && typeof model.longContext !== 'boolean') throw new Error('longContext must be boolean');
    const allocation = bytes(model.budgetBytes);
    if (!allocation || allocation % MIB) throw new Error('Model budgets must be positive whole MiB');
    if (allocation > budgetBytes - allocatedBytes) throw new Error('Concurrent models exceed memguard budget');
    allocatedBytes += allocation;
    const bits = model.longContext === true ? 4 : 8;
    if (model.engine === 'splash') {
      // oMLX 0.7.2 Splash accepts int8/bf16 only. Never silently ignore 4-bit.
      if (bits === 4) throw new Error('4-bit long-context jobs require the MLX engine');
      splashCount++;
      splashBytes = Math.min(splashBytes, allocation);
    }
    models[model.id] = {
      turboquant_kv_enabled: true,
      turboquant_kv_scheme: `affine${bits}`,
      turboquant_kv_bits: bits,
      external_engine: model.engine === 'splash' ? 'splash' : null,
    };
  }
  return {
    reserveBytes, budgetBytes, allocatedBytes,
    settings: {
      server: { host: '127.0.0.1', port: 8000 },
      memory: { prefill_memory_guard: true, memory_guard_tier: 'custom', memory_guard_custom_ceiling_gb: budgetBytes / GIB },
      integrations: { splash_kv_format: 'int8', splash_max_memory_gb: (splashCount ? splashBytes : budgetBytes) / GIB },
    },
    modelSettings: { version: 1, models },
  };
}
