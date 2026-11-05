import type { NeedsMasonItem } from './needs-mason-resolve.js';

export type NeedsTriageClass = 'hard-limit' | 'auto';
export type HardLimit = 'secrets' | 'money' | 'outside-send' | 'destroy-data';

// Ordered deliberately: the first matching hard limit wins. Word boundaries
// prevent substrings such as "tokenizer" from becoming credential requests.
const limits: Array<{ limit: HardLimit; pattern: RegExp; reason: string }> = [
  // Credential custody, authentication prompts and local Codex auth.
  { limit: 'secrets', pattern: /\b(secret|token|api[ -]key|password|passphrase|credential|keychain|2fa|otp|private[ -]key|ssh[ -]key|sign[ -]in|log[ -]in)\b|~\/\.codex\b.*\bauth\b/i, reason: 'secrets or authentication' },
  // Financial commitments and changes, including explicit dollar amounts.
  { limit: 'money', pattern: /\b(billing|invoice|payment|pay\s+for|purchase|buy|subscription\s+(?:upgrade|cancel)|(?:upgrade|cancel)\s+(?:the\s+)?subscription|plan\s+change|price)\b|\$\s*\d+(?:[.,]\d+)*\b/i, reason: 'money or billing' },
  // Conservatively retain communication verbs: recipients can be implicit.
  { limit: 'outside-send', pattern: /\b(send|reply|email|text|dm|outreach|comms\.toml|confirmedByMason)\b|\blinkedin\s+(?:post|message)\b|\bpublish\b.*\b(?:person|outside|to)\b/i, reason: 'send to a person outside the team' },
  // Destructive operations and infrastructure changes that can lose access.
  { limit: 'destroy-data', pattern: /\b(delete|wipe|erase|drop\s+(?:table|database)|rm\s+-rf|force[ -]push|remove\s+(?:the\s+)?repo|vercel\s+deletion|dns|nameserver)\b/i, reason: 'destroy data or change DNS' },
];

export function classifyNeedsItem(text: string): { class: NeedsTriageClass; limit?: HardLimit; reason: string } {
  const match = limits.find(({ pattern }) => pattern.test(text));
  return match ? { class: 'hard-limit', limit: match.limit, reason: match.reason }
    : { class: 'auto', reason: 'outside the four hard limits' };
}

export function triageNeedsItems<Item extends NeedsMasonItem>(items: readonly Item[]): {
  auto: Item[]; hardLimit: Array<Item & { limit: HardLimit; reason: string }>;
} {
  const auto: Item[] = [], hardLimit: Array<Item & { limit: HardLimit; reason: string }> = [];
  for (const item of items) {
    const result = classifyNeedsItem(item.text);
    if (result.limit) hardLimit.push({ ...item, limit: result.limit, reason: result.reason });
    else auto.push(item);
  }
  return { auto, hardLimit };
}
