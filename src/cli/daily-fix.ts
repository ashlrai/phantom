import {
  validateDispatchInputs,
  buildFilterConfig,
  activeJobs,
  shouldRunJob,
  vitestFilterArgs,
  buildDispatchCommand,
  parseFixupLine,
  aggregateFixupLines,
  ALLOWED_JOBS,
  INFRA_JOBS,
} from '../core/ci-fix-filter.js';

const HELP = `Usage: phm daily-fix <subcommand> [options]

Filter and validate daily CI workflow_dispatch inputs for targeted re-runs.

Subcommands:
  validate        Validate dispatch inputs against allowlist (Security R7)
  filter          Show which jobs/tests would run for given inputs
  dispatch        Generate a gh workflow run command
  parse-fixup     Parse fixup-queue output lines and extract dispatch inputs

Options (all subcommands unless noted):
  --jobs <names>  Comma-separated job names (ci,site,docs,mac-general,…)
  --tests <pat>   Vitest -t filter pattern (from fixup line)
  --mac-shard <s> Mac shard: 0-6 or "all"
  --json          Emit machine-readable JSON output

Examples:
  # Validate inputs from a fixup line
  phm daily-fix validate --jobs ci,mac-general --tests "resource engineering"

  # Show which jobs would run
  phm daily-fix filter --jobs ci

  # Generate the gh command for redispatch
  phm daily-fix dispatch --jobs ci,mac-general --mac-shard 2

  # Parse fixup queue output and generate dispatch inputs
  phm daily-fix parse-fixup --json < fixup-queue.txt

Security: inputs are validated against allowlist regex and never interpolated
into shell run: blocks. Passed via env vars (CI_ONLY_JOBS, CI_ONLY_TESTS).`;

interface ParsedArgs {
  jobs?: string;
  tests?: string;
  macShard?: string;
  json?: boolean;
}

function parseArgs(args: string[]): ParsedArgs {
  const result: ParsedArgs = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--jobs' && i + 1 < args.length) result.jobs = args[++i];
    else if (arg === '--tests' && i + 1 < args.length) result.tests = args[++i];
    else if (arg === '--mac-shard' && i + 1 < args.length) result.macShard = args[++i];
    else if (arg === '--json') result.json = true;
    else if (arg === '--help' || arg === '-h') return { ...result, json: false };
  }
  return result;
}

function cmdValidate(args: string[]): number {
  const opts = parseArgs(args);
  if (opts.json === false && (!opts.jobs && !opts.tests && !opts.macShard)) {
    console.error('daily-fix validate: requires --jobs, --tests, and/or --mac-shard');
    return 2;
  }

  try {
    const inputs = {
      onlyJobs: opts.jobs,
      onlyTests: opts.tests,
      macShard: opts.macShard,
    };
    validateDispatchInputs(inputs);

    if (opts.json) {
      console.log(JSON.stringify({ valid: true, inputs }));
    } else {
      console.log('daily-fix validate: inputs valid');
      if (opts.jobs) console.log(`  jobs: ${opts.jobs}`);
      if (opts.tests) console.log(`  tests: ${opts.tests}`);
      if (opts.macShard) console.log(`  mac_shard: ${opts.macShard}`);
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'validation failed';
    if (opts.json) {
      console.log(JSON.stringify({ valid: false, error: message }));
    } else {
      console.error(`daily-fix validate: ${message}`);
    }
    return 1;
  }
}

function cmdFilter(args: string[]): number {
  const opts = parseArgs(args);

  try {
    const inputs = {
      onlyJobs: opts.jobs,
      onlyTests: opts.tests,
      macShard: opts.macShard,
    };
    validateDispatchInputs(inputs);
    const config = buildFilterConfig(inputs);

    if (opts.json) {
      console.log(JSON.stringify({
        config,
        activeJobs: activeJobs(config),
        vitestArgs: vitestFilterArgs(config),
      }));
    } else {
      const active = activeJobs(config);
      console.log(`daily-fix filter:`);
      console.log(`  Active jobs (${active.length}): ${active.join(', ')}`);
      for (const job of ALLOWED_JOBS) {
        const status = shouldRunJob(job, config) ? 'RUN' : 'SKIP';
        console.log(`    ${status}: ${job}`);
      }
      if (config.testFilter) {
        console.log(`  Test filter: ${config.testFilter}`);
        console.log(`  Vitest args: ${vitestFilterArgs(config).join(' ')}`);
      } else {
        console.log('  Test filter: (none — run all tests)');
      }
      if (config.macShard) {
        console.log(`  Mac shard: ${config.macShard}`);
      }
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'filter failed';
    if (opts.json) {
      console.log(JSON.stringify({ error: message }));
    } else {
      console.error(`daily-fix filter: ${message}`);
    }
    return 1;
  }
}

function cmdDispatch(args: string[]): number {
  const opts = parseArgs(args);
  if (!opts.jobs && !opts.tests) {
    console.error('daily-fix dispatch: requires --jobs and/or --tests');
    return 2;
  }

  try {
    const inputs = {
      onlyJobs: opts.jobs,
      onlyTests: opts.tests,
      macShard: opts.macShard,
    };
    validateDispatchInputs(inputs);

    const command = buildDispatchCommand({
      onlyJobs: opts.jobs || undefined,
      onlyTests: opts.tests || undefined,
      macShard: opts.macShard,
    });

    if (opts.json) {
      console.log(JSON.stringify({ command }));
    } else {
      console.log(`daily-fix dispatch:`);
      console.log(`  ${command}`);
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'dispatch failed';
    if (opts.json) {
      console.log(JSON.stringify({ error: message }));
    } else {
      console.error(`daily-fix dispatch: ${message}`);
    }
    return 1;
  }
}

function cmdParseFixup(args: string[]): number {
  const opts = parseArgs(args);

  // Read fixup lines from stdin
  const lines: string[] = [];
  const stdin = process.stdin;
  if (stdin.isTTY) {
    // If stdin is a TTY, read from args instead
    for (const arg of args) {
      if (arg.startsWith('--')) continue;
      if (arg.startsWith('-')) continue;
      lines.push(arg);
    }
    if (lines.length === 0) {
      console.error('daily-fix parse-fixup: read fixup lines from stdin or pass as arguments');
      return 2;
    }
  } else {
    // Read from stdin stream
    stdin.setEncoding('utf8');
    let buffer = '';
    return new Promise((resolve) => {
      stdin.on('data', (chunk: string) => { buffer += chunk; });
      stdin.on('end', () => {
        for (const line of buffer.split('\n')) {
          if (line.trim()) lines.push(line.trim());
        }
        try {
          const inputs = aggregateFixupLines(lines);
          validateDispatchInputs(inputs);
          const config = buildFilterConfig(inputs);

          if (opts.json) {
            console.log(JSON.stringify({
              inputs,
              config,
              dispatch: buildDispatchCommand({
                onlyJobs: inputs.onlyJobs || undefined,
                onlyTests: inputs.onlyTests || undefined,
                macShard: inputs.macShard,
              }),
            }));
          } else {
            console.log(`daily-fix parse-fixup: ${lines.length} lines parsed`);
            if (inputs.onlyJobs) console.log(`  jobs: ${inputs.onlyJobs}`);
            if (inputs.onlyTests) console.log(`  tests: ${inputs.onlyTests}`);
            if (inputs.macShard) console.log(`  mac_shard: ${inputs.macShard}`);
            console.log(`  dispatch: ${buildDispatchCommand({
              onlyJobs: inputs.onlyJobs || undefined,
              onlyTests: inputs.onlyTests || undefined,
              macShard: inputs.macShard,
            })}`);
          }
          resolve(0);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'parse failed';
          if (opts.json) {
            console.log(JSON.stringify({ error: message }));
          } else {
            console.error(`daily-fix parse-fixup: ${message}`);
          }
          resolve(1);
        }
      });
    });
  }

  // Non-TTY path handled above; TTY path with args:
  const inputs = aggregateFixupLines(lines);
  try {
    validateDispatchInputs(inputs);
    const config = buildFilterConfig(inputs);

    if (opts.json) {
      console.log(JSON.stringify({
        inputs,
        config,
        dispatch: buildDispatchCommand({
          onlyJobs: inputs.onlyJobs || undefined,
          onlyTests: inputs.onlyTests || undefined,
          macShard: inputs.macShard,
        }),
      }));
    } else {
      console.log(`daily-fix parse-fixup: ${lines.length} lines parsed`);
      if (inputs.onlyJobs) console.log(`  jobs: ${inputs.onlyJobs}`);
      if (inputs.onlyTests) console.log(`  tests: ${inputs.onlyTests}`);
      if (inputs.macShard) console.log(`  mac_shard: ${inputs.macShard}`);
      console.log(`  dispatch: ${buildDispatchCommand({
        onlyJobs: inputs.onlyJobs || undefined,
        onlyTests: inputs.onlyTests || undefined,
        macShard: inputs.macShard,
      })}`);
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'parse failed';
    if (opts.json) {
      console.log(JSON.stringify({ error: message }));
    } else {
      console.error(`daily-fix parse-fixup: ${message}`);
    }
    return 1;
  }
}

export async function cmdDailyFix(args: string[]): Promise<number> {
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(HELP);
    return 0;
  }

  const sub = args[0];
  const rest = args.slice(1);

  switch (sub) {
    case 'validate': return cmdValidate(rest);
    case 'filter': return cmdFilter(rest);
    case 'dispatch': return cmdDispatch(rest);
    case 'parse-fixup': return cmdParseFixup(rest);
    default:
      console.error(`daily-fix: unknown subcommand "${sub}". Run "phm daily-fix --help" for usage.`);
      return 2;
  }
}
