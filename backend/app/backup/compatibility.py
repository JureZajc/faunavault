from __future__ import annotations

# Recovery support is intentionally explicit and independent from the current
# application schema. Add a version only after its verifier and migration
# rehearsal have dedicated compatibility coverage.
SUPPORTED_BACKUP_SCHEMA_VERSIONS: frozenset[int] = frozenset({9})
