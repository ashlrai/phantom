import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { projectSkillRoutingCalibrationSnapshot } from '../src/core/fleet/skill-routing-calibration-snapshot.js';

// Run: npx tsx examples/skill-calibration-export.ts --source FILE --key-file FILE
// The source must be the projector's canonical UTF-8 JSON, with no whitespace or
// trailing newline. Its schema and canonical property order are defined by
// skill-routing-calibration-snapshot.ts. The key file contains exactly 32 raw
// bytes; use the same separately managed key to compare exports. The projection
// retains sourceRevision, policy versions, timestamps and counts, so keep those
// metadata fields free of private content. This example never generates a key.
const MAX_SOURCE_BYTES = 5 * 1024 * 1024;
const KEY_BYTES = 32;
const USAGE = 'Usage: npx tsx examples/skill-calibration-export.ts --source FILE --key-file FILE\n';

// Read at most one byte over the limit so the projector can reject oversized
// inputs, even if a file grows while being read. Never block on a FIFO.
function readBounded(path: string, limit: number): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  const bytes = Buffer.alloc(limit + 1);
  try {
    if (!fstatSync(fd).isFile()) throw new Error('not a regular file');
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, null);
      if (count === 0) break;
      offset += count;
    }
    return bytes.subarray(0, offset);
  } catch {
    bytes.fill(0);
    throw new Error('unreadable');
  } finally {
    closeSync(fd);
  }
}

/** Return a process exit code; importing this module performs no I/O. */
export function main(args: string[]): number {
  if (args.length !== 4 || !['--source', '--key-file'].includes(args[0] ?? '') ||
    !['--source', '--key-file'].includes(args[2] ?? '') || args[0] === args[2] ||
    !args[1] || args[1].startsWith('--') || !args[3] || args[3].startsWith('--')) {
    process.stderr.write(USAGE);
    return 2;
  }
  const sourcePath = args[0] === '--source' ? args[1] : args[3];
  const keyPath = args[0] === '--key-file' ? args[1] : args[3];
  let source: Buffer | undefined;
  let key: Buffer | undefined;
  try {
    source = readBounded(sourcePath, MAX_SOURCE_BYTES);
    key = readBounded(keyPath, KEY_BYTES);
    const projection = projectSkillRoutingCalibrationSnapshot(source, key);
    process.stdout.write(`${JSON.stringify(projection)}\n`);
    return projection.state === 'projected' ? 0 : 1;
  } catch {
    process.stderr.write('Unable to read the selected source or key file.\n');
    return 1;
  } finally {
    source?.fill(0);
    key?.fill(0);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
