/**
 * rng.ts — deterministic random sources for the lane bandit.
 *
 * mulberry32: a small 32-bit seeded PRNG. It is NOT a security primitive —
 * it exists so a replay, a shadow log and a test can reproduce the exact
 * Thompson draws a router made. Production callers seed it from recorded
 * outcome ids; tests seed it with fixed integers.
 *
 * The Beta sampler is the standard two-Gamma construction (x/(x+y) with
 * x~Gamma(α), y~Gamma(β)); Gammas use Marsaglia–Tsang for shape ≥ 1 and the
 * α+1 identity for 0 < shape < 1. Draws stay in the open interval (0, 1):
 * a degenerate 0 or 1 sample would pin a posterior that a fractional update
 * can no longer move.
 */

/** A uniform source: each call returns a float in [0, 1). */
export type UniformSource = () => number;

/**
 * Deterministic mulberry32 stream. `seed` is coerced to uint32; any finite
 * number is accepted so callers can hash task ids into seeds without a
 * separate range check.
 */
export function mulberry32(seed: number): UniformSource {
  let state = (Number.isFinite(seed) ? Math.floor(seed) : 0) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box–Muller standard normal from a uniform source. */
export function standardNormal(uniform: UniformSource): number {
  // Guard the log: a 0 uniform would produce -Infinity.
  const u = Math.max(uniform(), Number.MIN_VALUE);
  const v = uniform();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Gamma(shape, 1) via Marsaglia–Tsang. For shape < 1 uses the identity
 * Gamma(α) = Gamma(α+1) · u^(1/α). Requires shape > 0.
 */
export function gamma(shape: number, uniform: UniformSource): number {
  if (!(shape > 0) || !Number.isFinite(shape)) throw new Error('gamma shape must be positive and finite');
  if (shape < 1) {
    return gamma(shape + 1, uniform) * Math.pow(Math.max(uniform(), Number.MIN_VALUE), 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    const x = standardNormal(uniform);
    const v = Math.pow(1 + c * x, 3);
    if (v <= 0) continue;
    const u = Math.max(uniform(), Number.MIN_VALUE);
    if (Math.log(u) < 0.5 * x * x + d - d * v + d * Math.log(v)) return d * v;
  }
}

/**
 * Beta(α, β) in the open interval (0, 1). A pathological draw that lands
 * exactly on an endpoint is nudged inside — a posterior massed at an endpoint
 * would make the arm permanently unchoosable (or unbeatably chosen).
 */
export function beta(alpha: number, betaParam: number, uniform: UniformSource): number {
  // A posterior can degenerate to a zero mass (all rewards 0, or all rewards
  // 1) — clamp rather than throw: Beta(a, ~0) correctly draws ~1.
  const x = gamma(Math.max(alpha, 1e-9), uniform);
  const y = gamma(Math.max(betaParam, 1e-9), uniform);
  const total = x + y;
  if (!(total > 0) || !Number.isFinite(total)) return 0.5;
  const value = x / total;
  if (value <= 0) return Number.EPSILON;
  if (value >= 1) return 1 - Number.EPSILON;
  return value;
}
