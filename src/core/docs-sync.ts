import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { parse } from 'smol-toml';
import { listDocsPages, renderLlmsFull, renderLlmsTxt } from '../../scripts/lib/docs-pages.mjs';
import { HELP_ENTRIES } from '../cli/help.js';
import { TOP_LEVEL_COMMANDS } from '../cli/completions.js';

type Config = { name: string; docsDir: string; agentsFile: string; llmsFile: string; llmsFullFile: string; llmsReferenceFile: string; hostedDir: string; registry: string; cliName: string; siteOrigin: string; commands: string[] };
const START = '<!-- docs-sync:commands:start -->';
const END = '<!-- docs-sync:commands:end -->';

function configAt(root: string): Config {
  const parsed = parse(readFileSync(resolve(root, 'docs-sync.toml'), 'utf8'));
  const keys = ['name', 'docsDir', 'agentsFile', 'llmsFile', 'llmsFullFile', 'llmsReferenceFile', 'hostedDir', 'registry', 'cliName', 'siteOrigin'] as const;
  for (const key of keys) if (typeof parsed[key] !== 'string' || !parsed[key]) throw new Error(`docs-sync.toml requires ${key}`);
  if (parsed.version !== 1 || !['phantom', 'configured'].includes(String(parsed.registry))) throw new Error('Unsupported docs-sync.toml version or registry');
  if (!/^[a-z][a-z0-9-]*$/.test(String(parsed.cliName)) || !/^https:\/\/[a-z0-9.-]+(?::[0-9]+)?$/i.test(String(parsed.siteOrigin))) throw new Error('Invalid cliName or siteOrigin');
  if (parsed.registry === 'configured' && (!Array.isArray(parsed.commands) || !parsed.commands.length || parsed.commands.some(x => typeof x !== 'string' || !/^[a-z][a-z0-9-]*$/.test(x)))) throw new Error('Configured registry requires a nonempty commands array');
  return { ...parsed, commands: (parsed.commands ?? []) as string[] } as Config;
}

function safePath(root: string, path: string): string {
  if (isAbsolute(path)) throw new Error(`Path must be relative: ${path}`);
  const target = resolve(root, path);
  const rel = relative(root, target);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`Path outside checkout: ${path}`);
  // Existing ancestors must not redirect writes outside the checkout.
  let ancestor = target;
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  const realRel = relative(realpathSync(root), realpathSync(ancestor));
  if (realRel.startsWith('..') || isAbsolute(realRel)) throw new Error(`Path resolves outside checkout: ${path}`);
  return target;
}

export interface DocsSyncResult { ok: boolean; repo: string; check: boolean; drift: string[]; missing: { command: string; section: boolean; example: boolean }[]; fix: string | null }
export function syncDocs(cwd: string, repo: string | undefined, check: boolean): DocsSyncResult {
  let root = resolve(cwd);
  let cfg = configAt(root);
  if (repo && repo !== cfg.name) {
    if (!/^[a-z][a-z0-9-]*$/.test(repo)) throw new Error('Invalid repository name');
    root = resolve(root, '..', repo);
    cfg = configAt(root);
    if (cfg.name !== repo) throw new Error('Repository name does not match docs-sync.toml');
  }
  const docsDir = safePath(root, cfg.docsDir);
  const pages = listDocsPages(docsDir);
  const current = readFileSync(safePath(root, cfg.llmsFile), 'utf8');
  const reference = readFileSync(safePath(root, cfg.llmsReferenceFile), 'utf8');
  const commands = [...new Set(cfg.registry === 'phantom' ? TOP_LEVEL_COMMANDS : cfg.commands)].sort();
  const texts = pages.map(p => readFileSync(safePath(root, `${cfg.docsDir}/${p.slug}.md`), 'utf8'));
  const missing = commands.map(command => {
    const escaped = command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const section = texts.some(text => new RegExp(`^#{1,6} [^\\n]*\\b${escaped}\\b`, 'im').test(text));
    const executable = cfg.registry === 'phantom' ? '(?:phm|ashlr)' : cfg.cliName;
    const example = texts.some(text => [...text.matchAll(/```(?:sh|bash|shell|zsh)?[ \t]*\n([\s\S]*?)```/g)].some(block => new RegExp('^\\s*' + executable + '\\s+' + escaped + '(?:\\s|$)', 'im').test(block[1] ?? '')));
    return { command, section, example };
  }).filter(x => !x.section || !x.example);
  const agentsPath = safePath(root, cfg.agentsFile);
  const agents = readFileSync(agentsPath, 'utf8');
  const start = agents.indexOf(START), end = agents.indexOf(END);
  if ((start < 0) !== (end < 0) || (start >= 0 && end < start)) throw new Error('Invalid AGENTS.md docs-sync markers');
  const table = [START, '## CLI commands', '', '| Command | Description |', '| --- | --- |', ...commands.map(command => {
    const entry = cfg.registry === 'phantom' ? HELP_ENTRIES.find(e => e.cmd.split(/\s/)[0] === command) : undefined;
    return `| \`${command}\` | ${(entry?.desc ?? 'See the command documentation.').replace(/\|/g, '\\|').replace(/\u2014/g, '-')} |`;
  }), END].join('\n');
  const updatedAgents = start < 0 ? `${agents.trimEnd()}\n\n${table}\n` : `${agents.slice(0, start)}${table}${agents.slice(end + END.length)}`;
  const llms = renderLlmsTxt(current, pages);
  const full = renderLlmsFull(docsDir, pages, reference).replaceAll('https://verse.ashlr.ai/docs/', `${cfg.siteOrigin}/docs/`);
  const outputs = new Map<string, string>([[cfg.agentsFile, updatedAgents], [cfg.llmsFile, llms], [cfg.llmsFullFile, full], [`${cfg.hostedDir}/llms.txt`, llms], [`${cfg.hostedDir}/llms-full.txt`, full]]);
  for (const page of pages) outputs.set(`${cfg.hostedDir}/${page.slug}.md`, readFileSync(safePath(root, `${cfg.docsDir}/${page.slug}.md`), 'utf8'));
  const drift: string[] = [];
  for (const [path, content] of outputs) {
    const target = safePath(root, path);
    if (!existsSync(target) && check && path.startsWith(`${cfg.hostedDir}/`)) continue;
    if (!existsSync(target) || readFileSync(target, 'utf8') !== content) {
      drift.push(path);
      if (!check) { mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, content); }
    }
  }
  return { ok: missing.length === 0 && (!check || drift.length === 0), repo: cfg.name, check, drift, missing, fix: drift.length || missing.length ? 'Run phm docs sync --json and add missing command sections and copy-paste examples.' : null };
}
