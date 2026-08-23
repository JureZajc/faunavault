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

## HEIC compatibility fixture

`heic/reference.heic` is a 1,257-byte synthetic compatibility image encoded
once with the reference `heif-enc` CLI from libheif 1.17.6 (Ubuntu 24.04 package
`1.17.6-1ubuntu4`, x265 3.5). It contains one 29x100 8-bit RGB primary image and
no personal subject or EXIF metadata. The exact command was:

```text
heif-enc -q 90 RGB_8__29x100.png -o reference.heic
```

The source pattern is pillow-heif's synthetic
`tests/images/non_heif/RGB_8__29x100.png` at upstream commit
`16c3dd8249f56fa07ab4f1350bd73e7a20b95bb1` (v1.5.0). Its SHA-256 is
`18a587024b1a99ff05006eff4df6aceddf4f55ebe7ef2fc8f731828706727904`.
The pattern and derived fixture are redistributed under that repository's
BSD-3-Clause license. The committed HEIC SHA-256 is
`95138399b63bbda5cb9d08397b8c8c648031cfb8a9a308c2b5f260c4f946c121`.
This external CLI provenance keeps the compatibility check independent of
pillow-heif's encoder API.
