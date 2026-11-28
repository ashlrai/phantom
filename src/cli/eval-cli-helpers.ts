/**
 * Shared CLI helpers for `phm eval *` handlers.
 * Keeps argv parsing, JSON artifact writes, and local-provider probing
 * consistent across eval subcommands.
 */
import type { AshlrConfig } from '../core/types.js';

export function isEvalHelpArgs(args: readonly string[]): boolean {
  return args.includes('--help') || args.includes('-h') || args[0] === 'help';
}

export interface StrictEvalFlagSpec<B extends string, V extends string> {
  booleans: Readonly<Record<string, B>>;
  values: Readonly<Record<string, V>>;
}

export interface StrictEvalFlagResult<B extends string, V extends string> {
  booleans: Record<B, boolean>;
  values: Partial<Record<V, string>>;
  usageError?: string;
}

/**
 * Parse strict single-occurrence `--flag` booleans and `--flag <value>` options.
 * Rejects repeated flags, missing/flag-like values, and unknown arguments.
 */
export function parseStrictEvalFlags<B extends string, V extends string>(
  args: readonly string[],
  spec: StrictEvalFlagSpec<B, V>,
): StrictEvalFlagResult<B, V> {
  const booleans = {} as Record<B, boolean>;
  for (const key of Object.values(spec.booleans) as B[]) booleans[key] = false;
  const values: Partial<Record<V, string>> = {};
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (seen.has(arg)) return { booleans, values, usageError: `repeated argument: ${arg}` };
    if (Object.hasOwn(spec.booleans, arg)) {
      booleans[spec.booleans[arg]!] = true;
      seen.add(arg);
      continue;
    }
    if (Object.hasOwn(spec.values, arg)) {
      const value = args[++i];
      if (value === undefined || value.startsWith('-')) {
        return { booleans, values, usageError: `${arg} requires a value` };
      }
      values[spec.values[arg]!] = value;
      seen.add(arg);
      continue;
    }
    return { booleans, values, usageError: `unknown argument: ${arg}` };
  }
  return { booleans, values };
}

/** Write formatted JSON to `targetPath`, reporting `errorMessage` on failure. */
export function writeEvalJsonOutput(
  writeFile: (filePath: string, text: string) => void,
  targetPath: string,
  value: unknown,
  err: (text: string) => void,
  errorMessage: string,
): boolean {
  try {
    writeFile(targetPath, `${JSON.stringify(value, null, 2)}\n`);
    return true;
  } catch {
    err(errorMessage);
    return false;
  }
}

/** Probe whether a local loopback model provider is reachable (no cloud fallback). */
export async function isLocalEvalProviderUp(config?: AshlrConfig): Promise<boolean> {
  try {
    const cfg = config ?? (await import('../core/config.js')).loadConfig();
    const { getActiveClient } = await import('../core/run/provider-client.js');
    await getActiveClient(cfg, { allowCloud: false });
    return true;
  } catch {
    return false;
  }
}
