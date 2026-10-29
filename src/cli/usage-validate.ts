import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { usageReadingV1Schema } from '../core/usage/usage-reading.js';

/** Validate JSONL without displaying paths, keys, values, or parser errors. */
export async function validateUsageFile(path: string): Promise<number> {
  let count = 0;
  let invalid = 0;
  try {
    const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
    for await (const line of lines) {
      count++;
      try {
        if (usageReadingV1Schema.safeParse(JSON.parse(line) as unknown).success) continue;
      } catch { /* A malformed line is reported without its contents. */ }
      invalid++;
      console.error(`Invalid usage reading at line ${count}.`);
    }
  } catch {
    console.error('Unable to read usage readings file.');
    return 1;
  }
  if (count === 0) {
    console.error('Usage readings file is empty.');
    return 1;
  }
  if (invalid) return 1;
  console.log(`Validated ${count} usage reading(s).`);
  return 0;
}
