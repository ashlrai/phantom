/**
 * core/fleet/claim-board-ref.ts: the producer contract that binds a
 * coordination-ledger claim to one work-board item without changing the ledger
 * schema. FleetClaim carries only free-text `task`, so the binding lives there:
 * a claim is bound to board item X when its task contains exactly one
 * `[board:X]` token and X satisfies the coordination ID rule. Zero tokens is
 * unbound; two or more `[board:` tokens are ambiguous and therefore unbound; a
 * single malformed token is invalid and unbound. Pure — no I/O.
 */

/** Same rule coordination.ts applies to claim and agent ids. */
const BOARD_ITEM_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
/** Same cap coordination.ts applies to claim task text. */
const TASK_MAX = 1000;
const OPEN = '[board:';

export type BoardRefParse =
  | { itemId: string }
  | { itemId: null; reason: 'none' | 'ambiguous' | 'invalid' };

/** `[board:<id>]`, or null when the id breaks the coordination ID rule. */
export function formatBoardRef(itemId: string): string | null {
  return typeof itemId === 'string' && BOARD_ITEM_ID.test(itemId) ? `${OPEN}${itemId}]` : null;
}

/** Task text with ` [board:<id>]` appended; null when the id is invalid, the
 * task already carries any board token (a second one would make it
 * ambiguous), or the result would exceed the ledger's task cap. */
export function withBoardRef(task: string, itemId: string): string | null {
  const ref = formatBoardRef(itemId);
  if (ref === null || typeof task !== 'string' || task.includes(OPEN)) return null;
  const trimmed = task.trim();
  const result = trimmed.length === 0 ? ref : `${trimmed} ${ref}`;
  return result.length <= TASK_MAX ? result : null;
}

/** Every `[board:` opener counts toward ambiguity, well-formed or not, so a
 * malformed second token can never be ignored in favour of the first. */
export function parseBoardRef(task: string): BoardRefParse {
  if (typeof task !== 'string') return { itemId: null, reason: 'none' };
  const first = task.indexOf(OPEN);
  if (first === -1) return { itemId: null, reason: 'none' };
  if (task.indexOf(OPEN, first + OPEN.length) !== -1) return { itemId: null, reason: 'ambiguous' };
  const close = task.indexOf(']', first + OPEN.length);
  const id = close === -1 ? '' : task.slice(first + OPEN.length, close);
  return BOARD_ITEM_ID.test(id) ? { itemId: id } : { itemId: null, reason: 'invalid' };
}
