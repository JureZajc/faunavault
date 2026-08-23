export function parseTags(value: string) {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const item of value.split(",")) {
    const tag = item.trim();
    if (tag && !seen.has(tag)) {
      normalized.push(tag);
      seen.add(tag);
    }
  }
  return normalized;
}
