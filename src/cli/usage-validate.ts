import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { usageReadingV1Schema } from '../core/usage/usage-reading.js';

const MAX_INVALID_LINES = 100;

/** Validate JSONL without displaying paths, keys, values, or parser errors. */
export async function validateUsageFile(path: string, jsonMode = false): Promise<number> {
  let count = 0;
  let invalid = 0;
  const invalidLines: number[] = [];
  const pools = new Map<string, { validCount: number; newestFetchedAt: string }>();
  let status: 'complete' | 'empty' | 'unreadable' = 'complete';
  try {
    const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
    for await (const line of lines) {
      count++;
      try {
        const result = usageReadingV1Schema.safeParse(JSON.parse(line) as unknown);
        if (result.success) {
          const { pool, fetchedAt } = result.data;
          const previous = pools.get(pool);
          pools.set(pool, {
            validCount: (previous?.validCount ?? 0) + 1,
            newestFetchedAt: previous && previous.newestFetchedAt > fetchedAt ? previous.newestFetchedAt : fetchedAt,
          });
          continue;
        }
      } catch { /* A malformed line is reported without its contents. */ }
      invalid++;
      if (invalidLines.length < MAX_INVALID_LINES) invalidLines.push(count);
      if (!jsonMode) console.error(`Invalid usage reading at line ${count}.`);
    }
  } catch {
    status = 'unreadable';
  }
  if (status === 'complete' && count === 0) status = 'empty';
  if (jsonMode) {
    // A failed read may have yielded partial lines; do not present them as a complete report.
    if (status === 'unreadable') {
      count = 0;
      invalid = 0;
      invalidLines.length = 0;
      pools.clear();
    }
    console.log(JSON.stringify({
      schema: 'usage-validation-report.v1', status,
      total: count, valid: count - invalid, invalid,
      invalidLines, omittedInvalidLines: invalid - invalidLines.length,
      pools: [...pools].sort(([a], [b]) => a.localeCompare(b)).map(([pool, stats]) => ({ pool, ...stats })),
    }));
  } else if (status === 'unreadable') {
    console.error('Unable to read usage readings file.');
  } else if (status === 'empty') {
    console.error('Usage readings file is empty.');
  } else if (!invalid) {
    console.log(`Validated ${count} usage reading(s).`);
  }
  return status === 'complete' && invalid === 0 ? 0 : 1;
}
