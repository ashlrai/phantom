/**
 * Test that validates `--help` for all top-level phm commands.
 *
 * This test reads the CLI's command registry and ensures that every top-level
 * phm command (like `phm help`, `phm status`, etc.) responds to `--help` with
 * non-empty output and exits 0.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HELP_ENTRIES } from '../src/cli/help.js';
import { buildCommandCatalog } from '../src/core/commands/catalog.js';

// Get command names in the order they're listed in the help
const commandCatalog = buildCommandCatalog(HELP_ENTRIES);
const ALL_COMMAND_NAMES: string[] = commandCatalog.map(c => c.name);

// Mock environment for clean testing
const mockEnvs = {
  HOME: '',
  ASHLR_HOME: '',
  ASHLR_RUNS_DIR: '',
  NODE_ENV: 'test',
};

// These commands should not be directly tested as they're special cases
const EXCLUDED_COMMANDS = new Set([
  // These are not direct CLI verbs but special help cases:
  'help',
  // We're specifically testing top-level commands, so these are excluded from direct testing:
]);

// Commands we want to exclude because they're not top-level or not ready for --help testing:
const COMMANDS_TO_SKIP: Set<string> = new Set([
  // Commands that may have specific needs for testing or may not be properly implemented
  // The test will try to run these --help commands but they should not be skipped
]);

function getCommandNames(): string[] {
  return ALL_COMMAND_NAMES.filter(name => !EXCLUDED_COMMANDS.has(name));
}

// Command-specific skip list for commands that currently have issues
const KNOWN_HELP_ISSUES: Set<string> = new Set([
  // Add problematic commands here if they need to be skipped in the meantime
]);

/**
 * Run a --help test on a command using minimal setup similar to fleet-verb-help-smoke.test.ts
 */
async function runHelpTest(commandName: string, workingDir: string): Promise<void> {
  const { spawn } = await import('node:child_process');
  
  // Direct process execution approach - simpler and more reliable for this test case
  const { stdout, stderr, status } = await new Promise<{
    stdout: string;
    stderr: string;
    status: number | null;
  }>((resolve) => {
    const child = spawn(process.execPath, [join(process.cwd(), 'bin/phm.js'), commandName, '--help'], {
      cwd: workingDir,
      env: {
        ...process.env,
        ...mockEnvs,
        HOME: workingDir,
        ASHLR_HOME: join(workingDir, '.ashlr'),
        ASHLR_RUNS_DIR: join(workingDir, '.ashlr-runs'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdoutData = '';
    let stderrData = '';

    child.stdout.on('data', data => {
      stdoutData += data.toString();
    });

    child.stderr.on('data', data => {
      stderrData += data.toString();
    });

    child.on('close', (code) => {
      resolve({
        stdout: stdoutData,
        stderr: stderrData,
        status: code,
        error: null,
      });
    });
  });

  // Ensure the command exited successfully (status 0)
  expect(status, `Command ${commandName} --help failed with status ${status}`).toBe(0);

  // Ensure some output was produced (stdout or stderr)
  const output = stdout + stderr;
  expect(output.trim().length, `Command ${commandName} --help produced no output`).toBeGreaterThan(0);
}

describe('top-level phm command --help', () => {
  let tempDir: string;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'phm-help-test-'));
  });

  afterAll(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  describe('all top-level commands', () => {
    const commandsToTest = getCommandNames();

    for (const commandName of commandsToTest) {
      if (KNOWN_HELP_ISSUES.has(commandName)) {
        it.skip(`should show help for ${commandName} (known issue)`, async () => {
          await runHelpTest(commandName, tempDir);
        });
      } else {
        it(`should show help for ${commandName}`, async () => {
          await runHelpTest(commandName, tempDir);
        });
      }
    }
  });

  describe('specific command validation', () => {
    it('should validate the test setup works correctly', async () => {
      // This ensures the test environment is functional
      const { spawn } = await import('node:child_process');
      const { status } = await new Promise<{
        status: number | null;
      }>((resolve) => {
        const child = spawn(process.execPath, [join(process.cwd(), 'bin/phm.js'), '--help'], {
          cwd: tempDir,
          env: {
            ...process.env,
            ...mockEnvs,
            HOME: tempDir,
            ASHLR_HOME: join(tempDir, '.ashlr'),
            ASHLR_RUNS_DIR: join(tempDir, '.ashlr-runs'),
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        child.on('close', (code) => {
          resolve({ status: code });
        });
      });

      expect(status).toBe(0);
    });
  });
});
