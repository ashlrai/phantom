/** Exact short bridge asks; ownership questions retain their owners routing. */
export function isBridgeAsk(text: string): boolean {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (trimmed.length > 40) return false;
  const ask = trimmed.toLowerCase().replace(/’/g, "'").replace(/[?.!]+$/, '').trim();
  return /^(?:bridge|bridge check|bridge status|can you reach the runtime|runtime reachable)$/.test(ask);
}
