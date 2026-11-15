/** Explicit, evidence-linked working memory. No transcript is stored or resumed. */
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { z } from 'zod';
import type { ChatMessage } from '../types.js';
import { assurePrivateStoragePath } from '../util/private-storage.js';
import { writePrivateFileAtomically } from '../util/private-file-write.js';
import { readStableRegularFile } from '../util/stable-file-read.js';

const text = z.string().trim().min(1).max(8192);
const list = z.array(text).max(128);
export const checkpointDraftSchema = z.object({
  objective: text,
  verified_facts: z.array(z.object({ text, evidence_ref: z.string().trim().max(8192).optional() }).strict()).max(128),
  open_hypotheses: list,
  failed_approaches: list,
  next_actions: list,
}).strict();
const checkpointSchema = checkpointDraftSchema.extend({
  verified_facts: z.array(z.object({ text, evidence_ref: text }).strict()).max(128),
  // Every proposed fact may be downgraded, in addition to the 128 supplied hypotheses.
  open_hypotheses: z.array(text).max(256),
  revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  created_at: z.iso.datetime(),
});
export type AgentCheckpoint = z.infer<typeof checkpointSchema>;
export type CheckpointDraft = z.infer<typeof checkpointDraftSchema>;
export const checkpointToolDefinition = {
  name: 'phantom_checkpoint', type: 'function',
  function: {
    name: 'phantom_checkpoint',
    description: 'Save explicit working memory and immediately resume in a clean context. Use alone in a tool batch. Cite checkpoint evidence_ref IDs from completed tools for facts; uncited claims become hypotheses. Include every next action and failed approach needed after discarding the transcript.',
    parameters: z.toJSONSchema(checkpointDraftSchema),
  },
};
const eventSchema = z.object({
  id: z.string().uuid(), tool_call_id: text, tool: text,
  result_sha256: z.string().regex(/^[a-f0-9]{64}$/), created_at: z.iso.datetime(),
}).strict();
export type CheckpointToolEvent = z.infer<typeof eventSchema>;
const envelopeSchema = z.object({
  version: z.literal(1), key: text, repo_root: text,
  checkpoint: checkpointSchema.nullable(), events: z.array(eventSchema).max(1024),
}).strict();
const MAX_BYTES = 2 * 1024 * 1024;

export function checkpointsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PHANTOM_CHECKPOINTS === '1';
}
function requireEnabled(): void {
  if (!checkpointsEnabled()) throw new Error('Checkpoints require PHANTOM_CHECKPOINTS=1.');
}

/** A reference must resolve to an observed successful tool event, not just be nonempty. */
export function normalizeCheckpoint(
  draft: unknown, evidenceRefs: readonly string[], revision: number,
  createdAt = new Date().toISOString(),
): AgentCheckpoint {
  const parsed = checkpointDraftSchema.parse(draft);
  return normalizeFields(parsed, evidenceRefs, revision, createdAt);
}

function normalizeFields(
  parsed: CheckpointDraft, evidenceRefs: readonly string[], revision: number, createdAt: string,
): AgentCheckpoint {
  const known = new Set(evidenceRefs);
  const verified_facts = parsed.verified_facts.filter(fact => fact.evidence_ref && known.has(fact.evidence_ref));
  const unevidenced = parsed.verified_facts.filter(fact => !fact.evidence_ref || !known.has(fact.evidence_ref));
  return checkpointSchema.parse({ ...parsed, verified_facts,
    open_hypotheses: [...new Set([...parsed.open_hypotheses, ...unevidenced.map(fact => fact.text)])],
    revision, created_at: createdAt });
}

/** Host instructions are fresh policy; there is deliberately no transcript parameter. */
export function buildCheckpointContext(
  checkpoint: AgentCheckpoint, freshRepoState: string, systemInstructions: string,
): ChatMessage[] {
  const parsed = checkpointSchema.parse(checkpoint);
  return [{ role: 'system', content: systemInstructions }, { role: 'user', content:
    'Resume from this checkpoint. Facts are historical observations; recheck mutable state before acting.\n' +
    JSON.stringify(parsed) + '\nFresh repository state:\n' + freshRepoState }];
}

export interface CheckpointOptions {
  /** Host-owned store; never accept these options from model arguments. */
  directory: string;
  key: string;
  repoRoot: string;
  resume?: boolean;
}

/** One host-owned writer per key. Atomic replacement keeps checkpoint and evidence together. */
export class CheckpointStore {
  readonly path: string;
  readonly repoRoot: string;
  private readonly directory: string;
  private readonly key: string;

  constructor(options: CheckpointOptions) {
    requireEnabled();
    this.key = text.parse(options.key);
    this.repoRoot = realpathSync(options.repoRoot);
    this.directory = resolve(options.directory);
    // Create each missing component, and never follow a symlink into another store.
    const ensure = (path: string): void => {
      let created = false;
      try { mkdirSync(path, { mode: 0o700 }); created = true; }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') { ensure(dirname(path)); mkdirSync(path, { mode: 0o700 }); created = true; }
        else if (code !== 'EEXIST') throw new Error('Checkpoint directory unavailable.');
      }
      if (realpathSync(path) !== path || !assurePrivateStoragePath(path, 'directory',
        created ? 'secure-created' : 'inspect-existing', { anchorPath: dirname(path) }).ok)
        throw new Error('Checkpoint directory unsafe.');
    };
    ensure(this.directory);
    const hash = createHash('sha256').update(JSON.stringify([this.repoRoot, this.key])).digest('hex');
    this.path = join(this.directory, `${hash}.json`);
  }

  private read(): z.infer<typeof envelopeSchema> {
    requireEnabled();
    try { lstatSync(this.path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return { version: 1, key: this.key, repo_root: this.repoRoot, checkpoint: null, events: [] };
      throw new Error('Checkpoint state unreadable.');
    }
    const read = readStableRegularFile(this.path, { anchorPath: this.directory,
      maxFileBytes: MAX_BYTES, remainingBytes: MAX_BYTES });
    if (!read.ok) {
      throw new Error('Checkpoint state unreadable.');
    }
    try {
      const state = envelopeSchema.parse(JSON.parse(read.text));
      if (state.key !== this.key || state.repo_root !== this.repoRoot ||
        new Set(state.events.map(event => event.id)).size !== state.events.length) throw new Error();
      if (state.checkpoint) state.checkpoint = normalizeFields(state.checkpoint,
        state.events.map(event => event.id), state.checkpoint.revision, state.checkpoint.created_at);
      return state;
    } catch { throw new Error('Checkpoint state invalid.'); }
  }

  private write(state: z.infer<typeof envelopeSchema>): void {
    requireEnabled();
    const serialized = JSON.stringify(envelopeSchema.parse(state));
    if (Buffer.byteLength(serialized) > MAX_BYTES) throw new Error('Checkpoint state exceeds byte limit.');
    writePrivateFileAtomically(join(this.directory, `.${randomUUID()}.tmp`), this.path,
      serialized, { anchorPath: this.directory, label: 'Checkpoint state' });
  }

  load(): AgentCheckpoint | null { return this.read().checkpoint; }

  recordToolEvent(toolCallId: string, tool: string, result: string): CheckpointToolEvent {
    const state = this.read();
    const event = eventSchema.parse({ id: randomUUID(), tool_call_id: toolCallId, tool,
      result_sha256: createHash('sha256').update(result).digest('hex'), created_at: new Date().toISOString() });
    state.events.push(event); // Refuse the bound; never silently evict a cited event.
    this.write(state);
    return event;
  }

  save(draft: unknown): AgentCheckpoint {
    const state = this.read();
    const checkpoint = normalizeCheckpoint(draft, state.events.map(event => event.id), (state.checkpoint?.revision ?? 0) + 1);
    state.checkpoint = checkpoint;
    this.write(state);
    return checkpoint;
  }
}

export function defaultCheckpointOptions(key: string): CheckpointOptions {
  return { directory: join(homedir(), '.phantom', 'checkpoints'), key, repoRoot: process.cwd() };
}

/** Bounded, read-only snapshot; Git failure refuses resume rather than reusing stale state. */
export function freshCheckpointRepoState(repoRoot: string): string {
  const git = (args: string[]) => execFileSync('git', ['-c', 'core.fsmonitor=false', ...args], {
    cwd: repoRoot, encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  return JSON.stringify({ head: git(['rev-parse', 'HEAD']), status: git(['status', '--short']),
    diff_stat: git(['diff', '--stat']) });
}
