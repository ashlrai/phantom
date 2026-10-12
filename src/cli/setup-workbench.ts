/**
 * `phm setup workbench` — the terminal twin of the desktop setup wizard
 * (docs/onboarding.md). Read-mostly and value-blind:
 *
 *   phm setup workbench                 overview: companions + detected resources + next action
 *   phm setup workbench ecosystem       companion cards (all on by default; --exclude a,b)
 *   phm setup workbench star <id>       star one companion repo via gh (your explicit command)
 *   phm setup workbench resources       storage/scope plan for detected resources
 *   phm setup workbench assistant       the confirm-each-step plan + the redacted model brief
 *   phm setup workbench context         list importable Claude/Codex/Grok context
 *   phm setup workbench context <id> [--import --yes]   preview, then import with consent
 *   phm setup workbench health          the existing doctor checks, summarised
 *
 * It never installs, signs in, stores a secret or registers MCP by itself.
 */
import { spawnSync } from 'node:child_process';
import { COMPANION_MANIFEST, applyExclusions, companionById, repoUrl, selectedIds, type CompanionId } from '../core/ecosystem/companion-manifest.js';
import { detectInstalled } from '../core/onboarding/detect.js';
import { planResource, kindMeta, summarise, type ResourceEntry } from '../core/onboarding/resources-model.js';
import { buildProposals, buildAssistantBrief } from '../core/onboarding/setup-assistant.js';
import { discoverContextSources, importSource, previewSource } from '../core/onboarding/context-import.js';
import { isTty, makeColors } from './ui.js';

const { bold, dim, green, yellow, cyan } = makeColors(isTty());

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function out(json: boolean, value: unknown, human: () => void): void {
  if (json) process.stdout.write(JSON.stringify(value, null, 2) + '\n');
  else human();
}

export function detectedEntries(): ResourceEntry[] {
  const det = detectInstalled();
  return (Object.keys(det.resources) as Array<keyof typeof det.resources>).map((kind) => ({
    id: `detected-${kind}`,
    kind,
    label: kindMeta(kind).label,
    scope: 'personal',
    scopeName: null,
    credentialName: null,
  }));
}

export const SETUP_WORKBENCH_HELP = `phm setup workbench [ecosystem|star <id>|resources|assistant|context [<id> --import --yes]|health] [--exclude a,b] [--json]`;

export async function cmdSetupWorkbench(args: string[]): Promise<number> {
  const json = args.includes('--json');
  const sub = args[0] && !args[0].startsWith('--') ? args[0] : 'overview';
  const { selection, unknown } = applyExclusions(flag(args, '--exclude'));
  if (unknown.length) {
    console.error(`unknown companion(s): ${unknown.join(', ')}. Known: ${COMPANION_MANIFEST.map((c) => c.id).join(', ')}`);
    return 2;
  }
  const enabled = new Set<CompanionId>(selectedIds(selection));
  const det = detectInstalled();
  const installed = new Set(Object.keys(det.companions) as CompanionId[]);
  const plans = detectedEntries().map((e) => planResource(e, enabled));

  switch (sub) {
    case 'help':
    case '--help':
      console.log(SETUP_WORKBENCH_HELP);
      return 0;
    case 'overview':
    case 'ecosystem': {
      const rows = COMPANION_MANIFEST.map((c) => ({ id: c.id, title: c.title, tier: c.tier, selected: selection[c.id], installed: installed.has(c.id), tagline: c.tagline, repo: repoUrl(c), install: c.install }));
      out(json, { companions: rows, detectedResources: Object.keys(det.resources) }, () => {
        console.log(bold('\n  Phantom setup') + dim('  — companions are on by default; --exclude id,id to leave any out\n'));
        for (const r of rows) {
          const mark = r.selected ? green('●') : dim('○');
          console.log(`  ${mark} ${bold(r.title.padEnd(16))} ${r.installed ? green('installed') : dim('not installed')}  ${dim(r.tagline)}`);
          if (sub === 'ecosystem') console.log(`      ${dim(r.repo)}   ${dim('install:')} ${cyan(r.install)}`);
        }
        const res = Object.keys(det.resources);
        console.log(`\n  ${bold('Resources found')}: ${res.length ? res.map((k) => kindMeta(k as never).label).join(', ') : dim('none on PATH — one Claude Code login is enough to start')}`);
        console.log(`\n  ${dim('Next:')} ${cyan('phm setup workbench assistant')}\n`);
      });
      return 0;
    }
    case 'star': {
      const entry = companionById(args[1] ?? '');
      if (!entry) {
        console.error(`usage: phm setup workbench star <${COMPANION_MANIFEST.map((c) => c.id).join('|')}>`);
        return 2;
      }
      // The user typed this command naming one repo: that is the click.
      const r = spawnSync('gh', ['api', '-X', 'PUT', `user/starred/${entry.repo}`, '--silent'], { stdio: ['ignore', 'ignore', 'pipe'] });
      if (r.status === 0) {
        console.log(`  ${green('★')} starred ${entry.repo}`);
        return 0;
      }
      console.log(`  ${yellow('!')} gh is not signed in or unavailable. Star it in your browser: ${repoUrl(entry)}`);
      return 1;
    }
    case 'resources': {
      const summary = summarise(plans);
      out(json, { summary, plans }, () => {
        console.log(bold('\n  Resources') + dim(`  — credentials go to ${enabled.has('phantom-secrets') ? 'Phantom Secrets' : 'the OS keychain'}; scopes ${enabled.has('locus') ? 'enforced by Locus' : 'kept as labels'}\n`));
        if (!plans.length) console.log(`  ${dim('Nothing detected. Sign in one CLI (e.g. claude login) and re-run.')}`);
        for (const p of plans) {
          console.log(`  ${green('✓')} ${p.entry.label}`);
          for (const s of p.steps) console.log(`      ${cyan(s)}`);
        }
        console.log(`\n  ${dim('API keys and cloud credits: add them in the desktop wizard, or run')} ${cyan('phantom add NAME')} ${dim('in a trusted terminal.')}\n`);
      });
      return 0;
    }
    case 'assistant': {
      const proposals = buildProposals(enabled, plans, installed);
      const brief = buildAssistantBrief(enabled, plans, proposals);
      out(json, { proposals, brief }, () => {
        console.log(bold('\n  Setup plan') + dim('  — run each step yourself; nothing here executes automatically\n'));
        proposals.forEach((p, i) => console.log(`  ${dim(String(i + 1).padStart(2))}. ${p.title}\n      ${cyan(p.command)}`));
        console.log(`\n  ${dim('Paste the brief below into a chat on a local model or connected seat for guidance (it contains no secret values):')}\n`);
        console.log(brief.split('\n').map((l) => '    ' + l).join('\n') + '\n');
      });
      return 0;
    }
    case 'context': {
      const sources = discoverContextSources();
      const id = args[1] && !args[1].startsWith('--') ? args[1] : undefined;
      if (!id) {
        out(json, { sources }, () => {
          console.log(bold('\n  Importable context') + dim('  — nothing is read until you pick one\n'));
          if (!sources.length) console.log(`  ${dim('No CLAUDE.md, AGENTS.md, ~/.codex or ~/.grok files found.')}`);
          for (const s of sources) console.log(`  ${cyan(s.id.padEnd(18))} ${s.label} ${dim(`(${s.bytes} bytes)`)}`);
          if (sources.length) console.log(`\n  ${dim('Preview:')} ${cyan('phm setup workbench context <id>')}\n`);
        });
        return 0;
      }
      const source = sources.find((s) => s.id === id);
      if (!source) {
        console.error(`no importable source "${id}"`);
        return 2;
      }
      if (args.includes('--import')) {
        if (!args.includes('--yes')) {
          console.error('import copies a redacted copy into ~/.ashlr/context/imported. Re-run with --import --yes to consent.');
          return 2;
        }
        const dest = importSource(source, { consent: true });
        out(json, { imported: dest }, () => console.log(`  ${green('✓')} imported to ${dest}`));
        return 0;
      }
      const preview = previewSource(source);
      out(json, preview, () => {
        console.log(bold(`\n  Preview: ${source.label}`) + dim(`  (${preview.redactions} redaction(s)${preview.truncated ? ', first 4 KB' : ''})\n`));
        console.log(preview.text.split('\n').map((l) => '    ' + l).join('\n'));
        console.log(`\n  ${dim('Import:')} ${cyan(`phm setup workbench context ${source.id} --import --yes`)}\n`);
      });
      return 0;
    }
    case 'health': {
      const { loadConfig } = await import('../core/config.js');
      const { runDoctor } = await import('../core/doctor.js');
      const report = await runDoctor(loadConfig());
      const companionRows = COMPANION_MANIFEST.filter((c) => enabled.has(c.id) && c.executable).map((c) => ({ id: c.id, installed: installed.has(c.id) }));
      out(json, { summary: report.summary, checks: report.checks, companions: companionRows }, () => {
        console.log(bold('\n  Health') + dim(`  — ${report.summary.pass} pass · ${report.summary.warn} warn · ${report.summary.fail} fail\n`));
        for (const c of report.checks.filter((x) => x.status !== 'pass')) console.log(`  ${c.status === 'fail' ? yellow('✗') : yellow('!')} ${c.label}  ${dim(c.detail)}`);
        for (const c of companionRows) console.log(`  ${c.installed ? green('✓') : yellow('!')} ${companionById(c.id)!.title} ${c.installed ? 'installed' : dim('selected but not installed')}`);
        console.log('');
      });
      return report.summary.fail > 0 ? 1 : 0;
    }
    default:
      console.error(`unknown setup workbench step: ${sub}\n${SETUP_WORKBENCH_HELP}`);
      return 2;
  }
}
