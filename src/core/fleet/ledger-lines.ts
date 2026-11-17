import { createReadStream } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { createInterface } from 'node:readline';

export type YieldLineReader = (path: string, onLine: (line: string) => void) => Promise<boolean>;
/** A failed read invalidates the entire measurement, including any lines already delivered. */
export const readLedgerLines: YieldLineReader = async (path, onLine) => {
  try {
    if (!(await lstat(path)).isFile()) return false;
    const lines = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of lines) onLine(line);
    return true;
  } catch { return false; }
};
