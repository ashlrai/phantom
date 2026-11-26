export function ownerDisplayName(value: unknown): string {
  if (typeof value !== 'string') return 'the owner';
  const name = value.trim();
  return name && name.length <= 120 && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(name) ? name : 'the owner';
}
