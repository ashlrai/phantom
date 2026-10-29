import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { usageReaderCommands, usageSignalReaders } from '../core/fabric/usage-signal-readers.js';
import { USAGE_EVENTS, USAGE_POOLS, writeUsageSignal, type UsageEvent, type UsagePool } from '../core/fabric/usage-signal-writer.js';

/** Separate bridge entrypoint: no daemon registration and no timer lifecycle. */
export async function runUsageSignal(argv: string[]): Promise<void> {
  let directory: string | undefined; let event: string | undefined; let readersPath: string | undefined;
  const pools: UsagePool[] = [];
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]; const value = argv[i + 1];
    if (!value) throw new Error('Missing usage signal option');
    if (flag === '--directory' && !directory) directory = value;
    else if (flag === '--event' && !event) event = value;
    else if (flag === '--readers' && !readersPath) readersPath = value;
    else if (flag === '--pool' && USAGE_POOLS.includes(value as UsagePool)) pools.push(value as UsagePool);
    else throw new Error('Invalid usage signal option');
  }
  if (!directory || !isAbsolute(directory) || !USAGE_EVENTS.includes(event as UsageEvent)) {
    throw new Error('Usage: --directory ABS_PATH --event dispatch-start|pr-merge|429|limit-message|manual-reading [--pool POOL] [--readers ABS_PATH]');
  }
  let commands = usageReaderCommands({});
  if (readersPath) {
    if (!isAbsolute(readersPath) || /(?:^|\/)\.codex(?:-2)?(?:\/|$)/.test(resolve(readersPath)) ||
      realpathSync(readersPath) !== resolve(readersPath)) {
      throw new Error('Reader configuration requires an operations path');
    }
    const fd = openSync(readersPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16_384 || (stat.mode & 0o777) !== 0o600 ||
        typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new Error('Unsafe reader configuration');
      const bytes = Buffer.alloc(stat.size); let offset = 0;
      while (offset < bytes.length) {
        const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
        if (count <= 0) throw new Error('Reader configuration changed');
        offset += count;
      }
      const after = fstatSync(fd);
      if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) {
        throw new Error('Reader configuration changed');
      }
      commands = usageReaderCommands(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    } finally { closeSync(fd); }
  }
  const result = await writeUsageSignal({ directory, event: event as UsageEvent,
    ...(pools.length ? { pools } : {}), readers: usageSignalReaders(commands) });
  console.log(JSON.stringify(result));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runUsageSignal(process.argv.slice(2)).catch(() => {
    console.error('Usage signal failed; check event, private store and reader configuration');
    process.exitCode = 1;
  });
}
