# Historical backup fixtures

`backup_v1_schema9` is a committed, byte-stable FaunaVault backup-format-v1
artifact whose SQLite database permanently records migrations 1 through 9.
Tests must treat every file in the directory as immutable and must never rebuild
it from current SQLModel metadata or `LATEST_SCHEMA_VERSION`.

The fixture was generated once with fixed timestamps and deterministic PNG
payloads. It contains one active red-fox photo in a verified taxon album and one
European-tree-frog photo in Trash in a legacy album. The records include
user-edited titles, descriptions, tags, animal display names, original hashes
and sizes, one valid perceptual hash, and one null perceptual hash. It contains
no classification jobs, credentials, diagnostics, or absolute paths.

Any intentional replacement must preserve schema 9, update the v1 manifest
checksums, and receive explicit compatibility review. Ordinary tests copy the
fixture before corruption or migration scenarios.
