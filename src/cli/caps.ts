/**
 * `phm caps` — capability registry: list, validate, generate adapters to staging.
 * Thin: argv parsing and printing only; logic lives in src/core/caps/.
 */

import { capsGenerate, capsList, capsValidate } from '../core/caps/service.js';
import { rejectUnknownOptions } from './args.js';

export const CAPS_USAGE = `Usage: phm caps <list|validate|generate> [options]

  list       Surfaces, models, (surface, model) pairs, hosting edges,
             sessions, account references and capabilities.
  validate   Check the registry: schema, cross-references, sensitivity
             flags and hard-limit gates, control backends, loopback-only
             local models, reference-only accounts. Exit 1 when invalid.
  generate   Emit per-agent adapters (Claude Code, Codex, Fable sessions,
             Devin and hosted surfaces, Cursor, Grok Build, Gemini, Copilot,
             local models) with sha256 sums and a pin-stage manifest.
             Writes only under the worktree (default capabilities/generated)
             or ~/.ashlr-runs/staged/; never into ~/.codex or other live
             agent config directories.

Options:
  --registry <path>  Registry file (default: capabilities/registry.v1.json)
  --out <dir>        generate: output directory inside the worktree
  --pin-stage        generate: stage under ~/.ashlr-runs/staged/caps/<sha>/
  --check            generate: compare with the output directory, write nothing
  --json             Machine-readable output
  -h, --help         Show this help`;

const VERBS = ['list', 'validate', 'generate'] as const;

export async function cmdCaps(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) { console.log(CAPS_USAGE); return 0; }
  const json = args.includes('--json');
  const usage = (message: string): number => {
    if (json) console.log(JSON.stringify({ ok: false, error: message }));
    else console.error(`${message}\n\n${CAPS_USAGE}`);
    return 2;
  };
  const verb = args[0];
  if (!verb || !(VERBS as readonly string[]).includes(verb)) return usage(verb ? `Unknown caps verb: ${verb}` : 'Missing caps verb.');
  const rest = args.slice(1);
  const generateOnly = verb === 'generate';
  const bad = rejectUnknownOptions(rest, {
    flags: ['--json', ...(generateOnly ? ['--check', '--pin-stage'] : [])],
    values: ['--registry', ...(generateOnly ? ['--out'] : [])],
  });
  if (bad) return usage(bad.message);
  const positional = rest.filter((a, i) => !a.startsWith('-') && !['--registry', '--out'].includes(rest[i - 1] ?? ''));
  if (positional.length) return usage(`Unexpected argument: ${positional[0]}`);
  const value = (flag: string): string | undefined => { const i = rest.indexOf(flag); return i >= 0 ? rest[i + 1] : undefined; };
  const registry = value('--registry');

  try {
    if (verb === 'validate') {
      const result = await capsValidate({ registry });
      if (json) console.log(JSON.stringify(result));
      else if (result.ok) console.log(`PASS: ${result.registryPath} — ${Object.entries(result.counts).map(([k, n]) => `${n} ${k}`).join(', ')}`);
      else { for (const i of result.issues) console.log(`${i.path}: ${i.message}`); console.log(`FAIL: ${result.issues.length} issue(s) in ${result.registryPath}`); }
      return result.ok ? 0 : 1;
    }
    if (verb === 'list') {
      const view = await capsList({ registry });
      if (json) { console.log(JSON.stringify(view)); return view.ok ? 0 : 1; }
      if (!view.ok) { for (const i of view.issues) console.log(`${i.path}: ${i.message}`); return 1; }
      console.log('Surfaces');
      for (const s of view.surfaces) console.log(`  ${s.id.padEnd(18)} ${s.kind.padEnd(13)} lane ${s.lane.padEnd(8)} adapter ${s.adapter}${s.hosts.length ? `  hosted by ${s.hosts.join(', ')}` : ''}`);
      console.log('Models');
      for (const m of view.models) console.log(`  ${m.id.padEnd(22)} lane ${m.lane.padEnd(8)} ${m.catalogId ?? '(not routed)'}${m.allowance ? `  allowance ${m.allowance}` : ''}`);
      console.log(`Pairs: ${view.pairs.length} routable (surface, model) pairs`);
      console.log('Sessions');
      for (const s of view.sessions) console.log(`  ${s.id}: ${s.surface} + ${s.model} (${s.role})`);
      console.log('Accounts (references only)');
      for (const a of view.accounts) console.log(`  ${a.id.padEnd(16)} ${a.store.padEnd(15)} ${a.credentialName ?? '(host session)'}  scopes ${a.scopes.join(' ')}`);
      console.log('Capabilities');
      for (const c of view.capabilities) console.log(`  ${c.id.padEnd(18)} ${c.kind.padEnd(9)}${c.flags.length ? ` gated: ${c.flags.join('+')} via ${c.hardLimitGates.join(', ')}` : ''}`);
      return 0;
    }
    const result = await capsGenerate({ registry, out: value('--out'), check: rest.includes('--check'), pinStage: rest.includes('--pin-stage') });
    if (json) console.log(JSON.stringify(result));
    else if ('issues' in result) { for (const i of result.issues) console.log(`${i.path}: ${i.message}`); console.log('FAIL: registry invalid; nothing generated'); }
    else if (result.mode === 'check') {
      const d = result.drift;
      for (const p of d.changed) console.log(`changed: ${p}`);
      for (const p of d.missing) console.log(`missing: ${p}`);
      for (const p of d.stale) console.log(`stale:   ${p}`);
      console.log(result.ok ? `PASS: adapters in ${result.outDir} match bundle ${result.bundleSha256}` : 'FAIL: adapters drifted; run phm caps generate');
    } else {
      console.log(`Wrote ${result.written.length} files to ${result.outDir}${result.removed.length ? ` (removed ${result.removed.length} stale)` : ''}`);
      console.log(`bundle sha256 ${result.bundleSha256}`);
      console.log('Pin-stage: stage with --pin-stage, then hand the directory to SEC-PIN-STAGE-TOOL-2 (pin_stage_lib fe77a6a8); verify with shasum -a 256 -c SHA256SUMS.');
    }
    return result.ok ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (json) console.log(JSON.stringify({ ok: false, error: message }));
    else console.error(message);
    return 1;
  }
}
