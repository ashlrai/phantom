import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { safeGitConfigArgs } from '../sandbox/safe-git.js';
import { parseInstallManifest } from './manifest.js';
import { resolveInstall } from './resolver.js';
import { runInstallCommand, type InstallRunner } from './process.js';
import { fail, guardPath, objectFromJson, projectDirectory, readText, replaceConfig } from './storage.js';

export type ResolvedInstall = Awaited<ReturnType<typeof resolveInstall>>;
export interface InstallOptions {
  dir?: string;
  dryRun?: boolean;
  resolve?: typeof resolveInstall;
  run?: InstallRunner;
}
export interface InstallResult {
  schema: 'phantom.install.result.v1';
  status: 'planned' | 'installed' | 'unchanged' | 'needs-secrets';
  source: string;
  evidence: string[];
  manifest: ResolvedInstall['manifest'];
  directory: string;
  config: string | null;
  registration: { type: 'stdio'; command: string; args: string[] } | null;
  actions: string[];
  secretHook: { version: 1; status: 'not-required' | 'pending'; references: ResolvedInstall['manifest']['secrets'] };
}

const cleanEntry = (path: string): string => path.replace(/^\.\//, '');

async function verifyInstalled(root: string, resolved: ResolvedInstall): Promise<boolean> {
  const spec = resolved.manifest.install;
  const packageRoot = spec.kind === 'npm' ? join(root, 'node_modules', spec.package) : join(root, 'repo');
  const executable = join(packageRoot, resolved.entrypoint);
  // Every ancestor, the package metadata and the executable must be ordinary owned files.
  await guardPath(executable, root);
  if (await readText(executable, root) === null) return false;
  if (spec.kind === 'npm') {
    const packageText = await readText(join(packageRoot, 'package.json'), root);
    if (packageText === null) return false;
    const metadata = objectFromJson(packageText);
    const bin = typeof metadata.bin === 'string' ? metadata.bin
      : (metadata.bin as Record<string, unknown> | undefined)?.[spec.bin];
    if (metadata.name !== spec.package || metadata.version !== spec.version || typeof bin !== 'string' ||
      (typeof metadata.bin === 'string' && spec.bin !== spec.package.split('/').at(-1)) ||
      cleanEntry(bin) !== cleanEntry(resolved.entrypoint)) fail('Installed package does not match the resolved version and executable.');
  }
  return true;
}

/** Declarative install only. Credential requirements are a value-free hook for a future vault adapter. */
export async function installTool(input: string, options: InstallOptions = {}): Promise<InstallResult> {
  const resolved = await (options.resolve ?? resolveInstall)(input);
  resolved.manifest = parseInstallManifest(resolved.manifest);
  if (!/^(?:[A-Za-z0-9_@+-][A-Za-z0-9_.@+-]*\/)*[A-Za-z0-9_+-][A-Za-z0-9_.+-]*\.(?:c|m)?js$/.test(cleanEntry(resolved.entrypoint)) ||
    resolved.entrypoint.split('/').includes('..')) fail('Unsafe tool entrypoint.');
  resolved.entrypoint = cleanEntry(resolved.entrypoint);
  const project = await projectDirectory(options.dir ?? process.cwd());
  const identity = JSON.stringify({ manifest: resolved.manifest, entrypoint: resolved.entrypoint });
  const fingerprint = createHash('sha256').update(identity).digest('hex');
  const directory = join(project, '.phantom', 'tools', resolved.manifest.id, fingerprint.slice(0,16));
  const spec = resolved.manifest.install;
  const executable = spec.kind === 'npm' ? join(directory, 'node_modules', spec.package, resolved.entrypoint)
    : join(directory, 'repo', resolved.entrypoint);
  const configPath = join(project, '.mcp.json');
  const registration = resolved.manifest.mcp ? {
    type: 'stdio' as const, command: process.execPath, args: [executable, ...resolved.manifest.mcp.args],
  } : null;
  await guardPath(directory, project);
  const before = registration ? await readText(configPath, project) : null;
  const config = before === null ? {} : objectFromJson(before);
  if (config.mcpServers !== undefined && (!config.mcpServers || typeof config.mcpServers !== 'object' || Array.isArray(config.mcpServers))) fail('mcpServers must be a JSON object.');
  const servers = { ...(config.mcpServers as Record<string, unknown> | undefined) };
  const id = resolved.manifest.id;
  const registered = Object.hasOwn(servers, id);
  if (registration && registered && !isDeepStrictEqual(servers[id], registration)) fail('An existing MCP registration differs and was preserved. Review that entry before retrying.');
  const receiptPath = join(directory, 'receipt.json');
  const receipt = await readText(receiptPath, project);
  let installed = false;
  if (receipt !== null) {
    if (receipt !== identity + '\n') fail('Existing install receipt differs and was preserved.');
    installed = await verifyInstalled(directory, resolved);
  } else if (await lstat(directory).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) fail('Existing install directory has no matching receipt and was preserved.');
  const pendingSecrets = resolved.manifest.secrets.length > 0;
  const actions = [
    ...(!installed ? [`${receipt ? 'Repair' : 'Install'} ${spec.kind === 'npm' ? `${spec.package}@${spec.version}` : `${spec.repo}@${spec.commit}`} with lifecycle scripts disabled`] : []),
    ...(registration && !registered ? ['Register the verified Node entrypoint in project .mcp.json'] : []),
  ];
  const result: InstallResult = {
    schema: 'phantom.install.result.v1', status: pendingSecrets ? 'needs-secrets' : options.dryRun ? 'planned' : 'unchanged',
    source: resolved.source, evidence: resolved.evidence, manifest: resolved.manifest, directory,
    config: registration ? configPath : null, registration, actions,
    secretHook: { version: 1, status: pendingSecrets ? 'pending' : 'not-required', references: resolved.manifest.secrets },
  };
  if (options.dryRun || pendingSecrets || (!actions.length)) return result;

  const state = join(project, '.phantom');
  await mkdir(state, { recursive: true, mode: 0o700 });
  const lock = join(state, '.install-lock');
  try { await mkdir(lock, { mode: 0o700 }); } catch { fail('Another installation holds the project lock. Retry after it finishes.'); }
  const staging = join(state, `.install-${randomUUID()}`);
  const run = options.run ?? runInstallCommand;
  try {
    if (registration && await readText(configPath, project) !== before) fail('MCP configuration changed; retry installation.');
    if (!installed) {
      // Do not adopt a partial or user-created destination as a completed install.
      await guardPath(directory, project);
      await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
      await mkdir(staging, { mode: 0o700 });
      const home = join(staging, '.execution');
      await mkdir(home, { mode: 0o700 });
      const commandOptions = { cwd: staging, home };
      const npmFlags = ['--ignore-scripts', '--no-audit', '--no-fund', '--omit=dev', '--registry=https://registry.npmjs.org/'];
      if (spec.kind === 'npm') {
        await run('npm', ['install', '--prefix', staging, ...npmFlags, '--save-exact', `${spec.package}@${spec.version}`], commandOptions);
      } else {
        const repo = join(staging, 'repo');
        const git = async (args: string[]): Promise<void> => run('git', [...safeGitConfigArgs(), ...args], commandOptions);
        await git(['init', '--', repo]);
        await git(['-C', repo, '-c', 'http.followRedirects=false', 'fetch', '--depth=1', '--no-tags', `https://github.com/${spec.repo}.git`, spec.commit]);
        await git(['-C', repo, 'checkout', '--detach', spec.commit]);
        if (await readText(join(repo, 'package.json'), staging) !== null) {
          if (await readText(join(repo, 'package-lock.json'), staging) === null) fail('Git Node tools require a committed package-lock.json; install scripts are disabled.');
          // A repository-owned npmrc can redirect dependency fetches. It is never accepted.
          if (await readText(join(repo, '.npmrc'), staging) !== null) fail('Repository package-manager overrides are not supported.');
          await run('npm', ['ci', '--prefix', repo, ...npmFlags], commandOptions);
        }
      }
      if (!await verifyInstalled(staging, resolved)) fail('Installed tool entrypoint is missing; build scripts are disabled.');
      await rm(home, { recursive: true, force: true });
      await writeFile(join(staging, 'receipt.json'), identity + '\n', { flag: 'wx', mode: 0o600 });
      await guardPath(directory, project);
      if (await readText(receiptPath, project) !== receipt) fail('Install destination changed; retry installation.');
      if (receipt !== null) {
        // Only a matching receipt permits replacing our own incomplete installation.
        const backup = join(state, `.repair-${randomUUID()}`);
        await rename(directory, backup);
        try { await rename(staging, directory); }
        catch (error) { await rename(backup, directory); throw error; }
        await rm(backup, { recursive: true, force: true });
      } else {
        if (await lstat(directory).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) fail('Install destination appeared; it was preserved.');
        await rename(staging, directory);
      }
    }
    if (registration && !registered) {
      if (!await verifyInstalled(directory, resolved)) fail('Installed tool entrypoint is missing; retry installation.');
      await replaceConfig(configPath, project, before, { ...config, mcpServers: { ...servers, [id]: registration } });
    }
    return { ...result, status: 'installed' };
  } finally {
    await rm(staging, { recursive: true, force: true });
    await rm(lock, { recursive: true, force: true });
  }
}
