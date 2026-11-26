/** Shared strict CLI flag and help parsing helpers for `phm eval` subcommands. */

export function isEvalHelpArgs(args: readonly string[]): boolean {
  return args.includes('--help') || args.includes('-h') || args[0] === 'help';
}

export interface StrictEvalFlagsSpec<TBool extends string, TValue extends string> {
  booleans: readonly TBool[];
  values: readonly TValue[];
}

export interface StrictEvalFlagsResult<TBool extends string, TValue extends string> {
  booleans: Record<TBool, boolean>;
  values: Partial<Record<TValue, string>>;
  usageError?: string;
}

/**
 * Parse unique boolean flags and value flags (`--flag value`) in strict mode:
 * rejects repeated arguments, missing or dash-prefixed values, and unknown
 * arguments with canonical usage messages.
 */
export function parseStrictEvalFlags<TBool extends string, TValue extends string>(
  args: readonly string[],
  spec: StrictEvalFlagsSpec<TBool, TValue>,
): StrictEvalFlagsResult<TBool, TValue> {
  const boolSet = new Set<string>(spec.booleans);
  const valueSet = new Set<string>(spec.values);
  const booleans = Object.fromEntries(spec.booleans.map((flag) => [flag, false])) as Record<TBool, boolean>;
  const values: Partial<Record<TValue, string>> = {};
  const seen = new Set<string>();

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (seen.has(arg)) {
      return { booleans, values, usageError: `repeated argument: ${arg}` };
    }
    if (boolSet.has(arg)) {
      booleans[arg as TBool] = true;
      seen.add(arg);
      continue;
    }
    if (valueSet.has(arg)) {
      const value = args[++i];
      if (value === undefined || value.startsWith('-')) {
        return { booleans, values, usageError: `${arg} requires a value` };
      }
      values[arg as TValue] = value;
      seen.add(arg);
      continue;
    }
    return { booleans, values, usageError: `unknown argument: ${arg}` };
  }
  return { booleans, values };
}
