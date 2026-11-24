/**
 * Bot templates: one request turns a template (avatar, role, memory seed, starter tasks, crons,
 * messaging channels) into a new bot. A bot is an agent profile (`~/.phantom/agents/<id>.toml`,
 * see agent-profile.ts) plus a private folder `~/.phantom/bots/<id>/` holding the manifest, the
 * doctrine and the memory seed. Crons become DISABLED automations (src/core/automations), so the
 * owner switches them on after review.
 *
 * Authority: creating a bot grants nothing. The profile stays drafts-only with limitsTodo, the
 * channels are references only, starter tasks are recorded but never dispatched, and no message is
 * sent. The role vocabulary is the org model's (src/core/org/org.ts) so a bot can later be
 * declared there without translation.
 */
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { assertMetadata } from '../connectors/profile.js';
import { deleteAutomation, saveAutomation } from '../automations/store.js';
import type { AutomationInput } from '../automations/types.js';
import { CHANNEL_IDS, type ChannelId } from './channel-policy.js';
import { readAgentProfile, writeAgentProfile } from './agent-profile.js';

export class BotTemplateError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 = 400) { super(message); }
}

export const BOT_ROLES = ['leader', 'implementer', 'reviewer', 'researcher'] as const;
export type BotRole = typeof BOT_ROLES[number];
export const BOT_ID_PATTERN = /^[a-z][a-z0-9-]{1,23}$/;

export interface BotAvatar {
  /** One or two characters shown in the badge. */
  glyph: string;
  /** Hue, 0-359. The UI derives the colours so themes stay in control of contrast. */
  hue: number;
}
export interface BotTemplateCron {
  /** Stable key (a-z, 0-9, -), appended to the automation id. */
  key: string;
  input: AutomationInput;
}
export interface BotTemplate {
  id: string;
  name: string;
  blurb: string;
  role: BotRole;
  avatar: BotAvatar;
  resourceClass: 'any' | 'codex' | 'claude' | 'glm' | 'local';
  channels: ChannelId[];
  doctrine: string;
  memorySeed: string[];
  tasks: string[];
  crons: BotTemplateCron[];
}

const cron = (key: string, name: string, trigger: AutomationInput['trigger'], lane: AutomationInput['lane'], instructions: string): BotTemplateCron => ({
  key,
  input: {
    name, enabled: false, trigger, lane, playbookId: null, repos: ['*'], instructions,
    maxConcurrent: 1, maxPerDay: 2, queueDepth: 2, spendCapUsd: 0, dedupeKey: null, triage: null,
  },
});

export const BOT_TEMPLATES: readonly BotTemplate[] = Object.freeze([
  {
    id: 'pr-reviewer', name: 'PR reviewer', role: 'reviewer', avatar: { glyph: 'RV', hue: 210 },
    blurb: 'Reads open pull requests, checks them against the repo rules and drafts review notes.',
    resourceClass: 'any', channels: ['bus', 'handoff'],
    doctrine: [
      '# PR reviewer',
      '',
      'Review pull requests for correctness, missing tests and contract drift. Cite file and line.',
      'Never approve or merge; leave findings as drafts for the owner. Keep each note short and checkable.',
    ].join('\n'),
    memorySeed: [
      'Prefer a failing test that reproduces a bug over a description of it.',
      'A change to an exported signature needs the matching contract doc in the same PR.',
      'Flag any widened workflow permission or new secret reference for a security pass.',
    ],
    tasks: ['Review the oldest open pull request that has no review notes yet.', 'List open pull requests that changed tests and src together.'],
    crons: [cron('weekday-sweep', 'Weekday review sweep', { kind: 'schedule', rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0' }, 'leader-review',
      'Summarize open pull requests that still need review, oldest first. Draft the list for the owner; do not comment on GitHub.')],
  },
  {
    id: 'release-scribe', name: 'Release scribe', role: 'researcher', avatar: { glyph: 'RS', hue: 150 },
    blurb: 'Collects merged work each week and drafts plain-language release notes.',
    resourceClass: 'any', channels: ['bus', 'email'],
    doctrine: [
      '# Release scribe',
      '',
      'Turn merged pull requests into short, user-facing release notes grouped by area.',
      'State only what the merged diffs show. Drafts only: the owner publishes.',
    ].join('\n'),
    memorySeed: [
      'Group notes as Added, Changed, Fixed.',
      'Use the PR title, not the branch name, as the note headline.',
      'Skip pure CI, chore and bridge-bookkeeping merges unless they change behavior.',
    ],
    tasks: ['Draft release notes for everything merged since the last release.'],
    crons: [cron('friday-draft', 'Friday release notes draft', { kind: 'schedule', rrule: 'FREQ=WEEKLY;BYDAY=FR;BYHOUR=15;BYMINUTE=0' }, 'leader-review',
      'Draft release notes from the pull requests merged this week and place the draft in Needs-you. Do not publish or send.')],
  },
  {
    id: 'ci-watchdog', name: 'CI watchdog', role: 'implementer', avatar: { glyph: 'CI', hue: 28 },
    blurb: 'Watches the default branch and hands a red build to the fleet with the failing check named.',
    resourceClass: 'any', channels: ['bus', 'slack'],
    doctrine: [
      '# CI watchdog',
      '',
      'When the default branch goes red, identify the failing check and the first bad commit.',
      'Propose the smallest fix as a task. Never weaken or skip a test to make a build green.',
    ].join('\n'),
    memorySeed: [
      'A flaky test is fixed by removing its nondeterminism, not by retrying it.',
      'Quote the failing check name and the first failing assertion in every report.',
    ],
    tasks: ['Report the current state of the default branch checks and name any failing check.'],
    crons: [cron('red-branch', 'Default branch red', { kind: 'ci-red', branch: null, pollMinutes: 15 }, 'leader-review',
      'The default branch has a failing check. Name the check, the first failing commit and the smallest fix. Draft only.')],
  },
] satisfies BotTemplate[]);

export function getBotTemplate(id: string): BotTemplate | undefined { return BOT_TEMPLATES.find(t => t.id === id); }

/** Public shape for the picker: no doctrine body or cron internals. */
export interface BotTemplateSummary {
  id: string; name: string; blurb: string; role: BotRole; avatar: BotAvatar;
  channels: ChannelId[]; tasks: number; crons: number; memorySeed: number;
}
export function listBotTemplates(): BotTemplateSummary[] {
  return BOT_TEMPLATES.map(t => ({
    id: t.id, name: t.name, blurb: t.blurb, role: t.role, avatar: t.avatar, channels: [...t.channels],
    tasks: t.tasks.length, crons: t.crons.length, memorySeed: t.memorySeed.length,
  }));
}

export interface BotManifest {
  v: 1; id: string; name: string; templateId: string; role: BotRole; avatar: BotAvatar;
  channels: ChannelId[]; tasks: string[]; automations: string[]; createdAt: string;
}

export interface CreateBotRequest { templateId: string; id: string; name?: string }
export interface CreateBotResult { bot: BotManifest; profileVersion: number; files: string[] }

const botsRoot = (home: string): string => join(home, '.phantom', 'bots');
const errCode = (e: unknown): string | undefined => (e as NodeJS.ErrnoException).code;

/**
 * Create a bot from a template. All inputs are validated before any write; a failure after the
 * first write removes everything this call created, so a retry starts clean.
 */
export async function createBotFromTemplate(req: CreateBotRequest, opts: { home?: string; now?: Date } = {}): Promise<CreateBotResult> {
  const home = opts.home ?? homedir();
  const template = getBotTemplate(req.templateId) ?? (() => { throw new BotTemplateError('Unknown bot template.', 404); })();
  if (typeof req.id !== 'string' || !BOT_ID_PATTERN.test(req.id)) throw new BotTemplateError('Bot id must be 2-24 characters: lowercase letters, digits and dashes, starting with a letter.');
  const name = (req.name ?? template.name).trim();
  const nonPrintable = [...name].some((ch) => { const code = ch.charCodeAt(0); return code <= 0x1f || code === 0x7f; });
  if (name.length < 1 || name.length > 80 || nonPrintable) throw new BotTemplateError('Name must be 1-80 printable characters.');
  try { assertMetadata(name); } catch { throw new BotTemplateError('Secret-shaped names are refused.'); }
  const id = req.id;

  const dir = join(botsRoot(home), id);
  await mkdir(botsRoot(home), { recursive: true, mode: 0o700 });
  // Non-recursive mkdir is the atomic claim on the id.
  try { await mkdir(dir, { mode: 0o700 }); }
  catch (e) { throw errCode(e) === 'EEXIST' ? new BotTemplateError(`A bot named ${id} already exists.`, 409) : e; }

  const createdAutomations: string[] = [];
  let wroteProfile = false;
  try {
    // A profile can exist without a bot folder; never overwrite or version-bump it.
    const existing = await readAgentProfile(id, home).then(() => true, e => { if (errCode(e) === 'ENOENT') return false; throw e; });
    if (existing) throw new BotTemplateError(`An agent profile named ${id} already exists.`, 409);

    const manifest: BotManifest = {
      v: 1, id, name, templateId: template.id, role: template.role, avatar: template.avatar,
      channels: [...template.channels], tasks: [...template.tasks], automations: [],
      createdAt: (opts.now ?? new Date()).toISOString(),
    };
    for (const channel of manifest.channels) if (!CHANNEL_IDS.includes(channel)) throw new BotTemplateError('Template names an unknown channel.');

    const doctrine = `${template.doctrine}\n`;
    const seed = `# Memory seed\n\n${template.memorySeed.map(n => `- ${n}`).join('\n')}\n`;
    assertMetadata(doctrine); assertMetadata(seed);
    await writeFile(join(dir, 'doctrine.md'), doctrine, { mode: 0o600, flag: 'wx' });
    await writeFile(join(dir, 'memory-seed.md'), seed, { mode: 0o600, flag: 'wx' });

    const profile = await writeAgentProfile({
      id, version: 1, displayName: name, doctrine: `bots/${id}/doctrine.md`, resourceClass: template.resourceClass,
      channels: manifest.channels,
    }, home);
    wroteProfile = true;

    for (const c of template.crons) {
      const saved = await saveAutomation({ ...c.input, id: `au_bot-${id}-${c.key}`.slice(0, 48), name: `${name}: ${c.input.name}`.slice(0, 80), enabled: false },
        { mode: 'create', now: opts.now });
      createdAutomations.push(saved.automation.id);
    }
    manifest.automations = createdAutomations;
    const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
    assertMetadata(manifestText);
    await writeFile(join(dir, 'bot.json'), manifestText, { mode: 0o600, flag: 'wx' });
    return { bot: manifest, profileVersion: profile.version, files: ['bot.json', 'doctrine.md', 'memory-seed.md'] };
  } catch (error) {
    for (const a of createdAutomations) await deleteAutomation(a).catch(() => undefined);
    if (wroteProfile) {
      await rm(join(home, '.phantom', 'agents', `${id}.toml`), { force: true });
      await rm(join(home, '.phantom', 'agents', `${id}.versions`), { recursive: true, force: true });
    }
    await rm(dir, { recursive: true, force: true });
    if (error instanceof BotTemplateError) throw error;
    // Validation text from the profile writer and automation store is already metadata-only.
    throw new BotTemplateError(error instanceof Error ? error.message : 'Bot could not be created.');
  }
}

/** Bots created from templates, oldest id first. Unreadable manifests are skipped. */
export async function listBots(home = homedir()): Promise<BotManifest[]> {
  let names: string[];
  try { names = await readdir(botsRoot(home)); } catch { return []; }
  const out: BotManifest[] = [];
  for (const n of names.filter(x => BOT_ID_PATTERN.test(x)).sort()) {
    try {
      const m = JSON.parse(await readFile(join(botsRoot(home), n, 'bot.json'), 'utf8')) as BotManifest;
      if (m.v === 1 && m.id === n) out.push(m);
    } catch { /* a half-written or foreign folder is not a bot */ }
  }
  return out;
}
