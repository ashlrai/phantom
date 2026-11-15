/**
 * Tenancy owner, pure (no I/O) so the drive lease store can import it. Every
 * node, job, lease, forum thread and context pack belongs to one owner; an
 * unowned record is legacy/shared and only ever matches another unowned one.
 */
export const OWNER_KINDS = ['person', 'team', 'org'] as const;
export type OwnerKind = typeof OWNER_KINDS[number];
export interface Owner { kind: OwnerKind; id: string }

/** A failure that tells the operator the exact command that fixes it. */
export class TenancyError extends Error {
  constructor(message: string, readonly fix: string) { super(message); this.name = 'TenancyError'; }
}

const OWNER_ID = /^[a-z0-9][a-z0-9._-]{0,99}$/;

export function validOwner(value: unknown): value is Owner {
  if (typeof value !== 'object' || value === null) return false;
  const o = value as Record<string, unknown>;
  return (OWNER_KINDS as readonly unknown[]).includes(o.kind) && typeof o.id === 'string' && OWNER_ID.test(o.id);
}

/** `person:<id>` | `team:<id>` | `org:<id>`, lowercase. */
export function parseOwner(raw: string): Owner {
  const at = raw.indexOf(':');
  const owner = { kind: raw.slice(0, at), id: raw.slice(at + 1) };
  if (at < 0 || !validOwner(owner)) {
    throw new TenancyError(`Invalid owner "${raw}".`, 'Use person:<id>, team:<id> or org:<id> (lowercase letters, digits, ".", "_", "-").');
  }
  return owner;
}

export const ownerKey = (owner: Owner | undefined): string => (owner ? `${owner.kind}:${owner.id}` : '');

/** Records are visible to a principal only inside its scopes; unowned records stay shared. */
export function visibleTo<T extends { owner?: Owner }>(items: readonly T[], scopes: readonly string[]): T[] {
  return items.filter(item => !item.owner || scopes.includes(ownerKey(item.owner)));
}
