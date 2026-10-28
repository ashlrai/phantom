/** Read and persist the index without loading repository scanners. */
import fs from 'node:fs';
import { INDEX_PATH, CONFIG_DIR } from './config.js';
import type { AshlrIndex } from './types.js';

/**
 * Load the index from INDEX_PATH.
 * Returns null if the file is absent, unreadable, or not valid JSON.
 */
export function loadIndex(): AshlrIndex | null {
  try {
    const raw = fs.readFileSync(INDEX_PATH, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    // Minimal shape validation: must have version + items array.
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('version' in parsed) ||
      !('items' in parsed) ||
      !Array.isArray((parsed as { items: unknown }).items)
    ) {
      return null;
    }
    return parsed as AshlrIndex;
  } catch {
    return null;
  }
}

/**
 * Persist the index to INDEX_PATH as pretty-printed JSON.
 * Creates CONFIG_DIR if it does not exist.
 */
export function writeIndex(index: AshlrIndex): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2), 'utf8');
}
