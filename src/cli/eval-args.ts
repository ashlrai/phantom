/** Shared CLI help and single-occurrence flag parsing for `phm eval <subverb>`. */

export function isEvalHelpRequest(args: readonly string[]): boolean {
  return args.includes('--help') || args.includes('-h') || args[0] === 'help';
}

export interface EvalCliFlagsSpec<TBoolean extends string, TValue extends string> {
  booleans: Readonly<Record<string, TBoolean>>;
  values: Readonly<Record<string, TValue>>;
}

export interface EvalCliFlagsResult<TBoolean extends string, TValue extends string> {
  booleans: Record<TBoolean, boolean>;
  values: Partial<Record<TValue, string>>;
  usageError?: string;
}

export function parseEvalCliFlags<TBoolean extends string, TValue extends string>(
  args: readonly string[],
  spec: EvalCliFlagsSpec<TBoolean, TValue>,
): EvalCliFlagsResult<TBoolean, TValue> {
  const booleans = {} as Record<TBoolean, boolean>;
  for (const key of Object.values(spec.booleans) as TBoolean[]) {
    booleans[key] = false;
  }
  const values: Partial<Record<TValue, string>> = {};
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (seen.has(arg)) {
      return { booleans, values, usageError: `repeated argument: ${arg}` };
    }
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
