/** Bounded production history reads. */

import type {
  ReadDispatchProductionEventsOptions,
  DispatchProductionEventsReadResult,
  DispatchProductionEvent,
} from './types.js';
import {
  boundedReadOption,
  dispatchProductionDir,
  emptyDispatchProductionRead,
  safeDispatchProductionDirectory,
  pushStopReason,
  readDispatchProductionFileTail,
  recordDispatchProductionInvalidReason,
  sameFile,
} from './storage.js';
import {
  DEFAULT_READ_LIMIT,
  DEFAULT_READ_MAX_FILES,
  HARD_READ_MAX_FILES,
  DEFAULT_READ_MAX_BYTES,
  HARD_READ_MAX_BYTES,
  DEFAULT_READ_MAX_ROWS,
  HARD_READ_MAX_ROWS,
  MAX_DIRECTORY_ENTRIES,
  DATE_LEDGER_FILE_RE,
  MAX_LOOSE_FILES,
  MAX_READ_ROW_BYTES,
} from './constants.js';
import { existsSync, lstatSync, opendirSync } from 'node:fs';
import { join } from 'node:path';
import {
  isDispatchProductionEvent,
  dispatchProductionSuppliedEnvelopeSemanticsAgree,
  sanitizeDispatchProductionEvent,
} from './events.js';
import { withLearningLabelOrigin } from './attempt-proofs.js';
import { mergeTreatmentOutcomeReceipts } from './treatment-receipts.js';

export function readDispatchProductionEventsDetailed(
  opts: ReadDispatchProductionEventsOptions = {},
): DispatchProductionEventsReadResult {
  const cap = boundedReadOption(opts.limit, DEFAULT_READ_LIMIT, DEFAULT_READ_LIMIT);
  const maxFiles = boundedReadOption(opts.maxFiles, DEFAULT_READ_MAX_FILES, HARD_READ_MAX_FILES);
  const maxBytes = boundedReadOption(opts.maxBytes, DEFAULT_READ_MAX_BYTES, HARD_READ_MAX_BYTES);
  const maxRows = boundedReadOption(opts.maxRows, DEFAULT_READ_MAX_ROWS, HARD_READ_MAX_ROWS);
  const dir = dispatchProductionDir();
  if (!existsSync(dir)) return emptyDispatchProductionRead('missing');

  let files: string[];
  let directorySnapshot: ReturnType<typeof lstatSync>;
  try {
    directorySnapshot = lstatSync(dir);
    if (!safeDispatchProductionDirectory(directorySnapshot)) throw new Error('unsafe dispatch production directory');
    const selected: string[] = [];
    const handle = opendirSync(dir);
    try {
      let seen = 0;
      let entry = handle.readSync();
      while (entry !== null) {
        seen++;
        if (seen > MAX_DIRECTORY_ENTRIES) {
          return emptyDispatchProductionRead('degraded', {
            sourcePresent: true, complete: false, stopReasons: ['file-limit'],
          });
        }
        if (entry.name.endsWith('.jsonl')) selected.push(entry.name);
        entry = handle.readSync();
      }
    } finally {
      handle.closeSync();
    }
    files = selected.sort((left, right) => {
        const leftDated = DATE_LEDGER_FILE_RE.test(left);
        const rightDated = DATE_LEDGER_FILE_RE.test(right);
        if (leftDated !== rightDated) return leftDated ? -1 : 1;
        return right.localeCompare(left);
      });
  } catch {
    return emptyDispatchProductionRead('degraded', {
      complete: false,
      stopReasons: ['io-error'],
      unreadableFiles: 1,
    });
  }
  const result = emptyDispatchProductionRead('healthy');
  result.sourcePresent = true;
  let stopTraversal = false;
  for (const file of files) {
    if (stopTraversal) break;
    if (opts.sinceMs !== undefined && !fileMayContainSince(file, opts.sinceMs)) continue;
    if (result.rowsScanned >= maxRows) {
      pushStopReason(result.stopReasons, 'row-limit');
      result.complete = false;
      break;
    }
    const isDatedFile = DATE_LEDGER_FILE_RE.test(file);
    if (isDatedFile) {
      if (result.datedFilesRead >= maxFiles) {
        pushStopReason(result.stopReasons, 'file-limit');
        result.complete = false;
        continue;
      }
      result.datedFilesRead++;
    } else {
      if (result.looseFilesRead >= MAX_LOOSE_FILES) {
        pushStopReason(result.stopReasons, 'file-limit');
        result.complete = false;
        continue;
      }
      result.looseFilesRead++;
    }

    const remainingBytes = maxBytes - result.bytesRead;
    if (remainingBytes <= 0) {
      pushStopReason(result.stopReasons, 'byte-limit');
      result.complete = false;
      break;
    }
    const loaded = readDispatchProductionFileTail(join(dir, file), remainingBytes);
    result.filesRead++;
    if (!loaded) {
      result.unreadableFiles++;
      pushStopReason(result.stopReasons, 'io-error');
      result.complete = false;
      break;
    }
    result.bytesRead += loaded.bytesRead;
    if (loaded.truncated) {
      pushStopReason(result.stopReasons, 'byte-limit');
      result.complete = false;
      stopTraversal = true;
    }

    let cursor = loaded.text.length;
    let trailingSeparator = true;
    while (cursor > 0) {
      if (result.rowsScanned >= maxRows) {
        pushStopReason(result.stopReasons, 'row-limit');
        result.complete = false;
        stopTraversal = true;
        break;
      }
      const newline = loaded.text.lastIndexOf('\n', cursor - 1);
      const line = loaded.text.slice(newline + 1, cursor);
      cursor = newline >= 0 ? newline : 0;
      if (trailingSeparator && line === '') {
        trailingSeparator = false;
        continue;
      }
      trailingSeparator = false;
      result.rowsScanned++;
      if (!line.trim()) continue;
      if (Buffer.byteLength(line, 'utf8') > MAX_READ_ROW_BYTES) {
        recordDispatchProductionInvalidReason(result, 'row-too-large');
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        recordDispatchProductionInvalidReason(result, 'json-invalid');
        continue;
      }
      if (!isDispatchProductionEvent(parsed)) {
        recordDispatchProductionInvalidReason(result, 'schema-invalid');
        continue;
      }
      if (!dispatchProductionSuppliedEnvelopeSemanticsAgree(parsed)) {
        recordDispatchProductionInvalidReason(result, 'envelope-mismatch');
        continue;
      }
      const eventMs = Date.parse(parsed.ts);
      if (!Number.isFinite(eventMs) || opts.canonicalTimestamps === true && new Date(eventMs).toISOString() !== parsed.ts) {
        recordDispatchProductionInvalidReason(result, 'timestamp-invalid');
        continue;
      }
      try {
        if (opts.sinceMs !== undefined && eventMs < opts.sinceMs) continue;
        if (result.events.length >= cap) {
          pushStopReason(result.stopReasons, 'event-limit');
          result.complete = false;
          stopTraversal = true;
          break;
        }
        result.events.push(withLearningLabelOrigin(sanitizeDispatchProductionEvent(parsed, {
          deriveLegacyRunOutcomeCausal: true,
          materializeLearningLabel: true,
          preserveMissingCausalAuthority: true,
        }), parsed.learningLabel, parsed));
      } catch {
        recordDispatchProductionInvalidReason(result, 'normalization-failed');
      }
    }
  }
  if (result.invalidRows > 0 || result.unreadableFiles > 0) result.complete = false;
  mergeTreatmentOutcomeReceipts(result, opts, cap, maxBytes, maxRows);
  if (result.invalidRows > 0 || result.unreadableFiles > 0 || !result.complete) {
    result.sourceState = 'degraded';
  }
  try {
    const directoryAfter = lstatSync(dir);
    if (!safeDispatchProductionDirectory(directoryAfter) || !sameFile(directorySnapshot, directoryAfter) ||
      directorySnapshot.mtimeMs !== directoryAfter.mtimeMs || directorySnapshot.ctimeMs !== directoryAfter.ctimeMs) {
      pushStopReason(result.stopReasons, 'io-error');
      result.unreadableFiles++;
      result.complete = false;
      result.sourceState = 'degraded';
    }
  } catch {
    pushStopReason(result.stopReasons, 'io-error');
    result.unreadableFiles++;
    result.complete = false;
    result.sourceState = 'degraded';
  }
  return result;
}

export function readDispatchProductionEvents(
  opts?: ReadDispatchProductionEventsOptions,
): DispatchProductionEvent[] {
  return readDispatchProductionEventsDetailed(opts).events;
}

function fileMayContainSince(file: string, sinceMs: number): boolean {
  const match = DATE_LEDGER_FILE_RE.exec(file);
  if (!match) return true;
  const endOfDayMs = Date.parse(`${match[1]}T23:59:59.999Z`);
  return !Number.isFinite(endOfDayMs) || endOfDayMs >= sinceMs;
}
