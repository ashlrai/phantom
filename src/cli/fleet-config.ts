/** `ashlr fleet config` — runtime-dynamic fleet config (RQ-DYNCONFIG-1).
 * Thin handler: parse argv, delegate to src/core/fleet/dynconfig.ts. */
import { isAbsolute } from 'node:path';
import { rejectUnknownOptions } from './args.js';
import { makeColors, isTty } from './ui.js';
import {
  DynConfigError,
  MUTABLE_KEY_PATTERNS,
  RESTART_REQUIRED,
  clearLiveOverride,
  createConfigReader,
  readConfigAudit,
  setLiveOverride,
} from '../core/fleet/dynconfig.js';

const { red } = makeColors(isTty());
const USAGE = `usage: ashlr fleet config <get|set|unset|audit|restart-required> ...
  get [<key>] [--override <key=value>]... [--json]   effective value and the layer that won
  set <key> <value> --reason <text> [--by <actor>]   write a live override (atomic, audited)
  unset <key> --reason <text> [--by <actor>]         remove a live override
  audit [--limit <n>] [--json]                       active overrides plus the who/when/why log
  restart-required [--json]                          keys that can never change at runtime
  common: [--runs-dir <abs>]`;
const DEFAULT_BY = 'ashlr fleet config';

function fail(message: string, code = 2): number {
  process.stderr.write(`${red('error: ')}fleet config: ${message}\n`);
  return code;
}

export async function cmdFleetConfig(args: string[]): Promise<number> {
  if (args.length === 0 || ['--help', '-h'].includes(args[0]!)) {
    console.log(`${USAGE}\nLayers, low to high: pinned defaults < slots.json < budget-overrides.json < live-config.json < --override.\nOnly the keys listed by restart-required's complement are mutable; run \`restart-required\` for the refused list.`);
    return 0;
  }
  const [verb, ...rest] = args;
  if (!['get', 'set', 'unset', 'audit', 'restart-required'].includes(verb!)) return fail(`unknown verb: ${verb}\n${USAGE}`);
  const bad = rejectUnknownOptions(rest, { flags: ['--json'], values: ['--runs-dir', '--reason', '--by', '--limit', '--override'] });
  if (bad) return fail(`${bad.message}\n${USAGE}`);
  let json = false;
  let runsDir: string | undefined;
  let reason: string | undefined;
  let by = DEFAULT_BY;
  let limit: number | undefined;
  const overrides: Record<string, unknown> = {};
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === '--json') json = true;
    else if (arg === '--runs-dir') runsDir = rest[++i];
    else if (arg === '--reason') reason = rest[++i];
    else if (arg === '--by') by = rest[++i] ?? '';
    else if (arg === '--limit') limit = Number(rest[++i]);
    else if (arg === '--override') {
      const [k, ...v] = (rest[++i] ?? '').split('=');
      const text = v.join('=');
      if (!k || !v.length) return fail(`--override expects key=value\n${USAGE}`);
      overrides[k] = /^-?\d+(\.\d+)?$/.test(text) ? Number(text) : text;
    } else positional.push(arg);
  }
  if (runsDir !== undefined && !isAbsolute(runsDir)) return fail(`--runs-dir requires an absolute path\n${USAGE}`);
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) return fail(`--limit expects a positive integer\n${USAGE}`);
  const opts = { runsDir };
  try {
    if (verb === 'restart-required') {
      const payload = { restartRequired: RESTART_REQUIRED.map(r => ({ category: r.category, pattern: r.pattern.source, why: r.why })), mutable: MUTABLE_KEY_PATTERNS };
      console.log(json ? JSON.stringify(payload) : [
        'Restart-required (never runtime-mutable):',
        ...payload.restartRequired.map(r => `  ${r.category}: ${r.why}`),
        '', 'Runtime-mutable keys:', ...MUTABLE_KEY_PATTERNS.map(k => `  ${k}`),
      ].join('\n'));
      return 0;
    }
    if (verb === 'audit') {
      if (positional.length) return fail(`audit takes no arguments\n${USAGE}`);
      const report = await readConfigAudit({ ...opts, limit });
      if (json) { console.log(JSON.stringify(report)); return 0; }
      console.log([
        `Live config — ${report.state}${report.last_change_by ? ` · last change by ${report.last_change_by}` : ''}`,
        ...(report.active.length ? report.active.map(a => `  ${a.key} = ${a.value}  (${a.by} ${a.at}: ${a.reason})`) : ['  (no active overrides)']),
        '', 'Audit log:',
        ...(report.entries.length ? report.entries.map(e => `  ${e.at} ${e.op} ${e.key} ${e.from ?? '-'} -> ${e.to ?? '-'} by ${e.by}: ${e.reason}`) : ['  (empty)']),
      ].join('\n'));
      return 0;
    }
    if (verb === 'get') {
      if (positional.length > 1) return fail(`get takes at most one key\n${USAGE}`);
      const r = await createConfigReader(opts).resolve(overrides);
      const keys = positional.length ? [positional[0]!] : Object.keys(r.values).sort();
      if (positional.length && !(keys[0]! in r.values)) return fail(`no value for ${keys[0]}`, 1);
      const rows = keys.map(key => ({ key, value: r.values[key], ...r.provenance[key]! }));
      if (json) console.log(JSON.stringify({ layers: r.layers, rejected: r.rejected, values: rows }));
      else {
        for (const row of rows) console.log(`${row.key} = ${row.value}  [${row.layer}${row.by ? ` · ${row.by} ${row.at}: ${row.reason}` : ''}]`);
        for (const x of r.rejected) console.log(`ignored ${x.layer} override ${x.key}: ${x.reason}`);
      }
      return r.rejected.some(x => x.layer === 'cli') ? 2 : 0;
    }
    // set / unset
    const need = verb === 'set' ? 2 : 1;
    if (positional.length !== need) return fail(`${verb} expects ${need === 2 ? '<key> <value>' : '<key>'}\n${USAGE}`);
    if (!reason) return fail(`${verb} requires --reason\n${USAGE}`);
    const [key, raw] = positional as [string, string];
    const entry = verb === 'set'
      ? await setLiveOverride({ key, value: /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw, by, reason }, opts)
      : await clearLiveOverride({ key, by, reason }, opts);
    console.log(json ? JSON.stringify(entry) : `${entry.key}: ${entry.from ?? '-'} -> ${entry.to ?? '-'} (${entry.op}, ${entry.by})`);
    return 0;
  } catch (error) {
    if (error instanceof DynConfigError) return fail(`${error.code}: ${error.message}`, error.code === 'unavailable' || error.code === 'locked' ? 1 : 2);
    return fail(`unavailable: ${(error as Error).message}`, 1);
  }
}
