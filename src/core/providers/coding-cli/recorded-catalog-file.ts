/**
 * Explicit recorded-catalog file reader.
 *
 * Recovered from PR #5952 (head 3d6c8fb7c7f7d52655fb3e0f13ef239686f7b886,
 * src/core/providers/coding-cli/catalog.ts, loadCatalog). Only the
 * explicit-path branch survives: there is no default path, no environment or
 * home lookup, and no compiled fallback inventory. Every failure propagates.
 *
 * The result is a recorded document, never live provider proof: rows keep
 * their recorded accountStatus and the envelope states `live: false`.
 */
import { readFile } from 'node:fs/promises';
import { parseCatalog, type CodingCliCatalog } from './catalog.js';

export interface RecordedCatalogProvenance {
  /** The catalog's own recorded `source` label. */
  source: string;
  /** The catalog's own recorded `observedAt` timestamp. */
  observedAt: string;
  /** Always false: reading a file observes nothing about a live account. */
  live: false;
}

export interface RecordedCatalogFile {
  /** The exact path the caller supplied. */
  path: string;
  catalog: CodingCliCatalog;
  provenance: RecordedCatalogProvenance;
}

/**
 * Read and parse one operator-supplied catalog file. Rejects a blank path,
 * a missing or unreadable file, and invalid JSON or catalog content.
 */
export async function readRecordedCatalogFile(path: string): Promise<RecordedCatalogFile> {
  if (typeof path !== 'string' || path.trim() === '') {
    throw new Error('recorded catalog file: an explicit non-empty path is required');
  }
  const catalog = parseCatalog(await readFile(path, 'utf8'));
  return { path, catalog, provenance: { source: catalog.source, observedAt: catalog.observedAt, live: false } };
}
