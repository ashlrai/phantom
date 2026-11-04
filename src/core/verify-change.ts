import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

export const checkNames = ['typecheck', 'unit', 'lint', 'secrets'] as const;
export type CheckName = typeof checkNames[number];
export interface ChangeCheck { name: string; ok: boolean; secs: number; first_error: string | null }
export interface ChangeVerdict { pass: boolean; checks: ChangeCheck[]; changed_files: string[] }
type Command = string[];

/** Prefer declared CI scripts; never install tools or dependencies implicitly. */
export function changeCommands(root: string): Partial<Record<CheckName, Command>> {
  const commands: Partial<Record<CheckName, Command>> = {};
  if (existsSync(resolve(root, 'package.json'))) {
    const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { packageManager?: string; scripts?: Record<string, string> };
    const manager = pkg.packageManager?.split('@')[0] ?? (existsSync(resolve(root, 'bun.lock')) || existsSync(resolve(root, 'bun.lockb')) ? 'bun' : existsSync(resolve(root, 'pnpm-lock.yaml')) ? 'pnpm' : existsSync(resolve(root, 'yarn.lock')) ? 'yarn' : 'npm');
    if (!['npm', 'pnpm', 'bun', 'yarn'].includes(manager)) throw new Error('Unsupported package manager');
    for (const [name, candidates] of Object.entries({ typecheck: ['typecheck:ci', 'typecheck', 'check:types'], unit: ['test:ci', 'test:unit', 'test'], lint: ['lint:ci', 'lint'] })) {
      const script = candidates.find((key) => typeof pkg.scripts?.[key] === 'string');
      if (script) commands[name as CheckName] = [manager, 'run', script];
    }
  } else if (existsSync(resolve(root, 'Cargo.toml'))) {
    commands.typecheck = ['cargo', 'check', '--all-targets'];
    commands.unit = ['cargo', 'test'];
    commands.lint = ['cargo', 'clippy', '--all-targets', '--', '-D', 'warnings'];
  } else if (existsSync(resolve(root, 'pyproject.toml'))) {
    commands.typecheck = ['python', '-m', 'mypy', '.'];
    commands.unit = ['python', '-m', 'pytest'];
    commands.lint = ['python', '-m', 'ruff', 'check', '.'];
  } else if (existsSync(resolve(root, 'go.mod'))) {
    commands.typecheck = ['go', 'build', './...'];
    commands.unit = ['go', 'test', './...'];
    commands.lint = ['go', 'vet', './...'];
  }
  // Read CI's check invocations without running setup, deployment or credential steps.
  const workflowDir = resolve(root, '.github/workflows');
  if (existsSync(workflowDir)) {
    for (const file of readdirSync(workflowDir).filter((name) => /^ci\.ya?ml$/.test(name)).sort()) {
      const workflow = parse(readFileSync(resolve(workflowDir, file), 'utf8')) as { jobs?: Record<string, { steps?: { run?: string; 'working-directory'?: string }[] }> };
      for (const job of Object.values(workflow?.jobs ?? {})) {
        for (const step of job.steps ?? []) {
          if (typeof step.run !== 'string' || step['working-directory']) continue;
          for (const line of step.run.split('\n').map((text) => text.trim())) {
            if (!/^[a-zA-Z0-9_./* =,:@-]+$/.test(line)) continue;
            const name = /^(cargo check|go build|(?:uv run |python -m )?mypy)\b/.test(line) ? 'typecheck'
              : /^(cargo test|go test|(?:uv run |python -m )?pytest)\b/.test(line) ? 'unit'
              : /^(cargo clippy|go vet|(?:uv run |python -m )?ruff check)\b/.test(line) ? 'lint' : undefined;
            if (name) commands[name] = line.split(/\s+/);
          }
        }
      }
    }
  }
  if (existsSync(resolve(root, '.github/tests/secret-shape/scrub.pl'))) {
    commands.secrets = ['perl', '.github/tests/secret-shape/scrub.pl', '--check', '--allow-fixtures'];
  }
  return commands;
}

function run(root: string, command: Command, input?: string) {
  return spawnSync(command[0]!, command.slice(1), { cwd: root, input, encoding: 'utf8', timeout: 600_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
}

/** Runs repository code: use only with a trusted worktree. No subprocess output is published. */
export function verifyChange(worktree: string, selected: readonly CheckName[] = checkNames): ChangeVerdict {
  const root = resolve(worktree);
  const files = run(root, ['git', '-c', 'core.quotePath=false', 'ls-files', '-z', '--modified', '--others', '--exclude-standard']);
  const staged = run(root, ['git', 'diff', '--no-ext-diff', '--name-only', '-z', '--cached']);
  const changed = run(root, ['git', 'diff', '--no-ext-diff', '--name-only', '-z', 'HEAD']);
  if ([files, staged, changed].some((r) => r.status !== 0)) throw new Error('Cannot read worktree changes');
  const changed_files = [...new Set([files.stdout, staged.stdout, changed.stdout].join('\0').split('\0').filter(Boolean))].sort();
  const commands = changeCommands(root);
  const checks = selected.map((name): ChangeCheck => {
    const start = performance.now();
    const command = commands[name];
    if (!command) return { name, ok: false, secs: 0, first_error: 'No matching repository check configured' };
    let input: string | undefined;
    if (name === 'secrets') {
      const diff = run(root, ['git', 'diff', '--no-ext-diff', '--no-color', 'HEAD']);
      if (diff.status !== 0) return { name, ok: false, secs: 0, first_error: 'Cannot prepare secret scan' };
      input = diff.stdout;
      const untracked = run(root, ['git', 'ls-files', '-z', '--others', '--exclude-standard']);
      if (untracked.status !== 0) return { name, ok: false, secs: 0, first_error: 'Cannot enumerate untracked files' };
      for (const file of untracked.stdout.split('\0').filter(Boolean)) {
        const addition = run(root, ['git', 'diff', '--no-index', '--no-ext-diff', '--no-color', '--', '/dev/null', file]);
        if (addition.status !== 0 && addition.status !== 1) return { name, ok: false, secs: 0, first_error: 'Cannot scan untracked file' };
        input += addition.stdout;
      }
    }
    const result = run(root, command, input);
    const ok = result.status === 0 && !result.error;
    return { name, ok, secs: Math.round((performance.now() - start) / 10) / 100, first_error: ok ? null : result.error ? 'Check could not complete (tool unavailable, timeout or output limit)' : `Check exited ${result.status ?? 'without status'}; output withheld for credential safety` };
  });
  return { pass: checks.length > 0 && checks.every((check) => check.ok), checks, changed_files };
}

export function changeHandoff(verdict: ChangeVerdict): string {
  return [
    `Verification: ${verdict.pass ? 'PASS' : 'FAIL'}`,
    `Changed files: ${verdict.changed_files.length}`,
    `Checks run: ${verdict.checks.length}`,
    `Passed: ${verdict.checks.filter((c) => c.ok).length}`,
    `Failed: ${verdict.checks.filter((c) => !c.ok).length}`,
    ...checkNames.map((name) => `${name}: ${verdict.checks.find((c) => c.name === name)?.ok === true ? 'PASS' : verdict.checks.some((c) => c.name === name) ? 'FAIL' : 'not requested'}`),
    'Local verdict only; inspect failures locally. No publish or merge performed.',
  ].join('\n');
}
