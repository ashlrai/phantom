/** Shared flag-parsing and help helpers for `phm eval <subcommand>` dispatchers. */

export function isEvalHelpRequest(args: readonly string[]): boolean {
  return args.includes('--help') || args.includes('-h') || args[0] === 'help';
}

export interface StrictEvalFlagSpec {
  booleans?: readonly string[];
  values?: readonly string[];
  repeatable?: readonly string[];
}

export interface StrictEvalFlagsResult {
  flags: Set<string>;
  values: Map<string, string>;
  repeated: Map<string, string[]>;
  usageError?: string;
}

/**
 * Parse a strict set of `--flag` booleans, single-use `--key value` options,
 * and repeatable `--key value` options. Rejects unknown flags, repeated
 * single-use flags, and missing/flag-like values with canonical usage errors.
 */
export function parseStrictEvalFlags(
  args: readonly string[],
  spec: StrictEvalFlagSpec,
): StrictEvalFlagsResult {
  const booleans = new Set(spec.booleans ?? []);
  const values = new Set(spec.values ?? []);
  const repeatable = new Set(spec.repeatable ?? []);
  const seen = new Set<string>();
  const result: StrictEvalFlagsResult = {
    flags: new Set(),
    values: new Map(),
    repeated: new Map(),
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const isRepeatable = repeatable.has(arg);
    if (!isRepeatable && seen.has(arg)) {
      result.usageError = `repeated argument: ${arg}`;
      return result;
    }
    if (booleans.has(arg)) {
      result.flags.add(arg);
      seen.add(arg);
      continue;
    }
    if (values.has(arg) || isRepeatable) {
      const value = args[++i];
      if (value === undefined || value.startsWith('-')) {
        result.usageError = `${arg} requires a value`;
        return result;
      }
      if (isRepeatable) {
        const list = result.repeated.get(arg) ?? [];
        list.push(value);
        result.repeated.set(arg, list);
      } else {
        result.values.set(arg, value);
        seen.add(arg);
      }
      continue;
    }
    result.usageError = `unknown argument: ${arg}`;
    return result;
  }
  return result;
}
