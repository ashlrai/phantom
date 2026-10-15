/**
 * "1 slot", "2 slots", "1 local slot" — a count with its noun pluralised by
 * the count, so operator-facing reasons never read "2 slot(s)". `noun` is the
 * singular and may carry leading words ("local slot"); only its last word gets
 * the "s".
 *
 * WHY a leaf util: the fleet router, the local-fleet ceiling and the fabric
 * resource monitor all phrase runtime slot counts, and the latter two must not
 * import the router (a heavy module) just for this. One helper keeps the
 * wording identical everywhere.
 */
export function countOf(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}
