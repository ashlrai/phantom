/** A pool utilization observation. Timestamps are Unix milliseconds. */
export interface BurnReading {
  timestampMs: number;
  pctUsed: number;
}

export interface BurnProjection {
  /** Estimated utilization increase in percentage points per millisecond. */
  ratePerMs: number;
  /** Estimated Unix timestamp in milliseconds at which utilization reaches 100%. */
  exhaustionTimeMs: number;
  /** Number of readings retained in the fit. */
  readingsUsed: number;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
}

/**
 * Fit a linear utilization trend and project when it reaches 100%.
 * Invalid readings are ignored. A median pairwise slope and median absolute
 * residual guard remove isolated outliers before ordinary least squares.
 * Returns null when there are fewer than two distinct times, the fitted rate
 * is not positive, or the projected time is not finite. The input is not changed.
 */
export function projectBurnExhaustion(readings: readonly BurnReading[]): BurnProjection | null {
  const valid = readings.filter((reading) => Number.isFinite(reading.timestampMs)
    && Number.isFinite(reading.pctUsed) && reading.pctUsed >= 0 && reading.pctUsed <= 100);
  if (valid.length < 2) return null;

  // Center times to avoid precision loss when fitting Unix timestamps.
  const origin = Math.min(...valid.map((reading) => reading.timestampMs));
  const points = valid.map((reading) => ({ x: reading.timestampMs - origin, y: reading.pctUsed }));
  const slopes: number[] = [];
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const dx = points[j]!.x - points[i]!.x;
      if (dx !== 0) slopes.push((points[j]!.y - points[i]!.y) / dx);
    }
  }
  if (slopes.length === 0) return null;

  const robustSlope = median(slopes);
  const intercept = median(points.map((point) => point.y - robustSlope * point.x));
  const residuals = points.map((point) => Math.abs(point.y - (intercept + robustSlope * point.x)));
  const mad = median(residuals);
  // A small floor accommodates measurement rounding when the median residual is zero.
  const threshold = Math.max(1, 3 * 1.4826 * mad);
  const retained = points.filter((_, index) => residuals[index]! <= threshold);
  if (retained.length < 2) return null;

  const meanX = retained.reduce((sum, point) => sum + point.x, 0) / retained.length;
  const meanY = retained.reduce((sum, point) => sum + point.y, 0) / retained.length;
  const variance = retained.reduce((sum, point) => sum + (point.x - meanX) ** 2, 0);
  if (variance === 0) return null;
  const ratePerMs = retained.reduce((sum, point) => sum + (point.x - meanX) * (point.y - meanY), 0) / variance;
  if (!(ratePerMs > 0) || !Number.isFinite(ratePerMs)) return null;
  const exhaustionTimeMs = origin + meanX + (100 - meanY) / ratePerMs;
  if (!Number.isFinite(exhaustionTimeMs)) return null;
  return { ratePerMs, exhaustionTimeMs, readingsUsed: retained.length };
}
