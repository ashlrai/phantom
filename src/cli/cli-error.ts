import { makeColors } from './ui.js';

/** Shared by the full dispatcher and the installed status fast path. */
export function failCliCommand(err: unknown): never {
  const msg = err instanceof Error ? err.message : String(err);
  const detail = msg.includes('not implemented')
    ? `Module not yet implemented: ${msg}\nThis command depends on a core module that hasn't been built yet.`
    : msg;
  console.error(makeColors(true).red('error: ') + detail);
  process.exit(1);
}
