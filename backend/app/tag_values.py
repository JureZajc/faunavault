"""Shared tag normalization. Tags are case-sensitive and whitespace-trimmed."""


def normalize_tags(tags: list[str] | None) -> list[str]:
    if tags is None:
        return []
    normalized: list[str] = []
    seen: set[str] = set()
    for tag in tags:
        value = tag.strip()
        if value and value not in seen:
            normalized.append(value)
            seen.add(value)
    return normalized
