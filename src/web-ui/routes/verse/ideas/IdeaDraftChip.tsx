/**
 * routes/verse/ideas/IdeaDraftChip.tsx: the "Draft job" call and its result
 * chip. The server (`POST /api/ideas/draft`) writes the draft through the drop
 * job writer and checks queued collisions first; a draft that collides is held
 * until the caller confirms. Every string shown is untrusted and rendered as text.
 */
import { getMutationToken, touchMutationHold } from '../../../data/auth-store.js';
import { apiPost } from '../../../data/client.js';
import styles from './ideas.module.css';

export interface IdeaDraftCollision { path: string; queued: string[] }
export interface IdeaDraftResult {
  draftId: string;
  collisions: IdeaDraftCollision[];
  written: boolean;
  existing: boolean;
}

export async function postIdeasDraft(ideaIds: readonly string[], confirmCollisions = false): Promise<IdeaDraftResult> {
  const token = getMutationToken();
  if (!token) throw new Error('Unlock actions with the mutation token before drafting.');
  const result = await apiPost<IdeaDraftResult>('/api/ideas/draft', { ideaIds, ...(confirmCollisions ? { confirmCollisions: true } : {}) }, token);
  touchMutationHold();
  return result;
}

export type IdeaDraftState = { error: string } | IdeaDraftResult;

export function IdeaDraftChip({ state, onConfirm }: { state: IdeaDraftState; onConfirm: () => void }) {
  if ('error' in state) return <span className={styles.chipBad} role="alert">{state.error}</span>;
  const held = !state.written && !state.existing;
  const collisions = state.collisions.map(c => `${c.path} (queued: ${c.queued.join(', ')})`).join('; ');
  return (
    <span className={styles.chip} data-testid="idea-draft-chip">
      <code>{state.draftId}</code>
      {' · '}
      {state.collisions.length === 0 ? 'no collisions' : <span className={styles.chipBad}>Collides: {collisions}</span>}
      {' · '}
      {held ? 'not queued yet' : state.existing ? 'already drafted' : 'queued'}
      {held ? <button type="button" className={styles.toggle} onClick={onConfirm}>Draft anyway</button> : null}
    </span>
  );
}
