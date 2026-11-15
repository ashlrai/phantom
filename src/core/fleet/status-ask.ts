/** Exact, short status requests shared by fleet surfaces. */
export function isStatusAsk(text: string): boolean {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (trimmed.length > 40) return false;
  const ask = trimmed.toLowerCase().replace(/’/g, "'").replace(/[?.!]+$/, '').trim();
  return /^(?:\/status(?:@\w+)?|status|phantom status|fleet status|glance|what(?:'s| is|s) up|what(?:'s| is) happening|what(?:'s| is) running|what(?:'s|s) the status|how(?:'s| is|s) (?:the fleet|it going)|how are (?:we|things))$/.test(ask);
}
