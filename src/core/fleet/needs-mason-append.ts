import { mkdirSync, openSync, constants, fstatSync, readSync, writeSync, closeSync } from 'node:fs';
import { join } from 'node:path';

/** Appends one open `- [ ]` item to NEEDS-MASON.md, the same file the glance and resolve paths read. */
export function appendNeedsMasonLine(runsDir: string, text: string): void {
  mkdirSync(runsDir, { recursive: true });
  const fd = openSync(join(runsDir, 'NEEDS-MASON.md'), constants.O_RDWR | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
  try {
    const size = fstatSync(fd).size;
    let lead = '';
    if (size > 0) {
      const last = Buffer.alloc(1);
      readSync(fd, last, 0, 1, size - 1);
      if (last[0] !== 0x0a) lead = '\n';
    }
    writeSync(fd, `${lead}- [ ] ${text}\n`);
  } finally { closeSync(fd); }
}

