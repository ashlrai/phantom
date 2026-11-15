/** Exact short peer-budget asks; longer requests stay with the Leader. */
export function isPeersAsk(text: string): boolean {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (trimmed.length > 40) return false;
  const ask = trimmed.toLowerCase().replace(/’/g, "'").replace(/[?.!]+$/, '').trim();
  return /^(?:peers|peer budget|peer ledger)$/.test(ask);
}
